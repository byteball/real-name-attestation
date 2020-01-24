/*jslint node: true */
"use strict";
var async = require('async');
var db = require('ocore/db.js');
var eventBus = require('ocore/event_bus.js');
var headlessWallet = require('headless-obyte');

const announcement = "Obyte needs your help to get decentralized. The 4th independent order provider (also known as witness) will be selected in a poll. There are 3 candidates, read four new articles on our blog https://medium.com/obyte/decentralization/home Don’t stay indifferent, the faster we decentralize, the more likely we will be able to attract well known real world brands to the project! Suggestions of other witness candidates are also welcome on Obyte Discord, Reddit, or Telegram.";

//const optout_text = "\n\nIf you don't want to receive news here, [click here to opt out](command:optout).";
const message = announcement;// + optout_text;

headlessWallet.setupChatEventHandlers();

function sendAnnouncement(){
	var device = require('ocore/device.js');
	db.query(
		"SELECT device_address FROM users",
		rows => {
			console.error(rows.length+" messages will be sent");
			async.eachSeries(
				rows,
				(row, cb) => {
					device.sendMessageToDevice(row.device_address, 'text', message, {
						ifOk: function(){}, 
						ifError: function(){}, 
						onSaved: function(){
							console.log("sent to "+row.device_address);
							cb();
						}
					});
				},
				() => {
					console.error("=== done");
				}
			);
		}
	);
}

eventBus.on('text', function(from_address, text){
	var device = require('ocore/device.js');
	console.log('text from '+from_address+': '+text);
	text = text.trim().toLowerCase();
	/*if (text === 'optout'){
		db.query("INSERT "+db.getIgnore()+" INTO optouts (device_address) VALUES(?)", [from_address]);
		return device.sendMessageToDevice(from_address, 'text', 'You are unsubscribed from future announcements.');
	}
	else */if (text.match(/thank/))
		device.sendMessageToDevice(from_address, 'text', "You're welcome!");
	else
		device.sendMessageToDevice(from_address, 'text', "Usual operations are paused while sending announcements.  Check again in a few minutes.");
});

eventBus.on('headless_wallet_ready', () => {
	setTimeout(sendAnnouncement, 1000);
});

