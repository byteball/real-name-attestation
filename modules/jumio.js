/*jslint node: true */
'use strict';
const jumioApi = require('./jumio_api.js');
const db = require('byteballcore/db');


function initAndWriteScan(transaction_id, device_address, user_address, onDone){
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
				device.sendMessageToDevice(device_address, 'text', "Please click this link to start verification: "+redirect_url);
			});
		});
	});
}

function retryInitScans(){
	db.query(
		"SELECT transaction_id, device_address, user_address \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE jumioIdScanReference IS NULL AND confirmation_date IS NOT NULL",
		rows => {
			rows.forEach(row => {
				initAndWriteScan(row.transaction_id, row.device_address, row.user_address);
			});
		}
	);
}

function pollJumioScanData(handleData){
	console.log('pollJumioScanData');
	db.query(
		"SELECT jumioIdScanReference, transaction_id \n\
		FROM transactions JOIN receiving_addresses USING(receiving_address) \n\
		WHERE scan_result IS NULL AND jumioIdScanReference IS NOT NULL", 
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

exports.initAndWriteScan = initAndWriteScan;
exports.retryInitScans = retryInitScans;
exports.pollJumioScanData = pollJumioScanData;

