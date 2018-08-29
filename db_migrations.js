/*jslint node: true */
'use strict';
const db = require('byteballcore/db');

module.exports = function() {
	return new Promise(resolve => {
		db.takeConnectionFromPool(function(connection) {
			connection.query(
				"SELECT name FROM sqlite_master WHERE type='table' AND name='vouchers'", 
				[], 
				rows => {
					if (rows.length) {
						connection.release();
						return resolve();
					}
					let arrQueries = [];
					connection.addQuery(arrQueries, `BEGIN TRANSACTION`);
					connection.addQuery(arrQueries, `CREATE TABLE vouchers (
							voucher_id INTEGER NOT NULL PRIMARY KEY,
							user_address CHAR(32) NOT NULL,
							device_address CHAR(33) NOT NULL,
							receiving_address CHAR(32) NOT NULL,
							voucher CHAR(20) NOT NULL,
							usage_limit INT NOT NULL DEFAULT 3,
							amount INT NOT NULL DEFAULT 0,
							amount_deposited INT NOT NULL DEFAULT 0,
							creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
							FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
						)`);
					connection.addQuery(arrQueries, `CREATE INDEX byVoucher ON vouchers(voucher)`);
					connection.addQuery(arrQueries, `CREATE TABLE voucher_transactions (
						voucher_id INT NOT NULL,
						transaction_id INT NULL,
						amount INT NOT NULL,
						creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
						unit CHAR(44) NULL UNIQUE,
						FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id),
						FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
						FOREIGN KEY (unit) REFERENCES units(unit)
					)`);
					connection.addQuery(arrQueries, `CREATE TABLE transactions_new (
						transaction_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
						receiving_address CHAR(32) NOT NULL,
						price INT NOT NULL,
						received_amount INT NOT NULL,
						payment_unit CHAR(44) NULL UNIQUE,
						payment_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
						is_confirmed INT NOT NULL DEFAULT 0,
						confirmation_date TIMESTAMP NULL,
						scanReference CHAR(20) NULL UNIQUE,
						authorizationToken VARCHAR(36) NULL,
						jumioIdScanReference VARCHAR(36) NULL UNIQUE,
						scan_result TINYINT NULL, -- 1 success, 0 failure, NULL pending or abandoned
						result_date TIMESTAMP NULL,
						extracted_data VARCHAR(4096) NULL, -- json, nulled after posting the attestation unit
						voucher_id INT NULL,
						FOREIGN KEY (receiving_address) REFERENCES receiving_addresses(receiving_address),
						FOREIGN KEY (payment_unit) REFERENCES units(unit) ON DELETE CASCADE,
						FOREIGN KEY (voucher_id) REFERENCES vouchers(voucher_id) ON DELETE CASCADE
					)`);
					connection.addQuery(arrQueries, `INSERT INTO transactions_new SELECT *, NULL FROM transactions`);
					connection.addQuery(arrQueries, `DROP TABLE transactions`);
					connection.addQuery(arrQueries, `ALTER TABLE transactions_new RENAME TO transactions`);
					connection.addQuery(arrQueries, `COMMIT`);
					require('async').series(arrQueries, function(){
						connection.release();
						resolve();
					});
				}
			);
		});
	});
}