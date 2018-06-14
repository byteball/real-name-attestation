/*jslint node: true */
'use strict';
const crypto = require('crypto');
const moment = require('moment');
const constants = require('byteballcore/constants.js');
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const eventBus = require('byteballcore/event_bus.js');
const texts = require('./modules/texts.js');
const validationUtils = require('byteballcore/validation_utils');
const notifications = require('./modules/notifications');
const conversion = require('./modules/conversion.js');
const jumioApi = require('./modules/jumio_api.js');
const jumio = require('./modules/jumio.js');
const realNameAttestation = require('./modules/real_name_attestation.js');
const reward = require('./modules/reward.js');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const server = require('http').Server(app);
const maxmind = require('maxmind');

const PRICE_TIMEOUT = 3*24*3600; // in seconds

let countryLookup = maxmind.openSync('../GeoLite2-Country.mmdb');

function readUserInfo(device_address, cb) {
	db.query("SELECT user_address FROM users WHERE device_address = ?", [device_address], rows => {
		if (rows.length)
			cb(rows[0]);
		else {
			db.query("INSERT "+db.getIgnore()+" INTO users (device_address) VALUES(?)", [device_address], () => {
				cb({
					device_address: device_address,
					user_addres: null
				});
			});
		}
	});
}

function readOrAssignReceivingAddress(device_address, user_address, cb){
	const mutex = require('byteballcore/mutex.js');
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
	db.query(
		"UPDATE transactions SET scan_result=?, result_date="+db.getNow()+", extracted_data=? \n\
		WHERE transaction_id=? AND scan_result IS NULL", 
		[scan_result, JSON.stringify(body), transaction_id]);
	db.query(
		"SELECT user_address, device_address, post_publicly, payment_unit \n\
		FROM transactions CROSS JOIN receiving_addresses USING(receiving_address) WHERE transaction_id=?", 
		[transaction_id],
		rows => {
			let row = rows[0];
			if (scan_result === 0){
				return device.sendMessageToDevice(row.device_address, 'text', "Verification failed: "+error+"\n\nTry [again](command:again)?");
			}
			let bNonUS = (data.idCountry !== 'USA');
			if (bNonUS){
				let ipCountry = getCountryByIp(data.clientIp);
				if (ipCountry === 'US' || ipCountry === 'UNKNOWN')
					bNonUS = false;
			}
			db.query("INSERT "+db.getIgnore()+" INTO attestation_units (transaction_id, attestation_type) VALUES (?, 'real name')", [transaction_id], () => {
				row.post_publicly = 0; // override user choice
				let [attestation, src_profile] = realNameAttestation.getAttestationPayloadAndSrcProfile(row.user_address, data, row.post_publicly);
				if (!row.post_publicly)
					realNameAttestation.postAndWriteAttestation(transaction_id, 'real name', realNameAttestation.assocAttestorAddresses['real name'], attestation, src_profile);
				if (bNonUS)
					setTimeout(() => {
						device.sendMessageToDevice(row.device_address, 'text', texts.attestNonUS());
					}, 2000);
				if (conf.rewardInUSD || conf.contractRewardInUSD){
					let rewardInBytes = conversion.getPriceInBytes(conf.rewardInUSD);
					let contractRewardInBytes = conversion.getPriceInBytes(conf.contractRewardInUSD);
					db.query(
						"INSERT "+db.getIgnore()+" INTO reward_units (transaction_id, device_address, user_address, user_id, reward, contract_reward) VALUES (?, ?,?,?, ?,?)", 
						[transaction_id, row.device_address, row.user_address, attestation.profile.user_id, rewardInBytes, contractRewardInBytes], 
						async (res) => {
							console.log("reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
							if (!res.affectedRows)
								return console.log("duplicate user_address or user_id or device address: "+row.user_address+", "+attestation.profile.user_id+", "+row.device_address);
							let [contract_address, vesting_ts] = await createContract(row.user_address, row.device_address);
							let message = "You were attested for the first time and will receive a welcome bonus of $"+conf.rewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(rewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund.";
							if (conf.contractRewardInUSD)
								message += "  You will also receive a reward of $"+conf.contractRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(contractRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) that will be locked on a smart contract for "+conf.contractTerm+" year and can be spent only after "+new Date(vesting_ts).toDateString()+".";
							device.sendMessageToDevice(row.device_address, 'text', message);
							reward.sendAndWriteReward('attestation', transaction_id);
							if (conf.referralRewardInUSD || conf.contractReferralRewardInUSD){
								let referralRewardInBytes = conversion.getPriceInBytes(conf.referralRewardInUSD);
								let contractReferralRewardInBytes = conversion.getPriceInBytes(conf.contractReferralRewardInUSD);
								reward.findReferrer(row.payment_unit, async (referring_user_id, referring_user_address, referring_user_device_address) => {
									if (!referring_user_address)
										return console.log("no referring user for "+row.user_address);
									let [referrer_contract_address, referrer_vesting_date_ts] = 
										await getReferrerContract(referring_user_address, referring_user_device_address);
									db.query(
										"INSERT "+db.getIgnore()+" INTO referral_reward_units \n\
										(transaction_id, user_address, user_id, new_user_address, new_user_id, reward, contract_reward) VALUES (?, ?,?, ?,?, ?,?)", 
										[transaction_id, 
										referring_user_address, referring_user_id, 
										row.user_address, attestation.profile.user_id, 
										referralRewardInBytes, contractReferralRewardInBytes], 
										(res) => {
											console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
											if (!res.affectedRows)
												return notifications.notifyAdmin("duplicate referral reward", "referral reward for new user "+row.user_address+" "+attestation.profile.user_id+" already written");
											let reward_text = referralRewardInBytes
												? "and you will receive a reward of $"+conf.referralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(referralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund"
												: "and you will receive a reward of $"+conf.contractReferralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(contractReferralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund.  The reward will be paid to a smart contract which can be spent after "+new Date(referrer_vesting_date_ts).toDateString();
											device.sendMessageToDevice(referring_user_device_address, 'text', "You referred a user who has just verified his identity "+reward_text+".  Thank you for bringing in a new byteballer, the value of the ecosystem grows with each new user!");
											reward.sendAndWriteReward('referral', transaction_id);
										}
									);
								});
							}
						}
					);
				}
			});
		}
	);
}

function createContract(user_address, device_address){
	let device = require('byteballcore/device.js');
	let date = new Date();
	date.setUTCHours(0,0,0,0);
	let current_year = date.getUTCFullYear();
	let vesting_ts = date.setUTCFullYear(current_year + conf.contractTerm);
	let claim_back_ts = date.setUTCFullYear(current_year + conf.contractUnclaimedTerm);
	let arrDefinition = ['or', [
		['and', [
			['address', user_address],
			['in data feed', [[conf.TIMESTAMPER_ADDRESS], 'timestamp', '>', vesting_ts]]
		]],
		['and', [
			['address', reward.distribution_address],
			['in data feed', [[conf.TIMESTAMPER_ADDRESS], 'timestamp', '>', claim_back_ts]]
		]]
	]];
	let assocSignersByPath = {
		'r.0.0': {
			address: user_address,
			member_signing_path: 'r',
			device_address: device_address
		},
		'r.1.0': {
			address: reward.distribution_address,
			member_signing_path: 'r',
			device_address: device.getMyDeviceAddress()
		}
	};

	return new Promise(resolve => {
		let walletDefinedByAddresses = require('byteballcore/wallet_defined_by_addresses.js');
		walletDefinedByAddresses.createNewSharedAddress(arrDefinition, assocSignersByPath, {
			ifError: (err) => {
				throw new Error(err);
			},
			ifOk: (shared_address) => {
				db.query(
					"INSERT "+db.getIgnore()+" INTO contracts (user_address, contract_address, contract_vesting_date) \n\
					VALUES(?,?,"+db.getFromUnixTime(vesting_ts/1000)+")", 
					[user_address, shared_address],
					() => {
						resolve([shared_address, vesting_ts]);
					}
				);
			}
		});
	});
}

function getReferrerContract(user_address, device_address){
	return new Promise(resolve => {
		db.query(
			"SELECT contract_address, "+db.getUnixTimestamp('contract_vesting_date')+"*1000 AS contract_vesting_date_ts \n\
			FROM contracts WHERE user_address=?", 
			[user_address], 
			async (rows) => {
				if (rows.length > 0){
					let contract_address = rows[0].contract_address;
					let contract_vesting_date_ts = rows[0].contract_vesting_date_ts;
					return resolve([contract_address, contract_vesting_date_ts]);
				}
				let [contract_address, contract_vesting_date_ts] = await createContract(user_address, device_address);
				resolve([contract_address, contract_vesting_date_ts]);
			}
		);
	});
}

function respond(from_address, text, response){
	let device = require('byteballcore/device.js');
	readUserInfo(from_address, userInfo => {
		
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
			readOrAssignReceivingAddress(from_address, userInfo.user_address, (receiving_address, post_publicly) => {
				let price = conversion.getPriceInBytes(conf.priceInUSD);
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
					return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, userInfo.user_address, post_publicly));
				db.query(
					"SELECT scan_result, attestation_date, transaction_id, extracted_data, user_address \n\
					FROM transactions JOIN receiving_addresses USING(receiving_address) LEFT JOIN attestation_units USING(transaction_id) \n\
					WHERE receiving_address=? ORDER BY transaction_id DESC LIMIT 1", 
					[receiving_address], 
					rows => {
						if (rows.length === 0)
							return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, userInfo.user_address, post_publicly));
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
									});
								}
							);
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
			"SELECT amount, asset, device_address, receiving_address, user_address, unit, price, "+db.getUnixTimestamp('last_price_date')+" AS price_ts \n\
			FROM outputs CROSS JOIN receiving_addresses ON outputs.address=receiving_addresses.receiving_address \n\
			WHERE unit IN(?) AND NOT EXISTS (SELECT 1 FROM unit_authors CROSS JOIN my_addresses USING(address) WHERE unit_authors.unit=outputs.unit)",
			[arrUnits],
			rows => {
				rows.forEach(row => {
			
					function checkPayment(onDone){
						let delay = Math.round(Date.now()/1000 - row.price_ts);
						let bLate = (delay > PRICE_TIMEOUT);
						if (row.asset !== null)
							return onDone("Received payment in wrong asset", delay);
						let current_price = conversion.getPriceInBytes(conf.priceInUSD);
						let expected_amount = bLate ? current_price : row.price;
						if (row.amount < expected_amount){
							updatePrice(row.device_address, current_price);
							let text = "Received "+(row.amount/1e9)+" GB from you";
							text += bLate 
								? ".  Your payment is too late and less than the current price.  " 
								: ", which is less than the expected "+(row.price/1e9)+" GB.  ";
							return onDone(text + texts.pleasePay(row.receiving_address, current_price, row.user_address), delay);
						}
						db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], author_rows => {
							if (author_rows.length !== 1){
								resetUserAddress();
								return onDone("Received a payment but looks like it was not sent from a single-address wallet.  "+texts.switchToSingleAddress());
							}
							if (author_rows[0].address !== row.user_address){
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
						db.query(
							"INSERT INTO transactions (receiving_address, price, received_amount, payment_unit) VALUES (?,?, ?,?)", 
							[row.receiving_address, row.price, row.amount, row.unit]
						);
						device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB, waiting for confirmation.  It should take 5-10 minutes.");
					});
				});
			}
		);
	});
	
	eventBus.on('my_transactions_became_stable', arrUnits => {
		let device = require('byteballcore/device.js');
		db.query(
			"SELECT transaction_id, device_address, user_address \n\
			FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
			WHERE payment_unit IN(?) ",
			[arrUnits],
			rows => {
				rows.forEach(row => {
					db.query("UPDATE transactions SET confirmation_date="+db.getNow()+", is_confirmed=1 WHERE transaction_id=?", [row.transaction_id]);
					device.sendMessageToDevice(row.device_address, 'text', "Your payment is confirmed, redirecting to Jumio...");
					jumio.initAndWriteScan(row.transaction_id, row.device_address, row.user_address);
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
	db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?)", [arrTableNames], rows => {
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
		
		let headlessWallet = require('headless-byteball');
		const split = require('headless-byteball/split.js');
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

					split.startCheckingAndSplittingLargestOutput(reward.distribution_address);
					
					setInterval(jumio.retryInitScans, 60*1000);
					setInterval(realNameAttestation.retryPostingAttestations, 10*1000);
					setInterval(reward.retrySendingRewards, 120*1000);
					setInterval(pollAndHandleJumioScanData, 300*1000);
					setInterval(moveFundsToAttestorAddresses, 60*1000);
					
					const consolidation = require('headless-byteball/consolidation.js');
					consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['real name'], headlessWallet.signer, 100, 3600*1000);
					consolidation.scheduleConsolidation(realNameAttestation.assocAttestorAddresses['nonus'], headlessWallet.signer, 100, 3600*1000);
				});
			});
		});
	});
});

process.on('unhandledRejection', up => { throw up; });
