/*jslint node: true */
'use strict';
const async = require('async');
const request = require('request');
const conf = require('ocore/conf');
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const notifications = require('./notifications');

//var GBYTE_BTC_rate;
//var BTC_USD_rate;

var bRatesReady = false;
eventBus.once('rates_updated', () => {
	bRatesReady = true;
	checkRatesAndHeadless();
});
/*
function checkAllRatesUpdated(){
	if (bRatesReady)
		return;
	if (GBYTE_BTC_rate && BTC_USD_rate){
		bRatesReady = true;
		console.log('rates are ready');
		const headlessWallet = require('headless-obyte'); // start loading headless only when rates are ready
		checkRatesAndHeadless();
	}
}
*/

var bHeadlessReady = false;
eventBus.once('headless_wallet_ready', () => {
	bHeadlessReady = true;
	checkRatesAndHeadless();
});

function checkRatesAndHeadless(){
	if (bRatesReady && bHeadlessReady)
		eventBus.emit('headless_and_rates_ready');
}


/*
function updateBittrexRates(){
	console.log('updating bittrex');
	const apiUri = 'https://bittrex.com/api/v1.1/public/getmarketsummaries';
	request(apiUri, function (error, response, body){
		if (!error && response.statusCode == 200) {
			try {
				var arrCoinInfos = JSON.parse(body).result;
			}
			catch (e) {
				return console.log(e.toString());
			}
			if (!arrCoinInfos)
				return console.log('bad rates from bittrex');
			arrCoinInfos.forEach(coinInfo => {
				let price = coinInfo.Last; // number
				if (!price)
					return;
				if (coinInfo.MarketName === 'USDT-BTC')
					BTC_USD_rate = price;
				else if (coinInfo.MarketName === 'BTC-GBYTE')
					GBYTE_BTC_rate = price;
			});
			checkAllRatesUpdated();
		}
		else{
			notifications.notifyAdmin("getting bittrex data failed", error+", status="+(response ? response.statusCode : '?'));
			console.log("Can't get currency rates from bittrex, will retry later");
		}
	});
}
*/

function getPriceInBytes(priceInUSD){
	const rates = network.exchangeRates;
	if (!rates.GBYTE_USD)
		throw Error("rates not ready yet");
	return Math.round(1e9 * priceInUSD / rates.GBYTE_USD);
}
/*
function enableRateUpdates(){
	setInterval(updateBittrexRates, 600*1000);
}

updateBittrexRates();
enableRateUpdates();
*/

exports.getPriceInBytes = getPriceInBytes;

