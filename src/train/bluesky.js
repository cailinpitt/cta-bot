const shared = require('../shared/bluesky');

function loginTrain() {
  return shared.login(process.env.BLUESKY_TRAIN_IDENTIFIER, process.env.BLUESKY_TRAIN_APP_PASSWORD);
}

module.exports = { loginTrain, ...shared };
