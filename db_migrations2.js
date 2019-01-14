/*jslint node: true */
'use strict';
const db = require('byteballcore/db');

module.exports = function() {
	return new Promise(resolve => {
		db.takeConnectionFromPool(function(connection) {
			connection.query(
				"SELECT * FROM sqlite_master WHERE type='table' AND name='receiving_addresses' AND `sql` LIKE '%UNIQUE (device_address, user_address, service_provider)%';", 
				[], 
				rows => {
					if (rows.length) {
						connection.release();
						return resolve();
					}
					let arrQueries = [];
					connection.addQuery(arrQueries, `PRAGMA foreign_keys = OFF`);
					connection.addQuery(arrQueries, `BEGIN TRANSACTION`);
					connection.addQuery(arrQueries, `ALTER TABLE users ADD service_provider CHAR(20) NULL`);
					connection.addQuery(arrQueries, `CREATE TABLE receiving_addresses_new (
						receiving_address CHAR(32) NOT NULL PRIMARY KEY,
						device_address CHAR(33) NOT NULL,
						user_address CHAR(32) NOT NULL,
						creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
						post_publicly TINYINT NULL,
						price INT NULL,
						last_price_date TIMESTAMP NULL,
						service_provider CHAR(20) NULL,
						UNIQUE (device_address, user_address, service_provider),
						FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
						FOREIGN KEY (receiving_address) REFERENCES my_addresses(address)
					)`);
					connection.addQuery(arrQueries, `INSERT INTO receiving_addresses_new SELECT *, NULL FROM receiving_addresses`);
					connection.addQuery(arrQueries, `DROP TABLE receiving_addresses`);
					connection.addQuery(arrQueries, `ALTER TABLE receiving_addresses_new RENAME TO receiving_addresses`);
					connection.addQuery(arrQueries, `COMMIT`);
					connection.addQuery(arrQueries, `PRAGMA foreign_keys = ON`);
					require('async').series(arrQueries, function(){
						connection.release();
						resolve();
					});
				}
			);
		});
	});
}