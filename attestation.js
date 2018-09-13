/*jslint node: true */
'use strict';
const crypto = require('crypto');
const moment = require('moment');
const constants = require('byteballcore/constants.js');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus.js');
const texts = require('./modules/texts.js');
const db_migrations = require('./db_migrations.js');
const validationUtils = require('byteballcore/validation_utils');
const notifications = require('./modules/notifications');
const conversion = require('./modules/conversion.js');
const jumioApi = require('./modules/jumio_api.js');
const jumio = require('./modules/jumio.js');
const realNameAttestation = require('./modules/real_name_attestation.js');
const reward = require('./modules/reward.js');
const contract = require('./modules/contract.js');
const discounts = require('./modules/discounts.js');
const voucher = require('./modules/voucher.js');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const server = require('http').Server(app);
const maxmind = require('maxmind');
const async_module = require('async');
const mutex = require('byteballcore/mutex.js');

const PRICE_TIMEOUT = 3*24*3600; // in seconds

let countryLookup = maxmind.openSync('../GeoLite2-Country.mmdb');

let assocAskedForDonation = {};

function readUserInfo(device_address, cb) {
	db.query("SELECT user_address FROM users WHERE device_address = ?", [device_address], rows => {
		if (rows.length)
			cb(rows[0]);
		else {
			db.query("INSERT "+db.getIgnore()+" INTO users (device_address) VALUES(?)", [device_address], () => {
				cb({
					device_address: device_address,
					user_address: null
				});
			});
		}
	});
}

function readOrAssignReceivingAddress(device_address, user_address, cb){
	mutex.lock([device_address], unlock => {
		db.query(
			"SELECT receiving_address, post_publicly, "+db.getUnixTimestamp('last_price_date')+" AS price_ts \n\
			FROM receiving_addresses WHERE device_address=? AND user_address=?", 
			[device_address, user_address], 
			rows => {
				if (rows.length > 0){
					let row = rows[0];
				//	if (row.price_ts < Date.now()/1000 - 3600)
				//		row.post_publicly = null;
					cb(row.receiving_address, row.post_publicly);
					return unlock();
				}
				const headlessWallet = require('headless-byteball');
				headlessWallet.issueNextMainAddress(receiving_address => {
					db.query(
						"INSERT INTO receiving_addresses (device_address, user_address, receiving_address) VALUES(?,?,?)",
						[device_address, user_address, receiving_address],
						() => {
							cb(receiving_address, null);
							unlock();
						}
					);
				});
			}
		);
	});
}

function updatePrice(receiving_address, price, cb){
	db.query("UPDATE receiving_addresses SET price=?, last_price_date="+db.getNow()+" WHERE receiving_address=?", [price, receiving_address], () => {
		if (cb)
			cb();
	});
}

function moveFundsToAttestorAddresses(){
	let network = require('byteballcore/network.js');
	if (network.isCatchingUp())
		return;
	console.log('moveFundsToAttestorAddresses');
	db.query(
		"SELECT DISTINCT receiving_address \n\
		FROM receiving_addresses CROSS JOIN outputs ON receiving_address=address JOIN units USING(unit) \n\
		WHERE is_stable=1 AND is_spent=0 AND asset IS NULL \n\
		LIMIT ?",
		[constants.MAX_AUTHORS_PER_UNIT],
		rows => {
			if (rows.length === 0)
				return;
			let arrAddresses = rows.map(row => row.receiving_address);
			let headlessWallet = require('headless-byteball');
			headlessWallet.sendMultiPayment({
				asset: null,
				to_address: realNameAttestation.assocAttestorAddresses[Date.now()%2 ? 'real name' : 'nonus'],
				send_all: true,
				paying_addresses: arrAddresses
			}, (err, unit) => {
				if (err)
					console.log("failed to move funds: "+err);
				else
					console.log("moved funds, unit "+unit);
			});
		}
	);
}

//app.use(express.static(__dirname + '/public'));
app.use(bodyParser.urlencoded({ extended: false })); 

