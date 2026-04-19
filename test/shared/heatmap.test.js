const test = require('node:test');
const assert = require('node:assert/strict');
const { bucket, resolveTrainStation } = require('../../src/shared/heatmap');

test('bucket groups events at the same coords and counts sources', () => {
  const events = [
    { near_stop: 'A', source: 'bunching' },
    { near_stop: 'A', source: 'gap' },
    { near_stop: 'A', source: 'gap' },
    { near_stop: 'B', source: 'bunching' },
  ];
  const resolve = (ev) => ev.near_stop === 'A'
    ? { lat: 41.9, lon: -87.6 }
    : { lat: 41.8, lon: -87.7 };
  const out = bucket(events, resolve);
  assert.equal(out.length, 2);
  assert.equal(out[0].label, 'A');
  assert.equal(out[0].count, 3);
  assert.equal(out[0].bunching, 1);
  assert.equal(out[0].gap, 2);
  assert.equal(out[1].label, 'B');
  assert.equal(out[1].count, 1);
});

test('bucket sorts by count descending', () => {
  const events = [
    { near_stop: 'Low', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
    { near_stop: 'High', source: 'gap' },
  ];
  const resolve = (ev) => ({ lat: ev.near_stop === 'High' ? 41 : 42, lon: -87 });
  const out = bucket(events, resolve);
  assert.equal(out[0].label, 'High');
  assert.equal(out[0].count, 3);
  assert.equal(out[1].label, 'Low');
});

test('bucket skips events that do not resolve to a location', () => {
  const events = [
    { near_stop: 'Known', source: 'gap' },
    { near_stop: 'Unknown', source: 'gap' },
  ];
  const resolve = (ev) => ev.near_stop === 'Known' ? { lat: 41, lon: -87 } : null;
  const out = bucket(events, resolve);
  assert.equal(out.length, 1);
  assert.equal(out[0].label, 'Known');
});

test('resolveTrainStation matches names across naming conventions', () => {
  // "Halsted" on Orange should resolve to "Halsted (Orange)" in trainStations.json.
  const loc = resolveTrainStation({ route: 'org', near_stop: 'Halsted' });
  assert.ok(loc);
  assert.ok(loc.name.toLowerCase().includes('halsted'));
  assert.ok(typeof loc.lat === 'number');
});

test('resolveTrainStation returns null for unknown station', () => {
  assert.equal(resolveTrainStation({ route: 'brn', near_stop: 'Not Real' }), null);
});
