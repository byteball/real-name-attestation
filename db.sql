CREATE TABLE IF NOT EXISTS users (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	user_address CHAR(32) NULL,
	service_provider CHAR(20) NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
-- query separator
CREATE TABLE IF NOT EXISTS receiving_addresses (
	receiving_address CHAR(32) NOT NULL PRIMARY KEY,
	device_address CHAR(33) NOT NULL,
	user_address CHAR(32) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	post_publicly TINYINT NULL,
	price INT NULL,
	last_price_date TIMESTAMP NULL,
	service_provider CHAR(20) NULL,
	UNIQUE (device_address, user_address, service_provider),
	-- FOREIGN KEY (device_address, user_address) REFERENCES users(device_address, user_address),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (receiving_address) REFERENCES my_addresses(address)
);
-- query separator
CREATE INDEX IF NOT EXISTS byReceivingAddress ON receiving_addresses(receiving_address);
-- query separator
CREATE INDEX IF NOT EXISTS byUserAddress ON receiving_addresses(user_address);
-- query separator
CREATE TABLE IF NOT EXISTS vouchers (
	voucher CHAR(13) NOT NULL PRIMARY KEY,
	user_address CHAR(32) NOT NULL,
	device_address CHAR(33) NOT NULL,
	receiving_address CHAR(32) NOT NULL,
	usage_limit INT NOT NULL DEFAULT 2,
	amount INT NOT NULL DEFAULT 0,
	amount_deposited INT NOT NULL DEFAULT 0,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
-- query separator
CREATE TABLE IF NOT EXISTS transactions (
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
	jumioIdScanReference VARCHAR(64) NULL UNIQUE,
	scan_result TINYINT NULL, -- 1 success, 0 failure, NULL pending or abandoned
	result_date TIMESTAMP NULL,
	extracted_data VARCHAR(4096) NULL, -- json, nulled 1 week after posting the attestation unit
	voucher CHAR(13) NULL,
	signed_message TEXT NULL,
	FOREIGN KEY (receiving_address) REFERENCES receiving_addresses(receiving_address),
	FOREIGN KEY (payment_unit) REFERENCES units(unit) ON DELETE CASCADE,
	FOREIGN KEY (voucher) REFERENCES vouchers(voucher) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS byScanResult ON transactions(scan_result);
-- query separator
CREATE TABLE IF NOT EXISTS attestation_units (
	transaction_id INTEGER NOT NULL,
	attestation_type CHAR(20) NOT NULL,
	attestation_unit CHAR(44) NULL UNIQUE,
	attestation_date TIMESTAMP NULL,
	PRIMARY KEY (transaction_id, attestation_type),
	FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
	FOREIGN KEY (attestation_unit) REFERENCES units(unit)
);
-- query separator
CREATE TABLE IF NOT EXISTS rejected_payments (
	rejected_payment_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	receiving_address CHAR(32) NOT NULL,
	price INT NOT NULL,
	received_amount INT NOT NULL,
	delay INT NOT NULL,
	payment_unit CHAR(44) NOT NULL UNIQUE,
	payment_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	error TEXT NOT NULL,
	FOREIGN KEY (receiving_address) REFERENCES receiving_addresses(receiving_address),
	FOREIGN KEY (payment_unit) REFERENCES units(unit) ON DELETE CASCADE
);
-- query separator
CREATE TABLE IF NOT EXISTS contracts (
	user_address CHAR(32) NOT NULL PRIMARY KEY,
	contract_address CHAR(32) NOT NULL UNIQUE,
	contract_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	contract_vesting_date TIMESTAMP NOT NULL,
	FOREIGN KEY (contract_address) REFERENCES shared_addresses(shared_address)
);
-- query separator
CREATE TABLE IF NOT EXISTS reward_units (
	transaction_id INTEGER NOT NULL PRIMARY KEY,
	device_address CHAR(33) NOT NULL UNIQUE,
	user_address CHAR(32) NOT NULL UNIQUE,
	user_id CHAR(44) NOT NULL UNIQUE,
	reward INT NOT NULL,
	contract_reward INT NOT NULL,
	reward_unit CHAR(44) NULL UNIQUE,
	reward_date TIMESTAMP NULL,
	donated TINYINT NULL,
	donation_unit CHAR(44) NULL,
	FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
	FOREIGN KEY (reward_unit) REFERENCES units(unit),
	FOREIGN KEY (donation_unit) REFERENCES units(unit)
);
-- query separator
CREATE TABLE IF NOT EXISTS referral_reward_units (
	transaction_id INTEGER NOT NULL PRIMARY KEY,
	user_address CHAR(32) NOT NULL,
	user_id CHAR(44) NOT NULL,
	new_user_id CHAR(44) NOT NULL UNIQUE,
	new_user_address CHAR(44) NOT NULL UNIQUE,
	reward INT NOT NULL,
	contract_reward INT NOT NULL,
	reward_unit CHAR(44) NULL UNIQUE,
	reward_date TIMESTAMP NULL,
	FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
	FOREIGN KEY (new_user_id) REFERENCES reward_units(user_id),
	FOREIGN KEY (reward_unit) REFERENCES units(unit)
);

/*
-- it is NULL because we already have records which would break uniqueness
ALTER TABLE reward_units ADD COLUMN device_address CHAR(33) NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reward_units_by_device_address ON reward_units(device_address);

CREATE TABLE IF NOT EXISTS contracts (
	user_address CHAR(32) NOT NULL PRIMARY KEY,
	contract_address CHAR(32) NOT NULL UNIQUE,
	contract_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	contract_vesting_date TIMESTAMP NOT NULL,
	FOREIGN KEY (contract_address) REFERENCES shared_addresses(shared_address)
);

ALTER TABLE reward_units ADD COLUMN contract_reward INT NULL;
ALTER TABLE referral_reward_units ADD COLUMN contract_reward INT NULL;

ALTER TABLE reward_units ADD COLUMN donated TINYINT NULL;
ALTER TABLE reward_units ADD COLUMN donation_unit CHAR(44) NULL;
CREATE INDEX IF NOT EXISTS reward_units_by_donation ON reward_units(donated, donation_unit);

*/
-- query separator
CREATE TABLE IF NOT EXISTS voucher_transactions (
	voucher CHAR(13) NOT NULL,
	transaction_id INT NULL,
	amount INT NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	unit CHAR(44) NULL UNIQUE,
	FOREIGN KEY (voucher) REFERENCES vouchers(voucher),
	FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
	FOREIGN KEY (unit) REFERENCES units(unit) ON DELETE CASCADE
);