app.post('*/cb', function(req, res) {
	let body = req.body;
	console.error('received callback', body);
	if (!body.jumioIdScanReference){
		notifications.notifyAdmin("cb without jumioIdScanReference", JSON.stringify(body));
		return res.send(JSON.stringify({result: 'error', error: "no jumioIdScanReference"}));
	}
	db.query(
		"SELECT transaction_id, scan_result FROM transactions WHERE jumioIdScanReference=?", 
		[body.jumioIdScanReference], 
		rows => {
			if (rows.length === 0){
				notifications.notifyAdmin("cb jumioIdScanReference not found", JSON.stringify(body));
				return res.send(JSON.stringify({result: 'error', error: "jumioIdScanReference not found"}));
			}
			let row = rows[0];
			if (row.scan_result !== null){
				notifications.notifyAdmin("duplicate cb", JSON.stringify(body));
				return res.send(JSON.stringify({result: 'error', error: "duplicate cb"}));
			}
			handleJumioData(row.transaction_id, body);
			res.send('ok');
		}
	);
});

function getCountryByIp(ip){
	let countryInfo = countryLookup.get(ip);
	if (!countryInfo || !countryInfo.country){
		console.log('failed to determine country of IP '+ip);
		return 'UNKNOWN';
	}
	let ipCountry = countryInfo.country.iso_code;
	console.log('country by IP: '+ipCountry);
	if (!ipCountry){
		console.log('no country of IP '+ip);
		return 'UNKNOWN';
	}
	return ipCountry;
}

