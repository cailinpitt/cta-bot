// Tiny harness shared by bin entrypoints. Covers the repetitive boilerplate
// — asset pruning, history rolloff, dry-run image writing, and the top-level
// crash handler — without trying to abstract the detection/post flow itself,
// since each job's middle section is meaningfully different.

const Fs = require('fs-extra');
const Path = require('path');
const { pruneOldAssets } = require('./cleanup');
const history = require('./history');

const ASSETS_DIR = Path.join(__dirname, '..', '..', 'assets');

function setup() {
  pruneOldAssets();
  history.rolloffOld();
}

function writeDryRunAsset(buffer, filename) {
  const outPath = Path.join(ASSETS_DIR, filename);
  Fs.ensureDirSync(Path.dirname(outPath));
  Fs.writeFileSync(outPath, buffer);
  return outPath;
}

function runBin(main) {
  main().catch((e) => {
    console.error(e.stack || e);
    process.exit(1);
  });
}

module.exports = { setup, writeDryRunAsset, runBin };
