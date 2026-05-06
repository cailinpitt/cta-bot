const test = require('node:test');
const assert = require('node:assert');
const { getDb } = require('../../src/shared/history');
const { recordTrainObservations, getLineCorridorBbox } = require('../../src/shared/observations');

const TEST_LINE = 'TEST_P';

function clear() {
  getDb().prepare("DELETE FROM observations WHERE kind = 'train' AND route = ?").run(TEST_LINE);
}

test('getLineCorridorBbox: excludeDestinations drops matching rows from bbox', () => {
  clear();
  const now = Date.now();
  recordTrainObservations(
    [
      // Loop-bound straggler well south of the shuttle corridor
      { rn: '101', line: TEST_LINE, trDr: '5', destination: 'Loop', lat: 41.879, lon: -87.628 },
      // Active shuttle observations
      { rn: '102', line: TEST_LINE, trDr: '1', destination: 'Linden', lat: 42.05, lon: -87.68 },
      { rn: '103', line: TEST_LINE, trDr: '5', destination: 'Howard', lat: 42.07, lon: -87.69 },
    ],
    now,
  );

  const unfiltered = getLineCorridorBbox(TEST_LINE, now - 60_000);
  assert.ok(unfiltered, 'expected a bbox');
  assert.equal(unfiltered.minLat, 41.879, 'unfiltered bbox includes Loop straggler');

  const filtered = getLineCorridorBbox(TEST_LINE, now - 60_000, {
    excludeDestinations: ['Loop'],
  });
  assert.ok(filtered, 'expected a bbox');
  assert.equal(filtered.minLat, 42.05, 'filtered bbox excludes Loop straggler');
  assert.equal(filtered.maxLat, 42.07);

  clear();
});

test('getLineCorridorBbox: NULL destinations are kept (unknown shouldn’t shrink corridor)', () => {
  clear();
  const now = Date.now();
  recordTrainObservations(
    [
      { rn: '201', line: TEST_LINE, trDr: '1', destination: null, lat: 41.9, lon: -87.63 },
      { rn: '202', line: TEST_LINE, trDr: '1', destination: 'Linden', lat: 42.05, lon: -87.68 },
    ],
    now,
  );

  const filtered = getLineCorridorBbox(TEST_LINE, now - 60_000, {
    excludeDestinations: ['Loop'],
  });
  assert.equal(filtered.minLat, 41.9, 'NULL destination row preserved in bbox');

  clear();
});
