/*jslint node: true */
'use strict';
const desktopApp = require('byteballcore/desktop_app.js');
const conf = require('byteballcore/conf.js');
const conversion = require('./conversion.js');


exports.greeting = () => {
	let objSteemDiscount = conf.discounts['JEDZYC2HMGDBIDQKG3XSTXUSHMCBK725'].discount_levels[0];
	return "Here you can attest your real name.\n\nYour real name and other personal information (date of birth, document number, country, etc) will be saved privately in your wallet, only a proof of attestation will be posted publicly on the distributed ledger. The very fact of being attested may give you access to some services or tokens, even without disclosing your real name. Some apps may request you to reveal some of the fields of your attested profile, you choose what to reveal and to which app.\n\nIf you are a non-US citizen, we will offer you to attest this fact, this information is always public. This is useful for participation in some ICOs which restrict access to their tokens only to non-US citizens.\n\nIf you are an attested Steem user with reputation over "+objSteemDiscount.reputation+", you get a "+objSteemDiscount.discount+"% discount from the attestation price.\n\nAfter you successfully verify yourself for the first time, you receive reward in Bytes which consists of two parts: the refunded attestation fee, which is immediately spendable while $"+conf.contractRewardInUSD.toLocaleString([], {minimumFractionDigits: 2})+" is locked on a smart contract that can be spent after "+conf.contractTerm+" year.";
};

exports.attestNonUS = () => {
	return "You are a non-US citizen. Do you want this fact to be also attested?  This information will be public, i.e. everybody will be able to see that your Byteball address belongs to a non-US citizen, but nothing else will be disclosed.\n\n[Yes, attest that I'm a non-US citizen](command:attest non-US)";
};

exports.depositVoucher = (voucher = 'XXXXXXXXX', amount = conf.priceInUSD) => {
	return `To deposit your smart voucher ${voucher} for e.g. $${amount}, send a message using the following format: [deposit ${voucher} ${amount}](suggest-command:deposit ${voucher} ${amount}). Remember that each verification costs $${conf.priceInUSD} and bytes price is volatile, so safeguard your smart voucher by depositing a bit more. You can withdraw the deposited amount from the smart voucher at any time.`;
};

exports.voucherDeposited = (voucher, amount) => {
	const bytes_price = conversion.getPriceInBytes(conf.priceInUSD);
	return `Your payment is confirmed. Now the balance of voucher ${voucher} is ${(amount/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB which is enough for ${Math.floor(amount / bytes_price)} attestations at the current exchange rate. Send the voucher to your friends to help them get attested and earn referral rewards. The rewards will be paid back to your voucher and you can later withdraw them.`;
};

exports.listVouchers = (user_address, vouchers) => {
	let result = `Your smart vouchers:\n\n`;
	const usd_price = conversion.getPriceInBytes(1);
	for (let voucherInfo of vouchers) {
		let usd_amount = (voucherInfo.amount / usd_price).toLocaleString([], {minimumFractionDigits: 2, maximumFractionDigits: 2});
		let gb_amount = (voucherInfo.amount/1e9).toLocaleString([], {maximumFractionDigits: 9});
		result += `${voucherInfo.voucher} – ${gb_amount} GB ($${usd_amount})\n[deposit...](command:deposit ${voucherInfo.voucher}) | [withdraw...](command:withdraw ${voucherInfo.voucher})\n\n`;
	}
	return result;
};

exports.noVouchers = () => {
	return `You currently have no vouchers. [Create one](command:new voucher)?`;
};

exports.withdrawVoucher = (voucherInfo) => {
	const gb_amount = (voucherInfo.amount/1e9).toLocaleString([], {maximumFractionDigits: 9});
	const deposited_amount = (voucherInfo.amount_deposited/1e9).toLocaleString([], {maximumFractionDigits: 9});
	return `Smart voucher balance is ${gb_amount} GB, you have deposited ${deposited_amount} GB to this smart voucher and can claim it back to your wallet instantly. If you want to withdraw more than that, the amount exceeding ${deposited_amount} GB will be sent to your contract, as it is your referrer reward. Click and edit the command: [withdraw ${voucherInfo.voucher} ${deposited_amount}](suggest-command:withdraw ${voucherInfo.voucher} ${deposited_amount})`;
};

