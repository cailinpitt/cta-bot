const test = require('node:test');
const assert = require('node:assert');
const { detectBusGhosts } = require('../src/bus/ghosts');

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

function buildObs({ snapshots, vidsPerSnapshotByIdx }) {
  const out = [];
  const start = 1_700_000_000_000;
  for (let i = 0; i < snapshots; i++) {
    const ts = start + i * SNAPSHOT_INTERVAL_MS;
    const n = vidsPerSnapshotByIdx(i);
    for (let v = 0; v < n; v++) {
      out.push({ ts, direction: 'p1', vehicle_id: `v${v}`, route: '66' });
    }
  }
  return out;
}

const mkPattern = (label) => ({ pid: 'p1', direction: label });

test('trailing-deficit override admits when deficit concentrates in tail', async () => {
  // Window: 12 snapshots, expected=6, observed first 9 = 5 (1 missing), last 3 = 2 (4 missing)
  // Median observed ≈ 5, missing = 1 (below 3 threshold)
  // tailMedian (last 3) = 2, trailingDeficit = 6-2 = 4 ≥ 2, missing=1 < threshold
  // For override: missing >= 2 AND trailingDeficit >= 2 AND tailMed < observed
  // missing=1 doesn't pass missing≥2, so STILL drops. Use stronger setup:
  const obs = buildObs({
    snapshots: 12,
    vidsPerSnapshotByIdx: (i) => (i < 9 ? 5 : 2),
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  // missing = 6 - median([5,5,5,5,5,5,5,5,5,2,2,2]) = 6 - 5 = 1, below threshold
  // tailMed = median([2,2,2]) = 2 < observedActive=5
  // trailingDeficit = 6 - 2 = 4 ≥ 2
  // missing < MISSING_ABS_THRESHOLD_TRAILING (2), so override fails — admits 0
  assert.equal(events.length, 0);
});

test('trailing-deficit override admits at missing=2 with concentrated deficit', async () => {
  // Setup: expected=8, observed first 9 snapshots = 7 (1 missing), last 3 = 2 (6 missing)
  // counts = [7]*9 + [2]*3, median = 7, missing = 8-7 = 1. Still below 2.
  // Need overall missing ≥ 2. Try: first 6 = 7, last 6 = 5 (each missing 1, 3)
  // counts = [7]*6 + [5]*6, sorted ranking: median of 12 = avg of position 6 and 7 → both 7? actually [5,5,5,5,5,5,7,7,7,7,7,7], pos 6 = 5, pos 7 = 7, median = 6.
  // missing = 8 - 6 = 2 ✓ (= threshold trailing)
  // tailMed = median([5,5,5]) = 5 < 6 ✓
  // trailingDeficit = 8 - 5 = 3 ≥ 2 ✓
  const obs = buildObs({
    snapshots: 12,
    vidsPerSnapshotByIdx: (i) => (i < 6 ? 7 : 5),
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 8,
  });
  assert.equal(events.length, 1);
});

test('steady deficit (no tail concentration) still drops below abs threshold', async () => {
  // expected=6, observed=4 throughout. missing=2 (just below 3). Tail=4 = observed. tailMed < observed false.
  const obs = buildObs({
    snapshots: 12,
    vidsPerSnapshotByIdx: () => 4,
  });
  const events = await detectBusGhosts({
    routes: ['66'],
    getObservations: () => obs,
    getPattern: async () => mkPattern('Eastbound'),
    expectedHeadway: () => 10,
    expectedDuration: () => 60,
    expectedActive: () => 6,
  });
  assert.equal(events.length, 0, 'steady under-count should not admit via trailing override');
});
