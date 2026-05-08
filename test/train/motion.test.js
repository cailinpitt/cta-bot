const test = require('node:test');
const assert = require('node:assert');
const { classifyTrainMotion, summarizeMotion } = require('../../src/train/motion');
const { straightLine, pointAtFt } = require('../helpers');

const TOTAL_FT = 80000;
const trainLines = { red: [straightLine(TOTAL_FT)] };

function position(rn, ft, ts, trDr = '1') {
  const p = pointAtFt(TOTAL_FT, ft);
  return { ts, lat: p.lat, lon: p.lon, rn, trDr };
}

const NOW = 1_700_000_000_000;

test('stationary cluster: 5 obs over 6 min within 200 ft → stationary', () => {
  const recent = [];
  for (let i = 0; i < 5; i++) {
    recent.push(position('train1', 30000 + i * 40, NOW - (5 - i) * 90 * 1000));
  }
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  const t = m.get('train1');
  assert.equal(t.bucket, 'stationary');
  assert.ok(t.displacementFt <= 500);
  assert.ok(t.spanMs >= 5 * 60 * 1000);
});

test('moving train: 3 obs spanning 5000 ft → moving', () => {
  const recent = [
    position('train2', 20000, NOW - 4 * 60 * 1000),
    position('train2', 22500, NOW - 2 * 60 * 1000),
    position('train2', 25000, NOW),
  ];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  assert.equal(m.get('train2').bucket, 'moving');
});

test('single-obs train → unknown', () => {
  const recent = [position('train3', 30000, NOW)];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  assert.equal(m.get('train3').bucket, 'unknown');
});

test('off-corridor obs filtered out (perpDist > MAX_PERP_FT)', () => {
  const recent = [
    {
      ts: NOW,
      lat: 41.5,
      lon: -88.5,
      rn: 'train4',
      trDr: '1',
    },
  ];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  assert.equal(m.has('train4'), false);
});

test('summarizeMotion buckets correctly', () => {
  const recent = [
    position('a', 30000, NOW - 6 * 60 * 1000),
    position('a', 30100, NOW - 3 * 60 * 1000),
    position('a', 30150, NOW),
    position('b', 20000, NOW - 4 * 60 * 1000),
    position('b', 25000, NOW),
    position('c', 40000, NOW),
  ];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  const s = summarizeMotion(m);
  assert.equal(s.total, 3);
  assert.equal(s.stationary, 1);
  assert.equal(s.moving, 1);
  assert.equal(s.unknown, 1);
});

test('2 obs over 6 min in the same place → stationary (sparse-ping case)', () => {
  // A held train's GPS often drops to 1-2 pings before going silent. With
  // the 2-obs floor the held detector still sees these trains; the prior
  // 3-obs floor was rejecting them as `unknown`.
  const recent = [
    position('train_sparse', 30000, NOW - 6 * 60 * 1000),
    position('train_sparse', 30050, NOW),
  ];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  assert.equal(m.get('train_sparse').bucket, 'stationary');
});

test('2 obs over 4 min in the same place → unknown (span gate still applies)', () => {
  // The 5-min span requirement keeps short same-place samples out — a train
  // that pinged twice 3 min apart hasn't been still long enough to call held.
  const recent = [
    position('train_short', 30000, NOW - 3 * 60 * 1000),
    position('train_short', 30050, NOW),
  ];
  const m = classifyTrainMotion({ line: 'red', trainLines, recent, now: NOW });
  assert.equal(m.get('train_short').bucket, 'unknown');
});

test('empty recent → empty map', () => {
  const m = classifyTrainMotion({ line: 'red', trainLines, recent: [], now: NOW });
  assert.equal(m.size, 0);
});
