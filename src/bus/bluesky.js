const shared = require('../shared/bluesky');

function loginBus() {
  return shared.login(process.env.BLUESKY_BUS_IDENTIFIER, process.env.BLUESKY_BUS_APP_PASSWORD);
}

module.exports = { loginBus, ...shared };