function handleJumioData(transaction_id, body){
	let device = require('byteballcore/device.js');
	let data = body.transaction ? jumioApi.convertRestResponseToCallbackFormat(body) : body;
	if (typeof data.identityVerification === 'string') // contrary to docs, it is a string, not an object
		data.identityVerification = JSON.parse(data.identityVerification);
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let error = scan_result ? '' : data.verificationStatus;
	let bHasLatNames = (scan_result && data.idFirstName && data.idLastName && data.idFirstName !== 'N/A' && data.idLastName !== 'N/A');
	if (bHasLatNames && data.idCountry === 'RUS' && data.idType === 'ID_CARD') // Russian internal passport
		bHasLatNames = false;
	if (scan_result && !bHasLatNames){
		scan_result = 0;
		error = "couldn't extract your name.  Please [try again](command:again) and provide a document with your name printed in Latin characters.";
	}
	if (scan_result && !data.identityVerification){
		console.error("no identityVerification in tx "+transaction_id);
		return;
	}
	if (scan_result && !data.identityVerification.validity){ // selfie check and selfie match
		scan_result = 0;
		error = data.identityVerification.reason;
	}
	mutex.lock(['tx-'+transaction_id], unlock => {
		db.query(
			"UPDATE transactions SET scan_result=?, result_date="+db.getNow()+", extracted_data=? \n\
			WHERE transaction_id=? AND scan_result IS NULL", 
			[scan_result, JSON.stringify(body), transaction_id]);
		db.query(
			"SELECT user_address, device_address, post_publicly, payment_unit, voucher_id \n\
			FROM transactions CROSS JOIN receiving_addresses USING(receiving_address) WHERE transaction_id=?", 
			[transaction_id],
			rows => {
				let row = rows[0];
				if (scan_result === 0){
					device.sendMessageToDevice(row.device_address, 'text', "Verification failed: "+error+"\n\nTry [again](command:again)?");
					return unlock();
				}
				let bNonUS = (data.idCountry !== 'USA');
				if (bNonUS){
					let ipCountry = getCountryByIp(data.clientIp);
					if (ipCountry === 'US' || ipCountry === 'UNKNOWN')
						bNonUS = false;
				}
				db.query("INSERT "+db.getIgnore()+" INTO attestation_units (transaction_id, attestation_type) VALUES (?, 'real name')", [transaction_id], async () => {
					row.post_publicly = 0; // override user choice
					let [attestation, src_profile] = realNameAttestation.getAttestationPayloadAndSrcProfile(row.user_address, data, row.post_publicly);
					if (!row.post_publicly)
						realNameAttestation.postAndWriteAttestation(transaction_id, 'real name', realNameAttestation.assocAttestorAddresses['real name'], attestation, src_profile);
					setTimeout(() => {
						if (bNonUS){
							device.sendMessageToDevice(row.device_address, 'text', texts.attestNonUS());
							setTimeout(() => {
								if (assocAskedForDonation[row.device_address])
									return;
								device.sendMessageToDevice(row.device_address, 'text', texts.pleaseDonate());
								assocAskedForDonation[row.device_address] = Date.now();
							}, 6000);
						}
						else
							device.sendMessageToDevice(row.device_address, 'text', texts.pleaseDonate());
					}, 2000);
					if (conf.rewardInUSD || conf.contractRewardInUSD){
						let voucherInfo = null;
						if (row.voucher_id) {
							voucherInfo = await voucher.getInfoById(row.voucher_id);
						}
						let rewardInBytes = voucherInfo ? 0 : conversion.getPriceInBytes(conf.rewardInUSD);
						let contractRewardInBytes = conversion.getPriceInBytes(conf.contractRewardInUSD);
						db.query(
							"INSERT "+db.getIgnore()+" INTO reward_units (transaction_id, device_address, user_address, user_id, reward, contract_reward) VALUES (?, ?,?,?, ?,?)", 
							[transaction_id, row.device_address, row.user_address, attestation.profile.user_id, rewardInBytes, contractRewardInBytes], 
							async (res) => {
								console.log("reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
								if (!res.affectedRows){
									console.log("duplicate user_address or user_id or device address: "+row.user_address+", "+attestation.profile.user_id+", "+row.device_address);
									return unlock();
								}
								let [contract_address, vesting_ts] = await contract.createContract(row.user_address, row.device_address);
								let message = `You were attested for the first time`;
								if (rewardInBytes > 0)
									message += ` and will receive a welcome bonus of $${conf.rewardInUSD.toLocaleString([], {minimumFractionDigits: 2})} (${(rewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB) from Byteball distribution fund.`;
								if (conf.contractRewardInUSD)
									message += "  You will also receive a reward of $"+conf.contractRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(contractRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) that will be locked on a smart contract for "+conf.contractTerm+" year and can be spent only after "+new Date(vesting_ts).toDateString()+".";
								device.sendMessageToDevice(row.device_address, 'text', message);
								reward.sendAndWriteReward('attestation', transaction_id);
								if (conf.referralRewardInUSD || conf.contractReferralRewardInUSD){
									let referralRewardInBytes = conversion.getPriceInBytes(conf.referralRewardInUSD);
									let contractReferralRewardInBytes = conversion.getPriceInBytes(conf.contractReferralRewardInUSD);
									if (row.payment_unit) {
										reward.findReferrer(row.payment_unit, async (referring_user_id, referring_user_address, referring_user_device_address) => {
											if (!referring_user_address){
												console.log("no referring user for "+row.user_address);
												return unlock();
											}
											let [referrer_contract_address, referrer_vesting_date_ts] = 
												await contract.getReferrerContract(referring_user_address, referring_user_device_address);
											db.query(
												"INSERT "+db.getIgnore()+" INTO referral_reward_units \n\
												(transaction_id, user_address, user_id, new_user_address, new_user_id, reward, contract_reward) VALUES (?, ?,?, ?,?, ?,?)", 
												[transaction_id, 
												referring_user_address, referring_user_id, 
												row.user_address, attestation.profile.user_id, 
												referralRewardInBytes, contractReferralRewardInBytes], 
												(res) => {
													console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
													if (!res.affectedRows){
														notifications.notifyAdmin("duplicate referral reward", "referral reward for new user "+row.user_address+" "+attestation.profile.user_id+" already written");
														return unlock();
													}
													let reward_text = referralRewardInBytes
														? "and you will receive a reward of $"+conf.referralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(referralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund"
														: "and you will receive a reward of $"+conf.contractReferralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(contractReferralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund.  The reward will be paid to a smart contract which can be spent after "+new Date(referrer_vesting_date_ts).toDateString();
													device.sendMessageToDevice(referring_user_device_address, 'text', "You referred a user who has just verified his identity "+reward_text+".  Thank you for bringing in a new byteballer, the value of the ecosystem grows with each new user!");
													reward.sendAndWriteReward('referral', transaction_id);
													unlock();
												}
											);
										});
									} else if (voucherInfo) {
										db.query(
											`SELECT payload FROM messages
											JOIN attestations USING (unit, message_index)
											WHERE address=? AND attestor_address=?`,
											[voucherInfo.user_address, realNameAttestation.assocAttestorAddresses['real name']],
											function(rows) {
												if (!rows.length) {
													console.log(`no attestation for voucher user_address ${voucherInfo.user_address}`);
													return unlock();
												}
												let row = rows[0];
												let payload = JSON.parse(row.payload);
												let user_id = payload.profile.user_id;
												if (!user_id)
													throw Error(`no user_id for user_address ${voucherInfo.user_address}`);
												db.query(
													`INSERT ${db.getIgnore()} INTO referral_reward_units
													(transaction_id, user_address, user_id, new_user_address, new_user_id, reward)
													VALUES (?, ?, ?, ?, ?, ?)`
													[transaction_id, voucherInfo.user_address, user_id, row.user_address, attestation.profile.user_id, referralRewardInBytes+contractReferralRewardInBytes],
													(res) => {
														console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
														device.sendMessageToDevice(voucherInfo.device_address, 'text', `A user just verified his identity using your voucher ${voucherInfo.voucher} and you will receive a reward of ${(conf.referralRewardInUSD+conf.contractReferralRewardInUSD).toLocaleString([], {minimumFractionDigits: 2})} (${((referralRewardInBytes+contractReferralRewardInBytes)/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB).  Thank you for bringing in a new byteballer, the value of the ecosystem grows with each new user!`);
														reward.sendAndWriteReward('voucher', transaction_id);
														unlock();
													}
												);
											}
										);
									}
								}
							}
						);
					}
				});
			}
		);
	});
}


async function getPriceInUSD(user_address){
	let objDiscount = await discounts.getDiscount(user_address);
	let priceInUSD = conf.priceInUSD * (1-objDiscount.discount/100);
	priceInUSD = Math.round(priceInUSD*100)/100;
	objDiscount.priceInUSD = priceInUSD;
	return objDiscount;
}

function respond(from_address, text, response){
	let device = require('byteballcore/device.js');
	readUserInfo(from_address, async (userInfo) => {
		
		function checkUserAddress(onDone){
			if (validationUtils.isValidAddress(text)){
				userInfo.user_address = text;
				response += "Thanks, going to attest your address "+userInfo.user_address+".  ";
				db.query("UPDATE users SET user_address=? WHERE device_address=?", [userInfo.user_address, from_address], () => {
					onDone()
				});
				return;
			}
			if (userInfo.user_address)
				return onDone();
			onDone(texts.insertMyAddress());
		}
		
		if (text === 'req')
			return device.sendMessageToDevice(from_address, 'text', "test req [req](profile-request:first_name,last_name,country)");
		if (text === 'testsign')
			return device.sendMessageToDevice(from_address, 'text', "test sig [s](sign-message-request:Testing signed messages)");
		if (text === 'new voucher') {
			let [voucher_code, receiving_address] = await voucher.issueNew(userInfo.user_address, from_address);
			device.sendMessageToDevice(from_address, 'text', `New voucher: ${voucher_code}`);
			return device.sendMessageToDevice(from_address, 'text', texts.depositVoucher(voucher_code));
		}
		if (text === 'vouchers') {
			let vouchers = await voucher.getAllUserVouchers(userInfo.user_address);
			return device.sendMessageToDevice(from_address, 'text', texts.listVouchers(userInfo.user_address, vouchers));
		}
		if (text.startsWith('deposit')) {
			let tokens = text.split(" ");
			if (tokens.length != 3)
				return device.sendMessageToDevice(from_address, 'text', texts.depositVoucher());
			let voucher_code = tokens[1];
			let usd_price = tokens[2];
			let price = conversion.getPriceInBytes(usd_price);
			let voucherInfo = await voucher.getInfo(voucher_code);
			if (!voucherInfo)
				return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
			return device.sendMessageToDevice(from_address, 'text', texts.payToVoucher(voucherInfo.receiving_address, voucher_code, price, userInfo.user_address));
		}
		if (text.startsWith('limit')) { // voucher
			let tokens = text.split(" ");
			if (tokens.length != 3)
				return device.sendMessageToDevice(from_address, 'text', texts.limitVoucher());
			let voucher_code = tokens[1];
			let limit = tokens[2]|0;
			let voucherInfo = await voucher.getInfo(voucher_code);
			if (!voucherInfo)
				return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
			if (limit < 1)
				return device.sendMessageToDevice(from_address, 'text', `invalid limit: ${limit}, should be > 0`);
			if (from_address != voucherInfo.device_address)
				return device.sendMessageToDevice(from_address, 'text', `its not your voucher!`);
			await voucher.setLimit(voucherInfo.voucher_id, limit);
			return device.sendMessageToDevice(from_address, 'text', `new limit ${limit} for voucher ${voucher_code}`);
		}
		if (text.startsWith('withdraw')) {
			let tokens = text.split(" ");
			if (tokens.length != 3)
				return device.sendMessageToDevice(from_address, 'text', texts.withdrawVoucher());
			let voucher_code = tokens[1];
			let gb_price = tokens[2];
			let price = gb_price * 1e9;
			mutex.lock(['voucher-'+voucher_code], async (unlock) => {
				let voucherInfo = await voucher.getInfo(voucher_code);
				if (!voucherInfo) {
					unlock();
					return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${voucher_code}`);
				}
				if (price > voucherInfo.amount) {
					unlock();
					return device.sendMessageToDevice(from_address, 'text', `not enough funds on voucher ${voucher_code} for withdrawal (tried to claim ${price} bytes, but voucher only has ${voucherInfo.amount} bytes`);
				}
				let [err, bytes, contract_bytes] = await voucher.withdraw(voucherInfo, price);
				if (!err)
					device.sendMessageToDevice(from_address, 'text', texts.withdrawComplete(bytes, contract_bytes, await voucher.getInfo(voucher_code)));
				else
					device.sendMessageToDevice(from_address, 'text', err);
				unlock();
			});
			return;
		}
		if (text.length == 13) { // voucher
			if (!userInfo.user_address)
				return device.sendMessageToDevice(from_address, 'text', texts.insertMyAddress());
			readOrAssignReceivingAddress(from_address, userInfo.user_address, (receiving_address, post_publicly) => {
				db.query(
					"SELECT scan_result, attestation_date, transaction_id, extracted_data, user_address \n\
					FROM transactions JOIN receiving_addresses USING(receiving_address) LEFT JOIN attestation_units USING(transaction_id) \n\
					WHERE receiving_address=? ORDER BY transaction_id DESC LIMIT 1", 
					[receiving_address], 
					async (rows) => {
						if (!rows.length) { // not yet attested
							mutex.lock(['voucher-'+text], async (unlock) => {
								let voucherInfo = await voucher.getInfo(text);
								if (!voucherInfo) {
									unlock();
									return device.sendMessageToDevice(from_address, 'text', `invalid voucher: ${text}`);
								}
								let price = conversion.getPriceInBytes(conf.priceInUSD);
								if (voucherInfo.amount < price) {
									unlock();
									device.sendMessageToDevice(voucherInfo.device_address, 'text', `Someone tried to attest using your voucher ${text}, but it does not have enough funds. ` + texts.depositVoucher(text));
									return device.sendMessageToDevice(from_address, 'text', `voucher ${text} does not have enough funds, we notified the owner of this voucher.`);
								}
								// voucher limit
								db.query(`SELECT COUNT(1) AS count FROM transactions
									JOIN receiving_addresses USING(receiving_address)
									WHERE voucher_id=? AND device_address=?`,
									[voucherInfo.voucher_id, from_address],
									function(rows){
										var count = rows[0].count;
										if (rows[0].count >= voucherInfo.usage_limit) {
											unlock();
											return device.sendMessageToDevice(from_address, 'text', `you reached the limit of uses for voucher ${text}`);
										}

										db.takeConnectionFromPool(function(connection) {
											let arrQueries = [];
											connection.addQuery(arrQueries, `BEGIN TRANSACTION`);
											connection.addQuery(arrQueries,
												`INSERT INTO transactions (receiving_address, voucher_id, price, received_amount) VALUES (?, ?, 0, 0)`, 
												[receiving_address, voucherInfo.voucher_id]);
											connection.addQuery(arrQueries,
												`INSERT INTO voucher_transactions (voucher_id, transaction_id, amount) VALUES (?, last_insert_rowid(), ?)`,
												[voucherInfo.voucher_id, price]);
											connection.addQuery(arrQueries, `UPDATE vouchers SET amount=amount-? WHERE voucher_id=?`,
												[price, voucherInfo.voucher_id]);
											connection.addQuery(arrQueries, `COMMIT`);
											async_module.series(arrQueries, function(){
												connection.query(`SELECT transaction_id FROM transactions ORDER BY transaction_id DESC LIMIT 1`, [], function(rows){
													connection.release();
													unlock();
													jumio.initAndWriteScan(rows[0].transaction_id, from_address, userInfo.user_address);
												})
											});
										});
									}
								);
							});
						}
					}
				);
			});
			return;
		}
		let arrSignedMessageMatches = text.match(/\(signed-message:(.+?)\)/);
		if (arrSignedMessageMatches){
			let signedMessageBase64 = arrSignedMessageMatches[1];
			var validation = require('byteballcore/validation.js');
			var signedMessageJson = Buffer(signedMessageBase64, 'base64').toString('utf8');
			console.error(signedMessageJson);
			try{
				var objSignedMessage = JSON.parse(signedMessageJson);
			}
			catch(e){
				return null;
			}
			validation.validateSignedMessage(objSignedMessage, err => {
				device.sendMessageToDevice(from_address, 'text', err || 'ok');
			});
			return;
		}
		
		checkUserAddress(user_address_response => {
			if (user_address_response)
				return device.sendMessageToDevice(from_address, 'text', response + user_address_response);
			readOrAssignReceivingAddress(from_address, userInfo.user_address, async (receiving_address, post_publicly) => {
				let objDiscountedPriceInUSD = await getPriceInUSD(userInfo.user_address);
				let price = conversion.getPriceInBytes(objDiscountedPriceInUSD.priceInUSD);
				updatePrice(receiving_address, price);
				if (text === 'private' || text === 'public'){
					post_publicly = (text === 'public') ? 1 : 0;
					db.query("UPDATE receiving_addresses SET post_publicly=? WHERE device_address=? AND user_address=?", 
						[post_publicly, from_address, userInfo.user_address]);
					if (text === "private")
						response += "Your personal data will be kept private and stored in your wallet.\n\n";
					else
						response += "Your personal data will be posted into the public database and will be available for everyone.  The data includes your first name, last name, date of birth, and the number of your government issued ID document.  Click [pivate](command:private) now if you changed your mind.\n\n";
				}
				if (post_publicly === null)
					return device.sendMessageToDevice(from_address, 'text', response + texts.privateOrPublic());
				if (text === 'again')
					return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, userInfo.user_address, post_publicly, objDiscountedPriceInUSD));
				db.query(
					"SELECT scan_result, attestation_date, transaction_id, extracted_data, user_address \n\
					FROM transactions JOIN receiving_addresses USING(receiving_address) LEFT JOIN attestation_units USING(transaction_id) \n\
					WHERE receiving_address=? ORDER BY transaction_id DESC LIMIT 1", 
					[receiving_address], 
					rows => {
						if (rows.length === 0)
							return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, userInfo.user_address, post_publicly, objDiscountedPriceInUSD));
						let row = rows[0];
						let scan_result = row.scan_result;
						if (scan_result === null)
							return device.sendMessageToDevice(from_address, 'text', response + texts.underWay());
						if (scan_result === 0)
							return device.sendMessageToDevice(from_address, 'text', response + texts.previousAttestationFaled());
						// scan_result === 1
						if (text === 'attest non-US'){
							db.query(
								"SELECT attestation_unit FROM attestation_units WHERE transaction_id=? AND attestation_type='nonus'", 
								[row.transaction_id],
								nonus_rows => {
									if (nonus_rows.length > 0){ // already exists
										let attestation_unit = nonus_rows[0].attestation_unit;
										return device.sendMessageToDevice(from_address, 'text', 
											response + ( attestation_unit ? texts.alreadyAttestedInUnit(attestation_unit) : texts.underWay() ) );
									}
									let data = JSON.parse(row.extracted_data);
									let cb_data = data.transaction ? jumioApi.convertRestResponseToCallbackFormat(data) : data;
									if (cb_data.idCountry === 'USA')
										return device.sendMessageToDevice(from_address, 'text', response + "You are an US citizen, can't attest non-US");
									db.query("INSERT INTO attestation_units (transaction_id, attestation_type) VALUES (?,'nonus')", [row.transaction_id], ()=>{
										let nonus_attestation = realNameAttestation.getNonUSAttestationPayload(row.user_address);
										realNameAttestation.postAndWriteAttestation(row.transaction_id, 'nonus', realNameAttestation.assocAttestorAddresses['nonus'], nonus_attestation);
										setTimeout(() => {
											if (assocAskedForDonation[from_address])
												return;
											device.sendMessageToDevice(from_address, 'text', texts.pleaseDonate());
											assocAskedForDonation[from_address] = Date.now();
										}, 2000);
									});
								}
							);
						}
						else if (text === 'donate yes'){
							db.query("UPDATE reward_units SET donated=1 WHERE transaction_id=?", [row.transaction_id]);
							device.sendMessageToDevice(from_address, 'text', "Thanks for your donation!");
						}
						else if (text === 'donate no'){
							db.query("UPDATE reward_units SET donated=0 WHERE transaction_id=? AND donated IS NULL", [row.transaction_id]);
							device.sendMessageToDevice(from_address, 'text', "Thanks for your choice.");
						}
						else
							device.sendMessageToDevice(from_address, 'text', response + texts.alreadyAttested(row.attestation_date));
					}
				);
			});
		});
	});
}

eventBus.on('paired', from_address => {
	respond(from_address, '', texts.greeting() + "\n\n");
});

eventBus.once('headless_and_rates_ready', () => {
	const headlessWallet = require('headless-byteball');
	if (conf.bRunWitness){
		require('byteball-witness');
		eventBus.emit('headless_wallet_ready');
	}
	else
		headlessWallet.setupChatEventHandlers();
	eventBus.on('text', (from_address, text) => {
		respond(from_address, text.trim(), '');
	});
	
	eventBus.on('new_my_transactions', arrUnits => {
		let device = require('byteballcore/device.js');
		db.query(
			`SELECT amount, asset, device_address, receiving_address, user_address, unit, price, ${db.getUnixTimestamp('last_price_date')} AS price_ts
			FROM outputs
			CROSS JOIN receiving_addresses ON outputs.address=receiving_addresses.receiving_address
			WHERE unit IN(?) AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit)
			UNION -- vouchers deposit / reward
			SELECT outputs.amount, asset, device_address, receiving_address, user_address, unit, 0 AS price, CURRENT_TIMESTAMP AS price_ts
			FROM outputs
			CROSS JOIN vouchers ON outputs.address=vouchers.receiving_address
			WHERE unit IN(?) AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit)`,
			[arrUnits, arrUnits],
			rows => {
				rows.forEach(row => {
			
					async function checkPayment(onDone){
						if (row.asset !== null)
							return onDone("Received payment in wrong asset", delay);
						if (row.price > 0) {// not voucher
							let delay = Math.round(Date.now()/1000 - row.price_ts);
							let bLate = (delay > PRICE_TIMEOUT);
							let objDiscountedPriceInUSD = await getPriceInUSD(row.user_address);
							let current_price = conversion.getPriceInBytes(objDiscountedPriceInUSD.priceInUSD);
							let expected_amount = bLate ? current_price : row.price;
							if (row.amount < expected_amount){
								updatePrice(row.device_address, current_price);
								let text = "Received "+(row.amount/1e9)+" GB from you";
								text += bLate 
									? ".  Your payment is too late and less than the current price.  " 
									: ", which is less than the expected "+(row.price/1e9)+" GB.  ";
								return onDone(text + texts.pleasePay(row.receiving_address, current_price, row.user_address, objDiscountedPriceInUSD), delay);
							}
						}
						db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], author_rows => {
							if (author_rows.length !== 1){
								resetUserAddress();
								return onDone("Received a payment but looks like it was not sent from a single-address wallet.  "+texts.switchToSingleAddress());
							}
							if (row.price > 0 && author_rows[0].address !== row.user_address){ // only for non-vouchers
								resetUserAddress();
								return onDone("Received a payment but it was not sent from the expected address "+row.user_address+".  "+texts.switchToSingleAddress());
							}
							onDone();
						});
					}
		
					function resetUserAddress(){
						db.query("UPDATE users SET user_address=NULL WHERE device_address=?", [row.device_address]);
					}
		
					checkPayment((error, delay) => {
						if (error){
							return db.query(
								"INSERT "+db.getIgnore()+" INTO rejected_payments (receiving_address, price, received_amount, delay, payment_unit, error) \n\
								VALUES (?,?, ?,?, ?,?)", 
								[row.receiving_address, row.price, row.amount, delay, row.unit, error],
								() => {
									device.sendMessageToDevice(row.device_address, 'text', error);
								}
							);
						}
						if (row.price > 0)
							db.query(
								"INSERT INTO transactions (receiving_address, price, received_amount, payment_unit) VALUES (?,?, ?,?)", 
								[row.receiving_address, row.price, row.amount, row.unit]
							);
						else
							db.query(
								`INSERT INTO voucher_transactions (voucher_id, amount, unit)
								SELECT voucher_id, ?, ? FROM vouchers WHERE receiving_address=?`, 
								[row.amount, row.unit, row.receiving_address]
							);
						device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB, waiting for confirmation.  It should take 5-10 minutes.");
					});
				});
			}
		);
	});
	
	eventBus.on('my_transactions_became_stable', arrUnits => {
		let device = require('byteballcore/device.js');
		db.query( // transactions
			`SELECT transaction_id, device_address, user_address
			FROM transactions JOIN receiving_addresses USING(receiving_address)
			WHERE payment_unit IN(?)`,
			[arrUnits],
			rows => {
				rows.forEach(row => {
					db.query("UPDATE transactions SET confirmation_date="+db.getNow()+", is_confirmed=1 WHERE transaction_id=?", [row.transaction_id]);
					device.sendMessageToDevice(row.device_address, 'text', "Your payment is confirmed, redirecting to Jumio...");
					jumio.initAndWriteScan(row.transaction_id, row.device_address, row.user_address);
				});
			}
		);
		db.query( // deposit vouchers
			`SELECT voucher_id, device_address, outputs.amount, (SELECT 1 FROM inputs WHERE address=? AND unit = IN (?) LIMIT 1) AS from_distribution
			FROM vouchers
			JOIN outputs ON outputs.address=vouchers.receiving_address
			WHERE outputs.unit IN (?) AND outputs.asset IS NULL`,
			[reward.distribution_address, arrUnits, arrUnits],
			rows => {
				rows.forEach(row => {
					let deposited = !row.from_distribution ? "amount_deposited=amount_deposited+?" : "amount=amount+?"; // amount just to consume 2nd parameter passed to query
					db.query(`UPDATE vouchers SET amount=amount+?, ${deposited} WHERE voucher_id=?`, [row.amount, row.amount, row.voucher_id]);
					if (!row.from_distribution)
						device.sendMessageToDevice(row.device_address, 'text', `Your payment is confirmed`);
				});
			}
		);
	});
});


function pollAndHandleJumioScanData(){
	jumio.pollJumioScanData(handleJumioData);
}

eventBus.once('headless_wallet_ready', () => {
	let error = '';
	let arrTableNames = ['users', 'receiving_addresses', 'transactions', 'attestation_units', 'rejected_payments'];
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [arrTableNames], async (rows) => {
		if (rows.length !== arrTableNames.length)
			error += texts.errorInitSql();

		if (conf.useSmtp && (!conf.smtpUser || !conf.smtpPassword || !conf.smtpHost)) 
			error += texts.errorSmtp();

		if (!conf.admin_email || !conf.from_email) 
			error += texts.errorEmail();
		
		if (!conf.salt)
			error += "Please set salt in conf for hashing user ids";

		if (error)
			throw new Error(error);

		await db_migrations();
		
		let headlessWallet = require('headless-byteball');
		headlessWallet.issueOrSelectAddressByIndex(0, 0, address1 => {
			console.log('== real name attestation address: '+address1);
			realNameAttestation.assocAttestorAddresses['real name'] = address1;
			headlessWallet.issueOrSelectAddressByIndex(0, 1, address2 => {
				console.log('== non-US attestation address: '+address2);
				realNameAttestation.assocAttestorAddresses['nonus'] = address2;
				headlessWallet.issueOrSelectAddressByIndex(0, 2, address3 => {
					console.log('== distribution address: '+address3);
					reward.distribution_address = address3;
					
					server.listen(conf.webPort);
					
					setInterval(jumio.retryInitScans, 60*1000);
					setInterval(realNameAttestation.retryPostingAttestations, 10*1000);
					setInterval(reward.retrySendingRewards, 120*1000);
					setInterval(pollAndHandleJumioScanData, 300*1000);
					setInterval(moveFundsToAttestorAddresses, 60*1000);
					setInterval(reward.sendDonations, 24*3600*1000);
					
					const consolidation = require('headless-byteball/consolidation.js');
					consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['real name'], headlessWallet.signer, 100, 3600*1000);
					consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['nonus'], headlessWallet.signer, 100, 3600*1000);
				});
			});
		});
	});
});

process.on('unhandledRejection', up => { throw up; });
