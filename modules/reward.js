/*jslint node: true */
'use strict';
const conf = require('byteballcore/conf');
const db = require('byteballcore/db');
const notifications = require('./notifications');
const realNameAttestation = require('./real_name_attestation.js');

const MAX_REFERRAL_DEPTH = 5;

exports.distribution_address = null;

function sendReward(outputs, device_address, onDone){
	let headlessWallet = require('headless-byteball');
	headlessWallet.sendMultiPayment({
		asset: null,
		base_outputs: outputs,
		paying_addresses: [exports.distribution_address],
		change_address: exports.distribution_address,
		recipient_device_address: device_address
	}, (err, unit) => {
		if (err){
			console.log("failed to send reward: "+err);
			let balances = require('byteballcore/balances');
			balances.readOutputsBalance(exports.distribution_address, (balance) => {
				console.error(balance);
				notifications.notifyAdmin('failed to send reward', err + ", balance: " + JSON.stringify(balance));
			});
		}
		else
			console.log("sent reward, unit "+unit);
		onDone(err, unit);
	});
}

function sendAndWriteReward(reward_type, transaction_id){
	const mutex = require('byteballcore/mutex.js');
	const table = (reward_type === 'referral') ? 'referral_reward_units' : 'reward_units';
	mutex.lock(['tx-'+transaction_id], unlock => {
		db.query(
			"SELECT receiving_addresses.device_address, reward_date, reward, "+table+".user_address, contract_reward, contract_address \n\
			FROM "+table+" \n\
			JOIN transactions USING(transaction_id) \n\
			JOIN receiving_addresses USING(receiving_address) \n\
			LEFT JOIN contracts ON "+table+".user_address=contracts.user_address \n\
			WHERE transaction_id=?", 
			[transaction_id], 
			rows => {
				if (rows.length === 0)
					throw Error("no record in "+table+" for tx "+transaction_id);
				let row = rows[0];
				if (row.reward_date) // already sent
					return unlock();
				if (row.contract_reward && !row.contract_address)
					throw Error("no contract address for reward "+reward_type+" "+transaction_id);
				let outputs = [];
				if (row.reward)
					outputs.push({address: row.user_address, amount: row.reward});
				if (row.contract_reward)
					outputs.push({address: row.contract_address, amount: row.contract_reward});
				if (outputs.length === 0)
					throw Error("no rewards in tx "+reward_type+" "+transaction_id);
				sendReward(outputs, row.device_address, (err, unit) => {
					if (err)
						return unlock();
					db.query(
						"UPDATE "+table+" SET reward_unit=?, reward_date="+db.getNow()+" WHERE transaction_id=?", 
						[unit, transaction_id], 
						() => {
							let device = require('byteballcore/device.js');
							device.sendMessageToDevice(row.device_address, 'text', "Sent the "+reward_type+" reward");
							unlock();
						}
					);
				});
			}
		);
	});
}

function retrySendingRewardsOfType(reward_type){
	const table = (reward_type === 'referral') ? 'referral_reward_units' : 'reward_units';
	db.query(
		"SELECT transaction_id FROM "+table+" WHERE reward_unit IS NULL LIMIT 5", 
		rows => {
			rows.forEach(row => {
				sendAndWriteReward(reward_type, row.transaction_id);
			});
		}
	);
}

function retrySendingRewards(){
	retrySendingRewardsOfType('attestation');
	retrySendingRewardsOfType('referral');
}

function findReferrer(payment_unit, handleReferrer){
	let assocMcisByAddress = {};
	let depth = 0;
	
	function goBack(arrUnits){
		depth++;
		db.query(
			"SELECT address, src_unit, main_chain_index FROM inputs JOIN units ON src_unit=units.unit \n\
			WHERE inputs.unit IN(?) AND type='transfer' AND asset IS NULL", 
			[arrUnits], 
			rows => {
				rows.forEach(row => {
					if (!assocMcisByAddress[row.address] || assocMcisByAddress[row.address] < row.main_chain_index)
						assocMcisByAddress[row.address] = row.main_chain_index;
				});
				let arrSrcUnits = rows.map(row => row.src_unit);
				(depth < MAX_REFERRAL_DEPTH) ? goBack(arrSrcUnits) : selectReferrer();
			}
		);
	}
	
	function selectReferrer(){
		let arrAddresses = Object.keys(assocMcisByAddress);
		console.log('ancestor addresses: '+arrAddresses.join(', '));
		db.query(
			"SELECT address, user_address, device_address, payload, app \n\
			FROM attestations \n\
			JOIN messages USING(unit, message_index) \n\
			JOIN attestation_units ON unit=attestation_unit AND attestation_type='real name' \n\
			JOIN transactions USING(transaction_id) \n\
			JOIN receiving_addresses USING(receiving_address) \n\
			WHERE address IN("+arrAddresses.map(db.escape).join(', ')+") AND +attestor_address=? AND transactions.payment_unit!=?", 
			[realNameAttestation.assocAttestorAddresses['real name'], payment_unit],
			rows => {
				if (rows.length === 0){
					console.log("no referrers for payment unit "+payment_unit);
					return handleReferrer();
				}
				let max_mci = 0;
				let best_user_id, best_row;
				rows.forEach(row => {
					if (row.app !== 'attestation')
						throw Error("unexpected app "+row.app+" for payment "+payment_unit);
					if (row.address !== row.user_address)
						throw Error("different addresses: address "+row.address+", user_address "+row.user_address+" for payment "+payment_unit);
					let payload = JSON.parse(row.payload);
					if (payload.address !== row.address)
						throw Error("different addresses: address "+row.address+", payload "+row.user_address+" for payment "+payment_unit);
					let user_id = payload.profile.user_id;
					if (!user_id)
						throw Error("no user_id for payment "+payment_unit);
					let mci = assocMcisByAddress[row.address];
					if (mci > max_mci){
						max_mci = mci;
						best_row = row;
						best_user_id = user_id;
					}
				});
				if (!best_row || !best_user_id)
					throw Error("no best for payment "+payment_unit);
				handleReferrer(best_user_id, best_row.user_address, best_row.device_address);
			}
		);
	}

	goBack([payment_unit]);
}


exports.sendAndWriteReward = sendAndWriteReward;
exports.retrySendingRewards = retrySendingRewards;
exports.findReferrer = findReferrer;

