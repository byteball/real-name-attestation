/*jslint node: true */
'use strict';
const jumioApi = require('./jumio_api.js');
const db = require('ocore/db');
const conf = require('ocore/conf.js');
const objectHash = require('ocore/object_hash.js');

function initSmartIdLogin(transaction_id, device_address, user_address, onDone){
	if (!conf.apiSmartIdToken || !conf.apiSmartIdSecret || !conf.apiSmartIdCallback || !conf.apiSmartIdRedirect) {
		throw Error("eID Easy credentials missing");
	}
	const mutex = require('ocore/mutex.js');
	const device = require('ocore/device.js');
	mutex.lock(['tx-'+transaction_id], function(unlock){
		db.query("SELECT jumioIdScanReference FROM transactions WHERE transaction_id=?", [transaction_id], rows => {
			if (rows[0].jumioIdScanReference){
				unlock();
				if (onDone)
					onDone();
				return;
			}
			let scanReference = transaction_id+'_smartid';
			let callbackReference = objectHash.getHexHash([transaction_id, user_address, conf.salt]);
			db.query(
				"UPDATE transactions SET scanReference=?, jumioIdScanReference=? WHERE transaction_id=?", 
				[scanReference, callbackReference, transaction_id],
				() => {
					unlock();
					if (onDone)
						onDone();
					let redirect_url = conf.apiSmartIdRedirect +'?state='+ callbackReference;
					return device.sendMessageToDevice(device_address, 'text', "Please click this link to start authentication: "+redirect_url);
				}
			);
		});
	});
}

function initAndWriteJumioScan(transaction_id, device_address, user_address, onDone){
	const mutex = require('ocore/mutex.js');
	const device = require('ocore/device.js');
	mutex.lock(['tx-'+transaction_id], function(unlock){
		db.query("SELECT jumioIdScanReference FROM transactions WHERE transaction_id=?", [transaction_id], rows => {
			if (rows[0].jumioIdScanReference){
				unlock();
				if (onDone)
					onDone();
				return;
			}
			let userReference = objectHash.getHexHash([user_address, conf.salt]);
			let scanReference = transaction_id+'_jumio';
			jumioApi.initScan(userReference, scanReference, function(err, redirect_url, callbackReference, authorizationToken){
				if (err){
					unlock();
					if (onDone)
						onDone();
					return device.sendMessageToDevice(device_address, 'text', "Failed to connect to Jumio, will retry later. Please wait.");
				}
				db.query(
					"UPDATE transactions SET scanReference=?, jumioIdScanReference=?, authorizationToken=? WHERE transaction_id=?", 
					[scanReference, callbackReference, authorizationToken, transaction_id],
					() => {
						unlock();
						if (onDone)
							onDone();
						return device.sendMessageToDevice(device_address, 'text', "Please click this link to start verification: "+redirect_url+"\nYou need to complete the verification within 30 minutes after clicking the link, have your document ready.\n\nRemember that the payment is non-refundable. To successfully complete the verification after the first attempt, make sure that you have good lighting conditions, good focus, and no glare when you make the photos.\n\nAfter you are done making photos of your ID and your face, Jumio will take some time to process the images, usually minutes but occasionally hours.  We'll message you only when the final outcome is known.");
					}
				);
			});
		});
	});
}

function retryInitScans(){
	db.query(
		"SELECT transaction_id, device_address, user_address, service_provider \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE jumioIdScanReference IS NULL AND confirmation_date IS NOT NULL",
		rows => {
			rows.forEach(row => {
				if (row.service_provider === 'smartid') {
					initSmartIdLogin(row.transaction_id, row.device_address, row.user_address);
				}
				else {
					initAndWriteJumioScan(row.transaction_id, row.device_address, row.user_address);
				}
			});
		}
	);
}

function pollJumioScanData(handleData){
	console.log('pollJumioScanData');
	db.query(
		"SELECT jumioIdScanReference, transaction_id \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE service_provider = 'jumio' AND scan_result IS NULL AND jumioIdScanReference IS NOT NULL", 
		rows => {
			rows.forEach(row => {
				jumioApi.retrieveScanData(row.jumioIdScanReference, body => {
					if (!body)
						return;
					/*if (body === 'PENDING' && !row.scan_complete){
						db.query("UPDATE transactions SET scan_complete=1 WHERE transaction_id=?", [row.transaction_id]);
						const device = require('ocore/device.js');
						device.sendMessageToDevice(row.device_address, 'text', "Please wait while Jumio verifies the images.  We'll let you know as soon as the outcome is known.");
						return;
					}*/
					handleData(row.transaction_id, body);
				});
			});
		}
	);
}

function cleanExtractedData() {
	db.query("UPDATE transactions SET extracted_data = NULL WHERE transaction_id IN (SELECT transaction_id FROM attestation_units JOIN transactions USING(transaction_id) WHERE extracted_data IS NOT NULL AND attestation_date IS NOT NULL AND attestation_date < "+ db.addTime('-7 day') + ");");
}

exports.initSmartIdLogin = initSmartIdLogin;
exports.initAndWriteJumioScan = initAndWriteJumioScan;
exports.retryInitScans = retryInitScans;
exports.pollJumioScanData = pollJumioScanData;
exports.cleanExtractedData = cleanExtractedData;

