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

const PRICE_TIMEOUT = 3600; // in seconds

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
	if (!countryInfo){
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
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let bHasLatNames = (scan_result && data.idFirstName && data.idLastName && data.idFirstName !== 'N/A' && data.idLastName !== 'N/A');
	let bNoLatNames = (scan_result && !bHasLatNames);
	if (!bHasLatNames)
		scan_result = 0;
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
				let error = bNoLatNames 
					? "couldn't extract your name.  Please [try again](command:again) and provide a document with your name printed in Latin characters." 
					: data.verificationStatus;
				return device.sendMessageToDevice(row.device_address, 'text', "Verification failed: "+error+"\n\nTry [again](command:again)?");
			}
			let bNonUS = (data.idCountry !== 'USA');
			if (bNonUS){
				let ipCountry = getCountryByIp(data.clientIp);
				if (ipCountry === 'US' || ipCountry === 'UNKNOWN')
					bNonUS = false;
			}
			db.query("INSERT "+db.getIgnore()+" INTO attestation_units (transaction_id, attestation_type) VALUES (?, 'real name')", [transaction_id], () => {
				let [attestation, src_profile] = realNameAttestation.getAttestationPayloadAndSrcProfile(row.user_address, data, row.post_publicly);
				if (!row.post_publicly)
					realNameAttestation.postAndWriteAttestation(transaction_id, 'real name', realNameAttestation.assocAttestorAddresses['real name'], attestation, src_profile);
				if (bNonUS)
					setTimeout(() => {
						device.sendMessageToDevice(row.device_address, 'text', texts.attestNonUS());
					}, 2000);
				if (conf.rewardInUSD){
					let rewardInBytes = conversion.getPriceInBytes(conf.rewardInUSD);
					db.query(
						"INSERT "+db.getIgnore()+" INTO reward_units (transaction_id, user_address, user_id, reward) VALUES (?,?,?,?)", 
						[transaction_id, row.user_address, attestation.profile.user_id, rewardInBytes], 
						(res) => {
							console.log("reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
							if (!res.affectedRows)
								return console.log("duplicate user_address or user_id: "+row.user_address+", "+attestation.profile.user_id);
							device.sendMessageToDevice(row.device_address, 'text', "You were attested for the first time and will receive a welcome bonus of $"+conf.rewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(rewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund.");
							reward.sendAndWriteReward('attestation', transaction_id);
							if (conf.referralRewardInUSD){
								let referralRewardInBytes = conversion.getPriceInBytes(conf.referralRewardInUSD);
								reward.findReferral(row.payment_unit, (referring_user_id, referring_user_address, referring_user_device_address) => {
									if (!referring_user_address)
										return console.log("no referring user for "+row.user_address);
									db.query(
										"INSERT "+db.getIgnore()+" INTO referral_reward_units \n\
										(transaction_id, user_address, user_id, new_user_address, new_user_id, reward) VALUES (?, ?,?, ?,?, ?)", 
										[transaction_id, 
										referring_user_address, referring_user_id, 
										row.user_address, attestation.profile.user_id, 
										referralRewardInBytes], 
										(res) => {
											console.log("referral_reward_units insertId: "+res.insertId+", affectedRows: "+res.affectedRows);
											if (!res.affectedRows)
												return notifications.notifyAdmin("duplicate referral reward", "referral reward for new user "+row.user_address+" "+attestation.profile.user_id+" already written");
											device.sendMessageToDevice(referring_user_device_address, 'text', "You referred a user who has just verified his identity and you will receive a reward of $"+conf.referralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" ("+(referralRewardInBytes/1e9).toLocaleString([], {maximumFractionDigits: 9})+" GB) from Byteball distribution fund.  Thank you for bringing in a new byteballer, the value of the ecosystem grows with each new user!");
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
					return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, post_publicly));
				db.query(
					"SELECT scan_result, attestation_date, transaction_id, extracted_data, user_address \n\
					FROM transactions JOIN receiving_addresses USING(receiving_address) LEFT JOIN attestation_units USING(transaction_id) \n\
					WHERE receiving_address=? ORDER BY transaction_id DESC LIMIT 1", 
					[receiving_address], 
					rows => {
						if (rows.length === 0)
							return device.sendMessageToDevice(from_address, 'text', response + texts.pleasePayOrPrivacy(receiving_address, price, post_publicly));
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
							return onDone(text + texts.pleasePay(row.receiving_address, current_price), delay);
						}
						db.query("SELECT address FROM unit_authors WHERE unit=?", [row.unit], author_rows => {
							if (author_rows.length !== 1)
								return onDone("Received a payment but looks like it was not sent from a single-address wallet.  " + texts.pleasePay(row.receiving_address, current_price), delay);
							if (author_rows[0].address !== row.user_address)
								return onDone("Received a payment but it was not sent from the expected address "+row.user_address+".  Make sure you are in a single-address wallet, otherwise switch to a single-address wallet or create one and send me your address before paying.  " + texts.pleasePay(row.receiving_address, current_price), delay);
							onDone();
						});
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
						device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(row.amount/1e9)+" GB, waiting for confirmation");
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
					setInterval(reward.retrySendingRewards, 10*1000);
					setInterval(pollAndHandleJumioScanData, 60*1000);
					setInterval(moveFundsToAttestorAddresses, 60*1000);
				});
			});
		});
	});
});

