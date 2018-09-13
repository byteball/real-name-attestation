/*jslint node: true */
'use strict';
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const chash = require('byteballcore/chash');
const conversion = require('./conversion.js');
const headlessWallet = require('headless-byteball');
const contract = require('./contract.js');

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

function getInfoById(voucher_id){
	return new Promise((resolve) => {
		db.query(
			`SELECT * FROM vouchers WHERE voucher_id=?`, 
			[voucher_id],
			rows => {
				resolve(rows[0]);
			}
		);
	});
}

function getAllUserVouchers(user_address) {
	return new Promise((resolve) => {
		db.query(
			`SELECT * FROM vouchers WHERE user_address=?`, 
			[user_address],
			rows => {
				resolve(rows);
			}
		);
	});
}

function setLimit(voucher_id, limit){
	return new Promise((resolve) => {
		db.query(
			`UPDATE vouchers SET usage_limit=? WHERE voucher_id=?`, 
			[limit, voucher_id],
			resolve
		);
	});
}

function withdraw(voucherInfo, amount) {
	return new Promise(async (resolve) => {
		const bytes = Math.min(amount, voucherInfo.amount_deposited, voucherInfo.amount);
		const contract_bytes = Math.min(amount-bytes, voucherInfo.amount-bytes);
		let outputs = [];
		if (bytes)
			outputs.push({address: voucherInfo.user_address, amount: bytes});
		if (contract_bytes) {
			let [contract_address, vesting_ts] = await contract.getReferrerContract(voucherInfo.user_address, voucherInfo.device_address);
			outputs.push({address: contract_address, amount: contract_bytes});
		}
		headlessWallet.sendMultiPayment({
			asset: null,
			base_outputs: outputs,
			paying_addresses: [voucherInfo.receiving_address],
			change_address: voucherInfo.receiving_address,
			recipient_device_address: voucherInfo.device_address
		}, (err, unit) => {
			if (err){
				console.log("failed to withdraw: "+err);
				return resolve([err]);
			}
			console.log("withdrawal success, unit "+unit);
			db.query(`UPDATE vouchers SET amount=amount-?, amount_deposited=amount_deposited-? WHERE voucher_id=?`, [bytes+contract_bytes, bytes, voucherInfo.voucher_id], () => {
				db.query(
					`INSERT INTO voucher_transactions (voucher_id, amount, unit) VALUES (?, ?, ?)`, 
					[voucherInfo.voucher_id, bytes+contract_bytes, unit]
				);
				resolve([null, bytes, contract_bytes])});
		});
	});
}

exports.issueNew = issueNew;
exports.getInfo = getInfo;
exports.getInfoById = getInfoById;
exports.setLimit = setLimit;
exports.withdraw = withdraw;
exports.getAllUserVouchers = getAllUserVouchers;
