/*jslint node: true */
'use strict';
const conf = require('ocore/conf');
const objectHash = require('ocore/object_hash.js');
const db = require('ocore/db');
const constants = require('ocore/constants');
const notifications = require('./notifications');
const smartidApi = require('./smartid_api.js');
const jumioApi = require('./jumio_api.js');
const countries = require("i18n-iso-countries");
const moment = require('moment');

var assocAttestorAddresses = {};
var bJsonBased = (constants.version !== constants.versionWithoutTimestamp);


function convertCountry3to2(country3){
	let country2 = countries.alpha3ToAlpha2(country3);
	if (!country2)
		throw Error("no 2-letter country code of "+country3);
	return country2;
}

function getUserId(profile){
	let shortProfile = {
		first_name: profile.first_name,
		last_name: profile.last_name,
		dob: profile.dob,
		country: profile.country,
	};
	return objectHash.getBase64Hash([shortProfile, conf.salt]);
}

function getAttestationPayloadAndSrcProfile(user_address, data, service_provider){
	let cb_data;
	if (service_provider === 'eideasy') {
		cb_data = data.status ? smartidApi.convertRestResponseToCallbackFormat(data) : data;
	}
	else {
		cb_data = data.transaction ? jumioApi.convertRestResponseToCallbackFormat(data) : data;
	}
	let profile = {
		first_name: cb_data.idFirstName,
		last_name: cb_data.idLastName,
		dob: cb_data.idDob,
		country: String(cb_data.idCountry).length === 3 ? convertCountry3to2(cb_data.idCountry) : cb_data.idCountry,
		us_state: cb_data.idUsState,
		personal_code: cb_data.personalCode,
		id_number: cb_data.idNumber,
		id_type: cb_data.idType,
		id_subtype: cb_data.idSubtype,
		id_expiry: cb_data.idExpiry ? moment(cb_data.idExpiry).format('YYYY-MM-DD') : '',
		id_issued_at: cb_data.idIssuedAt ? moment(cb_data.idIssuedAt).format('YYYY-MM-DD') : ''
	};
	console.log(profile);
	Object.keys(profile).forEach(function(key){
		if (!profile[key])
			delete profile[key];
	});
	if (!Object.keys(profile).length) {
		console.error(cb_data);
	}

	var [public_profile, src_profile] = hideProfile(profile);
	let attestation = {
		address: user_address,
		profile: public_profile
	};
	return [attestation, src_profile];
}

function getNonUSAttestationPayload(user_address){
	let attestation = {
		address: user_address,
		profile: {
			nonus: 1
		}
	};
	return attestation;
}

function hideProfile(profile){
	let composer = require('ocore/composer.js');
	let hidden_profile = {};
	let src_profile = {};
	for (let field in profile){
		let value = profile[field];
		let blinding = composer.generateBlinding();
		let hidden_value = objectHash.getBase64Hash([value, blinding], bJsonBased);
		hidden_profile[field] = hidden_value;
		src_profile[field] = [value, blinding];
	}
	let profile_hash = objectHash.getBase64Hash(hidden_profile, bJsonBased);
	let user_id = getUserId(profile);
	let public_profile = {
		profile_hash: profile_hash,
		user_id: user_id
	};
	return [public_profile, src_profile];
}

function postAttestation(attestor_address, payload, onDone){
	function onError(err){
		notifications.notifyAdmin("attestation failed", err);
		console.error(err);
		onDone(err);
	}
	var network = require('ocore/network.js');
	var composer = require('ocore/composer.js');
	let headlessWallet = require('headless-obyte');
	let objMessage = {
		app: "attestation",
		payload_location: "inline",
		payload: payload
	};
	
	let params = {
		paying_addresses: [attestor_address], 
		outputs: [{address: attestor_address, amount: 0}],
		messages: [objMessage],
		signer: headlessWallet.signer, 
		callbacks: composer.getSavingCallbacks({
			ifNotEnoughFunds: onError,
			ifError: onError,
			ifOk: function(objJoint){
				network.broadcastJoint(objJoint);
				onDone(null, objJoint.unit.unit);
			}
		})
	};
	if (conf.bPostTimestamp && attestor_address === assocAttestorAddresses['jumio']){
		let timestamp = Date.now();
		let datafeed = {timestamp: timestamp};
		let objTimestampMessage = {
			app: "data_feed",
			payload_location: "inline",
			payload: datafeed
		};
		params.messages.push(objTimestampMessage);
	}
	composer.composeJoint(params);
}

