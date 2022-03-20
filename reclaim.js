/*jslint node: true */
"use strict";

const db = require('ocore/db');
const eventBus = require('ocore/event_bus.js');
const headlessWallet = require('headless-obyte');


async function reclaim() {
	const device = require('ocore/device.js');
	const address = await headlessWallet.issueOrSelectAddressByIndex(0, 2);
	console.error(`=== dist address`, address);
	const rows = await db.query(
		`SELECT contract_address, SUM(amount) AS total 
		FROM contracts
		CROSS JOIN outputs ON contract_address=address AND is_spent=0 AND asset IS NULL
		WHERE contract_date < '2020-03-20'
		GROUP BY contract_address
		HAVING total > 0`
	);
	console.error(`=== ${rows.length} contracts`);
	const contract_addresses = rows.map(r => r.contract_address);
	let opts = {
		asset: null,
		change_address: address,
		to_address: address,
		send_all: true,
		arrSigningDeviceAddresses: [device.getMyDeviceAddress()],
	};
	while (true) {
		const addresses_chunk = contract_addresses.splice(0, 16);
		if (addresses_chunk.length === 0) {
			console.error(`no more addresses left`);
			break;
		}
		console.error(`will reclaim from`, addresses_chunk);
		opts.paying_addresses = addresses_chunk;
		const { unit } = await headlessWallet.sendMultiPayment(opts);
		console.error(`sent`, unit);
	}
}


eventBus.once('headless_wallet_ready', reclaim);
process.on('unhandledRejection', up => { throw up; });