exports.withdrawComplete = (bytes = 0, contract_bytes = 0, voucherInfo) => {
	let gb = (bytes/1e9).toLocaleString([], {maximumFractionDigits: 9});
	let contract_gb = (contract_bytes/1e9).toLocaleString([], {maximumFractionDigits: 9});
	return `We sent you a total of ${+gb+(+contract_gb)} GB from your smart voucher ${voucherInfo.voucher}. ` + (gb ? `${gb} GB was sent to your address ${voucherInfo.user_address}` : ``) + (contract_gb ? `${(gb && contract_gb ? ` and`:'')} ${contract_gb} GB was sent to your contract.` : ``);
};

exports.limitVoucher = (voucher = 'XXXXXXXXX', amount = 2) => {
	return `To limit number of smart voucher uses per device, send a message using the following format: [limit ${voucher} ${amount+1}](suggest-command:limit ${voucher} ${amount+1}). Current limit: ${amount}`;
};

exports.payToVoucher = (receiving_address, voucher, price, user_address) => {
	return `Please pay ${(price/1e9).toLocaleString([], {maximumFractionDigits: 9})} GB to deposit your smart voucher ${voucher}: [deposit voucher](byteball:${receiving_address}?amount=${price})`;
};

exports.vouchersHelp = () => {
	return `Available smart voucher commands:\n
[new voucher](command:new voucher) - issues new smart voucher
[vouchers](command:vouchers) - list your smart vouchers
[deposit XXXXXXXXX 0.2](command:deposit) - make a deposit to your smart voucher XXXXXXXXX
[limit XXXXXXXXX 3](command:limit) - limits number of uses of your voucher XXXXXXXXX per device
[withdraw XXXXXXXXX 0.2](command:withdraw) - withdraw funds accumulated on smart voucher XXXXXXXXX`;
}

exports.signMessage = (user_address, voucher_code) => {
	return `I'm going to attest my address ${user_address}. Paying with smart voucher ${voucher_code}`;
}

exports.alreadyHasAttestation = () => {
	return `You have already been attested or attestation is in progress`;
}

exports.goingToAttest = (user_address) => {
	return `Thanks, going to attest your address ${user_address}. Your personal data will be kept private and stored in your wallet.`;
}

exports.welcomeProviders = (service_provider) => {
	let jumioSelected = service_provider === 'jumio' ? exports.selectedOption() : '';
	let smartidSelected = service_provider === 'smartid' ? exports.selectedOption() : '';
	let jumioPrice = conf.priceInUSD.toLocaleString([], {minimumFractionDigits: 2});
	let smartidPrice = conf.priceInUSDforSmartID.toLocaleString([], {minimumFractionDigits: 2});
	return `Please select an attestation service provider:

[Jumio Netverify](command:jumio) ${jumioSelected}
Jumio Netverify is available worldwide. It uses your webcam to take photos of your passport, ID card, or driver license and it costs $${jumioPrice} per attempt.

[Smart ID Estonia](command:smartid) ${smartidSelected}
Smart ID Estonia is available for residents of Estonia, Latvia, Lithuania and e-residents of Estonia. You can use ID-card, Mobile-ID, Smart-ID and it costs $${smartidPrice} per attempt.`;
}

exports.providerJumio = () => {
	return "After payment, you will be redirected to Jumio website for your document (ID card, driver's licence, passport) verification. Your device must have a high quality camera to make photos of your face and your document. Have your document ready before payment and make sure there is enough light in your room, the document must have your name printed in Latin characters.\n\nThe price of attestation is $"+conf.priceInUSD.toLocaleString([], {minimumFractionDigits: 2})+". The payment is nonrefundable even if the attestation fails for any reason.";
}

exports.providerSmartID = () => {
	return "After payment, you will be redirected to Smart ID Estonia website for authentication. You need to authenticate with ID-card, Mobile-ID or Smart-ID (available for residents of Estonia, Latvia, Lithuania and e-residents of Estonia).\n\nThe price of attestation is $"+conf.priceInUSDforSmartID.toLocaleString([], {minimumFractionDigits: 2})+". The payment is nonrefundable even if the attestation fails for any reason.";
}

