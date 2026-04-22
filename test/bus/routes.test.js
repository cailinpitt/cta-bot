const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIndex } = require('../../src/shared/gtfs');
const { bunching, ghosts, gaps, speedmap } = require('../../src/bus/routes');

test('every polled bus route is present in the GTFS index', () => {
  const idx = loadIndex();
  const polled = [...new Set([...bunching, ...ghosts, ...gaps, ...speedmap])];
  const missing = polled.filter((r) => !idx.routes[r]);
  assert.deepEqual(missing, [], `re-run scripts/fetch-gtfs.js to index: ${missing.join(', ')}`);
});
