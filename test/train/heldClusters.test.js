const test = require('node:test');
const assert = require('node:assert');
const { detectHeldClusters } = require('../../src/train/heldClusters');
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

function stationaryTrain(rn, ft, now, durationMs = 12 * 60 * 1000, obsCount = 6) {
  const out = [];
  const start = now - durationMs;
  for (let i = 0; i < obsCount; i++) {
    const t = start + (i * durationMs) / (obsCount - 1);
    const p = pointAtFt(TOTAL_FT, ft + i * 20);
    out.push({ ts: t, lat: p.lat, lon: p.lon, rn, trDr: '1' });
  }
  return out;
}

function movingTrain(rn, fromFt, toFt, now, obsCount = 4) {
  const out = [];
  const durationMs = 8 * 60 * 1000;
  const start = now - durationMs;
  for (let i = 0; i < obsCount; i++) {
    const t = start + (i * durationMs) / (obsCount - 1);
    const ft = fromFt + ((toFt - fromFt) * i) / (obsCount - 1);
    const p = pointAtFt(TOTAL_FT, ft);
    out.push({ ts: t, lat: p.lat, lon: p.lon, rn, trDr: '1' });
  }
  return out;
}

const NOW = 1_700_000_000_000;
const stations = buildStations();

test('2 stationary trains within 1 mi cluster, no moving → admit', () => {
  const recent = [...stationaryTrain('a', 30000, NOW), ...stationaryTrain('b', 32000, NOW)];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'held');
  assert.equal(candidates[0].heldEvidence.trainCount, 2);
});

test('2 stationary + 1 moving in same direction inside cluster → drop', () => {
  const recent = [
    ...stationaryTrain('a', 30000, NOW),
    ...stationaryTrain('b', 32000, NOW),
    ...movingTrain('c', 28000, 33000, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});

test('2 stationary, 1 moving > 1mi away → admit', () => {
  const recent = [
    ...stationaryTrain('a', 30000, NOW),
    ...stationaryTrain('b', 32000, NOW),
    ...movingTrain('c', 60000, 70000, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 1);
});

test('cluster spanning > 1 mi → only contiguous subset admits', () => {
  const recent = [
    ...stationaryTrain('a', 10000, NOW),
    ...stationaryTrain('b', 30000, NOW),
    ...stationaryTrain('c', 32000, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].heldEvidence.trainCount, 2);
});

test('insufficient duration (< minDuration) → drop', () => {
  const recent = [
    ...stationaryTrain('a', 30000, NOW, 4 * 60 * 1000),
    ...stationaryTrain('b', 32000, NOW, 4 * 60 * 1000),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});

test('1 stationary train alone → drop', () => {
  const recent = [...stationaryTrain('a', 30000, NOW)];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});

test('no recent observations → skipped', () => {
  const out = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent: [],
  });
  assert.equal(out.skipped, 'no-input');
});

test('1 moving train inside the 1mi window but >0.5mi from cluster center → admit', () => {
  // A drift-by at the far edge of the moving-veto window shouldn't kill a
  // legitimate held cluster. Cluster center ~31000; moving train at ~34500
  // is ~3500 ft away — inside 1 mi (5280 ft), outside 0.5 mi (2640 ft).
  const recent = [
    ...stationaryTrain('a', 30000, NOW),
    ...stationaryTrain('b', 32000, NOW),
    ...movingTrain('c', 34500, 35000, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 1);
});

test('1 moving train within 0.5mi of cluster center → drop', () => {
  // Close-in moving train still vetoes — that's a real "service is moving
  // through" signal, not a far-edge drift-by.
  const recent = [
    ...stationaryTrain('a', 30000, NOW),
    ...stationaryTrain('b', 32000, NOW),
    ...movingTrain('c', 31200, 32000, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});

test('2 moving trains anywhere inside the 1mi window → drop', () => {
  const recent = [
    ...stationaryTrain('a', 30000, NOW),
    ...stationaryTrain('b', 32000, NOW),
    ...movingTrain('c', 34500, 35000, NOW),
    ...movingTrain('d', 28000, 28500, NOW),
  ];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});

test('cluster in terminal zone → drop', () => {
  // terminal zone is ~1500ft each side; place cluster at the very edge
  const recent = [...stationaryTrain('a', 200, NOW), ...stationaryTrain('b', 600, NOW)];
  const { candidates } = detectHeldClusters({
    line: 'red',
    trainLines,
    stations,
    headwayMin: 8,
    now: NOW,
    recent,
  });
  assert.equal(candidates.length, 0);
});
