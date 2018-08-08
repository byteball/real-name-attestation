/*jslint node: true */
'use strict';
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const chash = require('byteballcore/chash');
const conversion = require('./conversion.js');

function issueNew(user_address, device_address){
	return new Promise((resolve) => {
		const headlessWallet = require('headless-byteball');
		headlessWallet.issueNextMainAddress(receiving_address => {
			let voucher = chash.getChash160(user_address + device_address + receiving_address + Date.now().toString()).substr(3, 13);
			db.query(
				`INSERT INTO vouchers (user_address, device_address, receiving_address, voucher) VALUES (?, ?, ?, ?)`, 
				[user_address, device_address, receiving_address, voucher],
				() => {
					resolve([voucher, receiving_address]);
				}
			);
		});
		
	});
}

function getInfo(voucher){
	return new Promise((resolve) => {
		db.query(
			`SELECT * FROM vouchers WHERE voucher=?`, 
			[voucher],
			rows => {
				resolve(rows[0]);
			}
		);
	});
}

exports.issueNew = issueNew;
exports.getInfo = getInfo;

