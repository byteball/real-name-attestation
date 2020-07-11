/*jslint node: true */
'use strict';
const request = require('request');
const db = require('ocore/db');
const conf = require('ocore/conf.js');
const notifications = require('./notifications.js');

//require('request-debug')(request);

function sendRestRequest(url, onDone){
	if (!conf.apiToken || !conf.apiSecret) {
		throw Error("jumio credentials missing");
	}
	let headers = {
		"Content-Type": "application/json",
		"User-Agent": "Obyte attestation/1.0"
	};
	request({
		url: url, 
		headers: headers, 
		method: 'GET', 
		auth: {
			user: conf.apiToken,
			pass: conf.apiSecret,
			sendImmediately: true
		}
	}, function (error, response, body){
		if (error || response.statusCode !== 200){
			notifications.notifyAdmin(url+" failed", error+", status="+(response ? response.statusCode : '?'));
			return onDone(url+" failed: "+error);
		}
		console.log("response: ", body);
		if (typeof body === 'string')
			body = JSON.parse(body);
		onDone(null, body);
	});
}

function retrieveScanData(jumioIdScanReference, onDone){
	console.log('retrieveJumioScanData', jumioIdScanReference);
	sendRestRequest("https://lon.netverify.com/api/netverify/v2/scans/"+jumioIdScanReference, (err, body) => {
		console.log(err, body);
		if (err)
			return onDone();
		if (!body.status){
			notifications.notifyAdmin("no status", JSON.stringify(body));
			return onDone();
		}
		if (body.status === 'PENDING')
			return onDone();
		sendRestRequest("https://lon.netverify.com/api/netverify/v2/scans/"+jumioIdScanReference+"/data", (err, body) => {
			if (err)
				return onDone();
			onDone(body);
		});
	});
}

function pollScanData(handleAttestation){
	console.log('pollJumioScanData');
	db.query(
		"SELECT jumioIdScanReference, transaction_id \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE service_provider = 'jumio' AND scan_result IS NULL AND jumioIdScanReference IS NOT NULL", 
		rows => {
			rows.forEach(row => {
				retrieveScanData(row.jumioIdScanReference, body => {
					if (!body)
						return;
					/*if (body === 'PENDING' && !row.scan_complete){
						db.query("UPDATE transactions SET scan_complete=1 WHERE transaction_id=?", [row.transaction_id]);
						const device = require('ocore/device.js');
						device.sendMessageToDevice(row.device_address, 'text', "Please wait while Jumio verifies the images.  We'll let you know as soon as the outcome is known.");
						return;
					}*/
					handleData(row.transaction_id, body, handleAttestation);
				});
			});
		}
	);
}

function initScan(userReference, scanReference, onDone){
	if (!conf.apiToken || !conf.apiSecret) {
		throw Error("jumio credentials missing");
	}
//	let auth = "Basic " + new Buffer(conf.apiToken + ":" + conf.apiSecret).toString("base64");
	let headers = {
		"Content-Type": "application/json",
		"User-Agent": "Obyte attestation/1.0"
	};
	let json = {
	//	merchantIdScanReference: scanReference,
	//	customerId: userReference
		customerInternalReference: scanReference,
		userReference: userReference,
		tokenLifetimeInMinutes: 4320  // 3 days
	};
	request({
	//	url: "https://lon.netverify.com/api/netverify/v2/initiateNetverifyRedirect", 
		url: "https://lon.netverify.com/api/v4/initiate", 
		headers: headers, 
		method: 'POST', 
		json: json,
		auth: {
			user: conf.apiToken,
			pass: conf.apiSecret,
			sendImmediately: true
		}
	}, function (error, response, body){
		if (error || response.statusCode !== 200){
			notifications.notifyAdmin("init netverify failed", error+", status="+(response ? response.statusCode : '?'));
			return onDone("init netverify failed: "+error);
		}
		console.log("response: ", body);
	//	onDone(null, body.clientRedirectUrl, body.jumioIdScanReference, body.authorizationToken);
		onDone(null, body.redirectUrl, body.transactionReference, body.authorizationToken);
	});
}

function handleData(transaction_id, body, handleAttestation){
	let data = body.transaction ? convertRestResponseToCallbackFormat(body) : body;
	if (typeof data.identityVerification === 'string') // contrary to docs, it is a string, not an object
		data.identityVerification = JSON.parse(data.identityVerification);
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let error = scan_result ? '' : data.verificationStatus;
	let bHasLatNames = (scan_result && data.idFirstName && data.idLastName && data.idFirstName !== 'N/A' && data.idLastName !== 'N/A');
	if (bHasLatNames && data.idCountry === 'RUS' && data.idType === 'ID_CARD') // Russian internal passport
		bHasLatNames = false;
	if (scan_result && !bHasLatNames){
		scan_result = 0;
		error = "couldn't extract your name. Please [try again](command:again) and provide a document with your name printed in Latin characters.";
	}
	if (scan_result && !data.identityVerification){
		console.error("no identityVerification in tx "+transaction_id);
		return;
	}
	if (scan_result && (!data.identityVerification.validity || data.identityVerification.similarity !== 'MATCH')){ // selfie check and selfie match
		scan_result = 0;
		error = data.identityVerification.reason || data.identityVerification.similarity;
	}
	handleAttestation(transaction_id, body, data, scan_result, error);
}

function convertRestResponseToCallbackFormat(body){
	let data = {
		idScanStatus: body.transaction.status,
		verificationStatus: body.document.status,
		idFirstName: body.document.firstName,
		idLastName: body.document.lastName,
		idDob: body.document.dob,
		gender: body.document.gender,
		personalCode: '', // incomplete data
		idCountry: body.document.issuingCountry,
		idUsState: body.document.usState,
		idNumber: body.document.number,
		idType: body.document.type,
		idSubtype: body.document.idSubtype,
		idExpiry: body.document.idExpiry,
		idIssuedAt: body.document.issuingDate,
		clientIp: body.transaction.clientIp
	};
	if (body.verification)
		data.identityVerification = body.verification.identityVerification;
	return data;
}

exports.initScan = initScan;
exports.pollScanData = pollScanData;
exports.handleData = handleData;
exports.convertRestResponseToCallbackFormat = convertRestResponseToCallbackFormat;