function postAndWriteAttestation(transaction_id, attestation_type, attestor_address, attestation_payload, src_profile){
	const mutex = require('ocore/mutex.js');
	mutex.lock(['tx-'+transaction_id], unlock => {
		db.query(
			"SELECT device_address, attestation_date \n\
			FROM attestation_units JOIN transactions USING(transaction_id) JOIN receiving_addresses USING(receiving_address) \n\
			WHERE transaction_id=? AND attestation_type=?", 
			[transaction_id, attestation_type], 
			rows => {
				let row = rows[0];
				if (row.attestation_date) // already posted
					return unlock();
				postAttestation(attestor_address, attestation_payload, (err, unit) => {
					if (err)
						return unlock();
					db.query(
						"UPDATE attestation_units SET attestation_unit=?, attestation_date="+db.getNow()+" WHERE transaction_id=? AND attestation_type=?", 
						[unit, transaction_id, attestation_type], 
						() => {
							// extracted_data is nulled in service_helper.cleanExtractedData()
							let device = require('ocore/device.js');
							let explorer = (process.env.testnet ? 'https://testnetexplorer.obyte.org/#' : 'https://explorer.obyte.org/#');
							let text = (attestation_type === 'real name') ? "Now your real name is attested" : "Now you are attested as non-US citizen";
							text += `, see the attestation unit: ${explorer}${unit}`;
							if (src_profile){
								let private_profile = {
									unit: unit,
									payload_hash: objectHash.getBase64Hash(attestation_payload, bJsonBased),
									src_profile: src_profile
								};
								let base64PrivateProfile = Buffer.from(JSON.stringify(private_profile)).toString('base64');
								text += "\n\nClick here to save the profile in your wallet: [private profile](profile:"+base64PrivateProfile+").  You will be able to use it to access the services that require a proven identity.";
							}
							if (attestation_type === 'real name')
								text += `\n\nRemember, we have a referral program: if you send Bytes from your attested address to a new user who is not attested yet, and he/she uses those Bytes to pay for a successful attestation, you receive a $${conf.contractReferralRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})} reward in Bytes paid to your smart contract address.\nYou can also create a smart voucher and deposit funds to it, then share the voucher code to unlimited number of users and receive rewards for every user whose attestation was paid with your smart voucher: [new voucher](command:new voucher)`;
							device.sendMessageToDevice(row.device_address, 'text', text);
							unlock();
						}
					);
				});
			}
		);
	});
}

function retryPostingAttestations(){
	db.query(
		"SELECT transaction_id, extracted_data, service_provider, user_address, attestation_type \n\
		FROM attestation_units JOIN transactions USING(transaction_id) JOIN receiving_addresses USING(receiving_address) \n\
		WHERE attestation_unit IS NULL", 
		rows => {
			rows.forEach(row => {
				let attestation, src_profile;
				if (row.attestation_type === 'real name') {
					[attestation, src_profile] = getAttestationPayloadAndSrcProfile(row.user_address, JSON.parse(row.extracted_data), row.service_provider);
					postAndWriteAttestation(row.transaction_id, row.attestation_type, assocAttestorAddresses[row.service_provider === 'eideasy' ? 'eideasy' : 'jumio'], attestation, src_profile);
				}
				else {
					attestation = getNonUSAttestationPayload(row.user_address);
					postAndWriteAttestation(row.transaction_id, row.attestation_type, assocAttestorAddresses[row.attestation_type], attestation, src_profile);
				}
			});
		}
	);
}


exports.assocAttestorAddresses = assocAttestorAddresses;
exports.getAttestationPayloadAndSrcProfile = getAttestationPayloadAndSrcProfile;
exports.getNonUSAttestationPayload = getNonUSAttestationPayload;
exports.postAndWriteAttestation = postAndWriteAttestation;
exports.retryPostingAttestations = retryPostingAttestations;

