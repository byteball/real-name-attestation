# Real Name Attestation Bot
A bot that attests the user's passport or ID card data.

# Inital setup
* Have at least Node 8 installed.
* Go into project folder.
* Run `npm install` to install node modules.
* Download "GeoLite2 Country" [MaxMind DB](https://dev.maxmind.com/geoip/geoip2/geolite2/), unzip it and extract `GeoLite2-Country.mmdb` into parent folder.
* Run `node attestation.js` first time to generate keys.
* Configure `admin_email`, `from_email`, `salt` and `webPort` values in new conf.json file (desktopApp.getAppDataDir() folder). Read more about other configuration options [there](https://github.com/byteball/headless-obyte#customize).
* Run `node db_import.js` to import `db.sql` into the database and appling database migrations.
* Send bytes to `== distribution address`, which is displayed in logs, it is for rewards and referral bonuses.
* Setup Nginx on `webPort` that you set.
* Run `node attestation.js` again.

# Testnet
* Run `cp .env.testnet .env` to connect to TESTNET hub. Delete and import the database again if you already ran it on MAINNET.
* Change `bLight` value to true in conf.json file, so you would not need to wait for long syncing.
* Change `socksHost` and `socksPort` values to null in conf.json file, if you are not using TOR.
