const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBusDominantOrigin, BUS_DOMINANCE_THRESHOLD } = require('../../scripts/fetch-gtfs');

function mkTrips(spec) {
  const tripMeta = new Map();
  const firstStopId = new Map();
  let n = 0;
  for (const { route, dir, origin, count, mode = 'bus' } of spec) {
    for (let i = 0; i < count; i++) {
      const id = `T${n++}`;
      tripMeta.set(id, { route, dir, mode });
      firstStopId.set(id, origin);
    }
  }
  return { tripMeta, firstStopId };
}

test('threshold constant is 60%', () => {
  assert.equal(BUS_DOMINANCE_THRESHOLD, 0.6);
});

test('dominance locks onto the main origin when it carries >=60% of trips', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '55', dir: '0', origin: 'MAIN', count: 80 },
    { route: '55', dir: '0', origin: 'GARAGE', count: 20 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('55|0'), 'MAIN');
});

test('dominance skips the key when the top origin is under 60% (keeps all origins)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '66', dir: '1', origin: 'A', count: 50 },
    { route: '66', dir: '1', origin: 'B', count: 50 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.has('66|1'), false);
});

test('rail trips are ignored entirely', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: 'Red', dir: '0', origin: 'HOWARD', count: 100, mode: 'rail' },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.size, 0);
});

test('exactly 60% qualifies (>= threshold, not strictly greater)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '77', dir: '0', origin: 'MAIN', count: 6 },
    { route: '77', dir: '0', origin: 'ALT', count: 4 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('77|0'), 'MAIN');
});

test('trips missing an origin are skipped without crashing', () => {
  const tripMeta = new Map([
    ['T1', { route: '9', dir: '0', mode: 'bus' }],
    ['T2', { route: '9', dir: '0', mode: 'bus' }],
    ['T3', { route: '9', dir: '0', mode: 'bus' }],
  ]);
  const firstStopId = new Map([['T1', 'X'], ['T2', 'X']]); // T3 has no origin
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('9|0'), 'X');
});

test('staggered two-origin scenario: dominant terminal drives bucketing', () => {
  // Simulates Bug C: a main terminal with 70% of trips plus a garage pullout
  // with 30%. The dominance filter keeps only main-terminal trips downstream
  // so the per-hour headway median reflects the rider-facing schedule.
  const { tripMeta, firstStopId } = mkTrips([
    { route: '20', dir: '0', origin: 'TERMINAL', count: 70 },
    { route: '20', dir: '0', origin: 'GARAGE', count: 30 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('20|0'), 'TERMINAL');
});
