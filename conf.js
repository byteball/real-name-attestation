/*jslint node: true */
"use strict";
exports.port = null;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;

exports.storage = 'sqlite';

// TOR is recommended.  If you don't run TOR, please comment the next two lines
exports.socksHost = '127.0.0.1';
exports.socksPort = 9050;

exports.hub = 'byteball.org/bb';
exports.deviceName = 'Real name attestation bot';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = [''];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.bIgnoreUnpairRequests = true;
exports.bSingleAddress = false;
exports.bStaticChangeAddress = true;
exports.KEYS_FILENAME = 'keys.json';

// smtp https://github.com/byteball/byteballcore/blob/master/mail.js
exports.smtpTransport = 'local'; // use 'local' for Unix Sendmail
exports.smtpRelay = '';
exports.smtpUser = '';
exports.smtpPassword = '';
exports.smtpSsl = null;
exports.smtpPort = null;

// email setup
exports.admin_email = '';
exports.from_email = '';

// witnessing
exports.bPostTimestamp = false;
exports.bRunWitness = false;
exports.THRESHOLD_DISTANCE = 20;
exports.MIN_AVAILABLE_WITNESSINGS = 100;

// jumio api credentials 
exports.apiToken = '';
exports.apiSecret = '';

// id.smartid.ee api credentials 
exports.apiSmartIdToken = '';
exports.apiSmartIdSecret = '';
exports.apiSmartIdCallback = 'http://localhost:8080/done';

exports.priceInUSD = 8;
exports.priceInUSDforSmartID = 0.5;
exports.contractRewardInUSD = 8;
exports.referralRewardInUSD = 0;
exports.contractReferralRewardInUSD = 10;
exports.donationInUSD = 16;
exports.bRefundAttestationFee = true;

exports.contractTerm = 1; // years
exports.contractUnclaimedTerm = 2; // years

exports.TIMESTAMPER_ADDRESS = 'I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'; // isTestnet ? 'OPNUXBRSSQQGHKQNEPD2GLWQYEUY5XLD' : 'I2ADHGP4HL6J37NQAD73J7E5SKFIXJOT'

exports.cf_address = 'ISQ6EG6V6V3R5BRCGJZVRYJ6PQQFQXH3';

exports.discounts = {
	JEDZYC2HMGDBIDQKG3XSTXUSHMCBK725: {
		domain: 'steem',
		discount_levels: [
			{reputation: 50, discount: 30},
		]
	},
};

// set this in conf.json
exports.salt = null;

exports.webPort = 8080;
