/*jslint node: true */
'use strict';
const request = require('request');
const crypto = require('crypto');
const db = require('ocore/db');
const conf = require('ocore/conf.js');
const notifications = require('./notifications.js');

function retrieveScanData(verificationID, onDone){
	console.log('retrieveVeriffScanData', verificationID);
	if (!conf.apiVeriffPublicKey || !conf.apiVeriffPrivateKey || !conf.apiVeriffBaseUrl) {
		throw Error("veriff credentials missing");
	}
	let url = conf.apiVeriffBaseUrl + '/v1/sessions/' + verificationID + '/decision';
	request({
		method: 'GET',
		url,
		headers: {
			"Content-Type" : "application/json",
			'X-AUTH-CLIENT': conf.apiVeriffPublicKey,
			'X-SIGNATURE'  : generateSignature(verificationID)
		},
		json: true
	}, function (error, response, body){
		if (error || response.statusCode !== 200){
			notifications.notifyAdmin(url+" failed", error+", status="+(response ? response.statusCode : '?'));
			return onDone();
		}
		console.log("response: ", body);
		onDone(body);
	});
}

function pollScanData(handleAttestation){
	console.log('pollVeriffScanData');
	db.query(
		"SELECT jumioIdScanReference, transaction_id \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE service_provider = 'veriff' AND scan_result IS NULL AND jumioIdScanReference IS NOT NULL", 
		rows => {
			rows.forEach(row => {
				retrieveScanData(row.jumioIdScanReference, body => {
					// check if decision has been made
					if (!body || !body.verification)
						return;
					handleData(row.transaction_id, body, handleAttestation);
				});
			});
		}
	);
}

function initScan(scanReference, onDone){
	if (!conf.apiVeriffPublicKey || !conf.apiVeriffPrivateKey || !conf.apiVeriffBaseUrl) {
		throw Error("veriff credentials missing");
	}
	let body = {
		verification: {
			//callback: 'https://veriff.com',
			// person: {
			// 	firstName: 'John',
			// 	lastName: 'Smith',
			// 	idNumber: '123456789'
			// },
			// document: {
			// 	number: 'B01234567',
			// 	type: 'PASSPORT',
			// 	country: 'EE'
			// },
			vendorData: scanReference,
			// lang: 'en',
			timestamp: new Date().toISOString()
		}
	};
	request({
		method: 'POST',
		url: conf.apiVeriffBaseUrl + '/v1/sessions/',
		headers: {
			"Content-Type" : "application/json",
			'X-AUTH-CLIENT': conf.apiVeriffPublicKey,
			'X-SIGNATURE'  : generateSignature(body)
		}, 
		body,
		json: true
	}, function (error, response, body){
		if (error || response.statusCode !== 201){
			notifications.notifyAdmin("init veriff failed", error+", status="+(response ? response.statusCode : '?'));
			return onDone("init veriff failed: "+error);
		}
		console.log("response: ", body);
		onDone(null, body.verification.url, body.verification.id);
	});
}

function generateSignature(payload) {
	if (payload.constructor === Object) {
		payload = JSON.stringify(payload);
	}

	if (payload.constructor !== Buffer) {
		payload = Buffer.from(payload, 'utf8');
	}

	const signature = crypto.createHash('sha256');
	signature.update(payload);
	signature.update(new Buffer.from(conf.apiVeriffPrivateKey, 'utf8'));
	return signature.digest('hex');
};

function handleData(transaction_id, body, handleAttestation){
	let data = body.verification ? convertRestResponseToCallbackFormat(body) : body;
	let scan_result = (data.verificationStatus === 'APPROVED_VERIFIED') ? 1 : 0;
	let error = !scan_result ? data.verificationStatus : '';
	if (!error && (!data.idFirstName || !data.idLastName || !data.idDob || !data.idCountry)) {
		scan_result = 0;
		error = 'some required data missing';
	}
	handleAttestation(transaction_id, body, data, scan_result, error);
}

function convertRestResponseToCallbackFormat(body){
	let person_data = body.verification.person;
	let document_data = body.verification.document;
	let data = {
		idScanStatus: (body.verification.code == 9001) ? 'SUCCESS' : 'ERROR',
		verificationStatus: (body.verification.status === 'approved') ? 'APPROVED_VERIFIED' : body.verification.reason,
		idFirstName: person_data.firstName ? String(person_data.firstName).toUpperCase() : '',
		idLastName: person_data.lastName ? String(person_data.lastName).toUpperCase() : '',
		idDob: person_data.dateOfBirth,
		gender: person_data.gender,
		personalCode: person_data.idNumber,
		idCountry: document_data.country,
		idUsState: '',
		idNumber: document_data.number,
		idType: document_data.type,
		idSubtype: '',
		idExpiry: document_data.validUntil,
		idIssuedAt: document_data.validFrom,
		clientIp: body.technicalData.ip
	};
	return data;
}

exports.initScan = initScan;
exports.pollScanData = pollScanData;
exports.generateSignature = generateSignature;
exports.handleData = handleData;
exports.convertRestResponseToCallbackFormat = convertRestResponseToCallbackFormat;

