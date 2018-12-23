/*jslint node: true */
'use strict';
const jumioApi = require('./jumio_api.js');
const smartidApi = require('./smartid_api.js');
const db = require('byteballcore/db');
const conf = require('byteballcore/conf.js');
const objectHash = require('byteballcore/object_hash.js');

function initSmartIdLogin(transaction_id, device_address, user_address, onDone){
	const mutex = require('byteballcore/mutex.js');
	const device = require('byteballcore/device.js');
	mutex.lock(['tx-'+transaction_id], function(unlock){
		db.query("SELECT jumioIdScanReference FROM transactions WHERE transaction_id=?", [transaction_id], rows => {
			if (rows[0].jumioIdScanReference){
				unlock();
				if (onDone)
					onDone();
				return;
			}
			let scanReference = transaction_id+'_'+user_address;
			let stateReference = objectHash.getBase64Hash([transaction_id, user_address, conf.salt]);
			db.query(
				"UPDATE transactions SET scanReference=?, jumioIdScanReference=? WHERE transaction_id=?", 
				[scanReference, stateReference, transaction_id],
				() => {
					unlock();
					if (onDone)
						onDone();
				}
			);
			device.sendMessageToDevice(device_address, 'text', "Please click this link to start authentication: "+smartidApi.getLoginUrl(stateReference));
		});
	});
}

function initAndWriteJumioScan(transaction_id, device_address, user_address, onDone){
	const mutex = require('byteballcore/mutex.js');
	const device = require('byteballcore/device.js');
	mutex.lock(['tx-'+transaction_id], function(unlock){
		db.query("SELECT jumioIdScanReference FROM transactions WHERE transaction_id=?", [transaction_id], rows => {
			if (rows[0].jumioIdScanReference){
				unlock();
				if (onDone)
					onDone();
				return;
			}
			let scanReference = transaction_id+'_'+user_address;
			jumioApi.initScan(user_address, scanReference, function(err, redirect_url, jumioIdScanReference, authorizationToken){
				if (err){
					unlock();
					if (onDone)
						onDone();
					return device.sendMessageToDevice(device_address, 'text', "Failed to connect to Jumio, will retry later. Please wait.");
				}
				db.query(
					"UPDATE transactions SET scanReference=?, jumioIdScanReference=?, authorizationToken=? WHERE transaction_id=?", 
					[scanReference, jumioIdScanReference, authorizationToken, transaction_id],
					() => {
						unlock();
						if (onDone)
							onDone();
					}
				);
				device.sendMessageToDevice(device_address, 'text', "Please click this link to start verification: "+redirect_url+"\nYou need to complete the verification within 30 minutes after clicking the link, have your document ready.\n\nRemember that the payment is non-refundable. To successfully complete the verification after the first attempt, make sure that you have good lighting conditions, good focus, and no glare when you make the photos.\n\nAfter you are done making photos of your ID and your face, Jumio will take some time to process the images, usually minutes but occasionally hours.  We'll message you only when the final outcome is known.");
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
						const device = require('byteballcore/device.js');
						device.sendMessageToDevice(row.device_address, 'text', "Please wait while Jumio verifies the images.  We'll let you know as soon as the outcome is known.");
						return;
					}*/
					handleData(row.transaction_id, body);
				});
			});
		}
	);
}

exports.initSmartIdLogin = initSmartIdLogin;
exports.initAndWriteJumioScan = initAndWriteJumioScan;
exports.retryInitScans = retryInitScans;
exports.pollJumioScanData = pollJumioScanData;

