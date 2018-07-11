/*jslint node: true */
'use strict';
const desktopApp = require('byteballcore/desktop_app.js');
const conf = require('byteballcore/conf.js');


exports.greeting = () => {
	let objSteemDiscount = conf.discounts['JEDZYC2HMGDBIDQKG3XSTXUSHMCBK725'].discount_levels[0];
	return "Here you can attest your real name.\n\nYour real name and other personal information (date of birth, document number, country, etc) will be saved privately in your wallet, only a proof of attestation will be posted publicly on the distributed ledger.  The very fact of being attested may give you access to some services or tokens, even without disclosing your real name.  Some apps may request you to reveal some of the fields of your attested profile, you choose what to reveal and to which app.\n\nYou may also choose to make all your attested data public.\n\nIf you are a non-US citizen, we will offer you to attest this fact, this information is always public.  This is useful for participation in some ICOs which restrict access to their tokens only to non-US citizens.\n\nThe price of attestation is $"+conf.priceInUSD.toLocaleString([], {minimumFractionDigits: 2})+".  The payment is nonrefundable even if the attestation fails for any reason.\n\nIf you are an attested Steem user with reputation over "+objSteemDiscount.reputation+", you get a "+objSteemDiscount.discount+"% discount from this price.\n\nAfter payment, you will be redirected to Jumio for the verification.  Your device must have a camera to make photos of your face and your ID.  Have your ID ready, the ID must have your name printed in Latin characters.\n\nAfter you successfully verify yourself for the first time, you receive a $"+(conf.rewardInUSD+conf.contractRewardInUSD).toLocaleString([], {minimumFractionDigits: 2})+" reward in Bytes which consists of two parts: $"+conf.rewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" is immediately spendable while $"+conf.contractRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" is locked on a smart contract that can be spent after "+conf.contractTerm+" year.";
};

exports.privateOrPublic = () => {
	return "Store your data privately in your wallet (recommended) or post it publicly?\n\n[private](command:private)\t[public](command:public)";
};

exports.attestNonUS = () => {
	return "You are a non-US citizen.  Do you want this fact to be also attested?  This information will be public, i.e. everybody will be able to see that your Byteball address belongs to a non-US citizen, but nothing else will be disclosed.\n\n[Yes, attest that I'm a non-US citizen](command:attest non-US)";
};

exports.pleasePay = (receiving_address, price, user_address, objDiscountedPriceInUSD) => {
	let text = "Please pay for the attestation: [attestation payment](byteball:"+receiving_address+"?amount="+price+"&single_address=single"+user_address+")";
	if (objDiscountedPriceInUSD && objDiscountedPriceInUSD.discount)
		text += ` (you were given a ${objDiscountedPriceInUSD.discount}% discount as a ${objDiscountedPriceInUSD.domain} user with ${objDiscountedPriceInUSD.field} over ${objDiscountedPriceInUSD.threshold_value})`;
	text += ".";
	return text;
};

exports.pleasePayOrPrivacy = (receiving_address, price, user_address, post_publicly, objDiscountedPriceInUSD) => {
	return (post_publicly === null) ? exports.privateOrPublic() : exports.pleasePay(receiving_address, price, user_address, objDiscountedPriceInUSD);
};

exports.insertMyAddress = () => {
	return "Please send me your address that you wish to attest (click ... and Insert my address).  Make sure you are in a single-address wallet.  If you don't have a single-address wallet, please add one (burger menu, add wallet) and fund it with the amount sufficient to pay for the attestation.";
};

exports.underWay = () => {
	return "Received your payment and your attestation is under way.  Please wait, we'll notify you when it is finished.";
};

exports.switchToSingleAddress = () => {
	return "Make sure you are in a single-address wallet, otherwise switch to a single-address wallet or create one and send me your address before paying.";
};

exports.alreadyAttested = (attestation_date) => {
	return "You were already attested at "+attestation_date+" UTC.  Attest [again](command: again)?";
};

exports.alreadyAttestedInUnit = (attestation_unit) => {
	return "You were already attested in https://explorer.byteball.org/#"+attestation_unit;
};

exports.previousAttestationFaled = () => {
	return "Your previous attestation failed.  Try [again](command: again)?";
};

exports.pleaseDonate = () => {
	let amount = (conf.rewardInUSD + conf.contractRewardInUSD).toLocaleString([], {minimumFractionDigits: 2});
	return "You now have an option to donate $"+amount+" to the Byteball Community Fund. The donation is used to pay for initiatives to increase adoption. The donation will be made from the undistributed funds on behalf of you. Your decision will not affect your reward. Do you wish to donate $"+amount+"? \n\n[Yes](command:donate yes)\t[No](command:donate no)\n\nSee https://medium.com/byteball/distribution-to-verified-users-and-referrals-episode-ii-29b6f1cd4ecc to learn what donations are used for.";
};

//errors
exports.errorInitSql = () => {
	return 'please import db.sql file\n';
};

exports.errorSmtp = () => {
	return `please specify smtpUser, smtpPassword and smtpHost in your ${desktopApp.getAppDataDir()}/conf.json\n`;
};

exports.errorEmail = () => {
	return `please specify admin_email and from_email in your ${desktopApp.getAppDataDir()}/conf.json\n`;
};
