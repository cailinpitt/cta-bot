// Central dotenv loader so bin scripts don't each spell out the path to .env.
// Require this from any bin entrypoint before touching process.env.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