exports.selectedOption = () => {
	return `(selected)`;
};
/*
exports.selectProvider = (service_provider) => {
	let jumioSelected = service_provider === 'jumio' ? exports.selectedOption() : '';
	let smartidSelected = service_provider === 'smartid' ? exports.selectedOption() : '';
	return `Please select an attestation service provider:
	* [Jumio Netverify](command:jumio) ${jumioSelected}
	* [Smart ID Estonia](command:smartid) ${smartidSelected}`;
};

exports.orPay = () => {
	return `or pay for the attestation.`;
};
*/

function displayProvider(service_provider){
	let jumioSelected = service_provider === 'jumio' ? exports.selectedOption() : '';
	let smartidSelected = service_provider === 'smartid' ? exports.selectedOption() : '';
	return `Currently selected attestation service provider:
	* [Jumio Netverify](command:jumio) ${jumioSelected}
	* [Smart ID Estonia](command:smartid) ${smartidSelected}`;
}

exports.pleasePayOrProvider = (receiving_address, price, user_address, service_provider, objDiscountedPriceInUSD, have_attestation) => {
	return (service_provider === null) ? exports.welcomeProviders() : displayProvider(service_provider) + "\n\n" + exports.pleasePay(receiving_address, price, user_address, objDiscountedPriceInUSD, have_attestation);
};

exports.pleasePay = (receiving_address, price, user_address, objDiscountedPriceInUSD, have_attestation) => {
	let text = `Click to pay: [attestation payment](byteball:${receiving_address}?amount=${price}&single_address=single${user_address})`;
	if (!have_attestation)
		text += ` or if you have a smart voucher, insert it below.`;
	if (objDiscountedPriceInUSD && objDiscountedPriceInUSD.discount)
		text += ` (you were given a ${objDiscountedPriceInUSD.discount}% discount as a ${objDiscountedPriceInUSD.domain} user with ${objDiscountedPriceInUSD.field} over ${objDiscountedPriceInUSD.threshold_value})`;
	text += ".";
	return text;
};

exports.insertMyAddress = () => {
	return "Please send me your address that you wish to attest (click ... and Insert my address). Make sure you are in a single-address wallet. If you don't have a single-address wallet, please add one (burger menu, add wallet) and fund it with the amount sufficient to pay for the attestation.";
};

exports.underWay = () => {
	return "Received your payment and your attestation is under way. Please wait, we'll notify you when it is finished.";
};

exports.switchToSingleAddress = () => {
	return "Make sure you are in a single-address wallet, otherwise switch to a single-address wallet or create one and send me your address before paying.";
};

exports.alreadyAttested = (attestation_date) => {
	return "You were already attested at "+attestation_date+" UTC. Attest [same address again](command: again) or insert another address.";
};

exports.alreadyAttestedInUnit = (attestation_unit) => {
	let explorer = (conf.hub == 'byteball.org/bb-test' ? 'https://testnetexplorer.byteball.org/#' : 'https://explorer.byteball.org/#');
	return `You were already attested in ${explorer}${attestation_unit}`;
};

exports.previousAttestationFailed = () => {
	return "Your previous attestation failed. Try [again](command: again)?";
};

exports.pleaseDonate = () => {
	let amount = (conf.rewardInUSD + conf.contractRewardInUSD).toLocaleString([], {minimumFractionDigits: 2});
	return "You now have an option to donate $"+amount+" to the Byteball Community Fund. The donation is used to pay for initiatives to increase adoption. The donation will be made from the undistributed funds on behalf of you. Your decision will not affect your reward. Do you wish to donate $"+amount+"? \n\n[Yes](command:donate yes)\t[No](command:donate no)\n\nSee https://medium.com/byteball/distribution-to-verified-users-and-referrals-episode-ii-29b6f1cd4ecc to learn what donations are used for.";
};

exports.referredNewUser = (reward_text) => {
	return "You referred a user who has just verified his identity "+reward_text+". Thank you for bringing in a new byteballer, the value of the ecosystem grows with each new user!";
}

//errors
exports.errorInitSql = () => {
	return 'please import db.sql file\n';
};

exports.errorEmail = () => {
	return `please specify admin_email and from_email in your ${desktopApp.getAppDataDir()}/conf.json\n`;
};
