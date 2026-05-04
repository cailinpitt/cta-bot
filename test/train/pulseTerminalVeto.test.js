const test = require('node:test');
const assert = require('node:assert');
const { detectDeadSegments } = require('../../src/train/pulse');
const { straightLine, pointAtFt } = require('../helpers');

const TOTAL_FT = 80000;
const trainLines = { red: [straightLine(TOTAL_FT)] };

function buildStations(spacingFt = 2000) {
  const out = [];
  for (let ft = 0; ft <= TOTAL_FT; ft += spacingFt) {
    const p = pointAtFt(TOTAL_FT, ft);
    out.push({ name: `S${ft}`, lat: p.lat, lon: p.lon, lines: ['red'] });
  }
  return out;
}

function position(ft, ts) {
  const p = pointAtFt(TOTAL_FT, ft);
  return { ts, lat: p.lat, lon: p.lon, rn: `r${ft}-${ts}`, trDr: '1' };
}

// `coldAgoMs` is the age of the most recent observation in the cold zone.
// Lookback must be wide enough to include those obs.
function buildBaselineWithCold(coldFromFt, coldToFt, coldAgoMs, lookbackMs) {
  const now = 1_700_000_000_000;
  const recent = [];
  // Warm bins observed at now-1min and at lookback-2min to satisfy span gate.
  const oldTs = now - (lookbackMs - 2 * 60 * 1000);
  for (let ft = 4000; ft <= TOTAL_FT - 4000; ft += 1000) {
    if (ft >= coldFromFt && ft <= coldToFt) continue;
    recent.push(position(ft, oldTs));
    recent.push(position(ft, now - 1 * 60 * 1000));
  }
  for (let ft = coldFromFt; ft <= coldToFt; ft += 1000) {
    recent.push(position(ft, now - coldAgoMs));
  }
  return { now, recent };
}

function corridorBbox() {
  const a = pointAtFt(TOTAL_FT, 0);
  const b = pointAtFt(TOTAL_FT, 50000);
  return {
    minLat: Math.min(a.lat, b.lat),
    maxLat: Math.max(a.lat, b.lat),
    minLon: -87.66,
    maxLon: -87.64,
  };
}

const LOOKBACK_MS = 40 * 60 * 1000;

test('terminal-adjacent cold run at ~1.1× threshold is vetoed', () => {
  const stations = buildStations(2000);
  // Cold run at corridor east edge (within 2640ft of S50000), coldMs=22min, threshold=20min
  const { now, recent } = buildBaselineWithCold(46000, 49000, 22 * 60 * 1000, LOOKBACK_MS);
  const { candidates } = detectDeadSegments({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now,
    opts: { recentPositions: recent, corridorBbox: corridorBbox(), lookbackMs: LOOKBACK_MS },
  });
  assert.equal(candidates.length, 0, 'terminal-adjacent ~1.1x should be vetoed');
});

test('terminal-adjacent cold run at 1.5× threshold admits', () => {
  const stations = buildStations(2000);
  const { now, recent } = buildBaselineWithCold(46000, 49000, 30 * 60 * 1000, LOOKBACK_MS);
  const { candidates } = detectDeadSegments({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now,
    opts: { recentPositions: recent, corridorBbox: corridorBbox(), lookbackMs: LOOKBACK_MS },
  });
  assert.ok(candidates.length >= 1, 'sustained outage at corridor edge should admit');
});

test('mid-line cold run at 1.0× threshold not vetoed', () => {
  const stations = buildStations(2000);
  const { now, recent } = buildBaselineWithCold(30000, 34000, 22 * 60 * 1000, LOOKBACK_MS);
  const { candidates } = detectDeadSegments({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now,
    opts: { recentPositions: recent, corridorBbox: corridorBbox(), lookbackMs: LOOKBACK_MS },
  });
  assert.ok(candidates.length >= 1, 'mid-line cold at threshold should admit');
});

test('dispatch-continuity: scheduled dispatch suppresses borderline cold', () => {
  const stations = buildStations(2000);
  // Mid-line, coldMs=22min, threshold=20min, ratio=1.1x — under 1.5x dispatch margin
  const { now, recent } = buildBaselineWithCold(30000, 34000, 22 * 60 * 1000, LOOKBACK_MS);
  const { candidates } = detectDeadSegments({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now,
    opts: {
      recentPositions: recent,
      corridorBbox: corridorBbox(),
      lookbackMs: LOOKBACK_MS,
      expectedDispatchesInWindow: 2,
    },
  });
  assert.equal(
    candidates.length,
    0,
    'dispatch-continuity should suppress borderline cold when scheduled dispatches present',
  );
});

test('dispatch-continuity does not veto sustained passLong outage', () => {
  const stations = buildStations(8000);
  const { now, recent } = buildBaselineWithCold(20000, 38000, 30 * 60 * 1000, LOOKBACK_MS);
  const { candidates } = detectDeadSegments({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now,
    opts: {
      recentPositions: recent,
      corridorBbox: corridorBbox(),
      lookbackMs: LOOKBACK_MS,
      expectedDispatchesInWindow: 2,
    },
  });
  assert.ok(candidates.length >= 1, 'long sustained outage should admit even with dispatches');
});
