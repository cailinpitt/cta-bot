const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Os = require('node:os');
const Fs = require('node:fs');

const tmpDb = Path.join(Os.tmpdir(), `meta-test-${process.pid}-${Date.now()}.sqlite`);
process.env.HISTORY_DB_PATH = tmpDb;
const {
  recordMetaSignal,
  getRecentMetaSignals,
  recentPulseOnLine,
  recentGhostOnLine,
  recentDetectorActivity,
  chicagoStartOfRushPeriod,
  recordDisruption,
  recordGap,
  getDb,
} = require('../../src/shared/history');

test.after(() => {
  try {
    getDb().close();
  } catch (_e) {}
  try {
    Fs.unlinkSync(tmpDb);
  } catch (_e) {}
});

test('recordMetaSignal + getRecentMetaSignals round-trip', () => {
  const now = Date.now();
  recordMetaSignal({
    kind: 'train',
    line: 'red',
    direction: '5',
    source: 'gap',
    severity: 0.7,
    detail: { ratio: 2.8 },
    posted: false,
  });
  const rows = getRecentMetaSignals({ kind: 'train', line: 'red', withinMs: 60_000 }, now + 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'gap');
  assert.equal(rows[0].severity, 0.7);
  assert.deepEqual(JSON.parse(rows[0].detail), { ratio: 2.8 });
});

test('recentPulseOnLine returns most recent posted pulse', () => {
  const now = Date.now();
  recordDisruption({
    kind: 'train',
    line: 'blue',
    direction: 'all',
    fromStation: 'A',
    toStation: 'B',
    source: 'observed',
    posted: true,
    postUri: 'at://x',
  });
  const r = recentPulseOnLine({ kind: 'train', line: 'blue', withinMs: 60_000 }, now + 1000);
  assert.ok(r);
  assert.ok(r.id);
});

test('recentGhostOnLine returns most recent ghost meta_signal', () => {
  recordMetaSignal({
    kind: 'train',
    line: 'g',
    source: 'ghost',
    severity: 0.8,
    detail: null,
    posted: true,
  });
  const r = recentGhostOnLine({ kind: 'train', line: 'g', withinMs: 60_000 });
  assert.ok(r);
  assert.equal(r.severity, 0.8);
});

test('recentDetectorActivity bundles gaps/pulses/alerts', () => {
  recordGap({
    kind: 'train',
    route: 'pink',
    direction: '5',
    gapFt: 5000,
    gapMin: 12,
    expectedMin: 5,
    ratio: 2.4,
    nearStop: 'X',
    posted: true,
  });
  const a = recentDetectorActivity({ kind: 'train', line: 'pink', withinMs: 60_000 });
  assert.ok(a.gaps.length >= 1);
});

test('chicagoStartOfRushPeriod buckets by AM/midday/PM/evening', () => {
  // 09:00 CDT (14:00 UTC) on May 3, 2026 → AM rush period (>=5, <10) → anchor 05:00 CT
  const morning = Date.UTC(2026, 4, 3, 14, 0);
  const r1 = chicagoStartOfRushPeriod(morning);
  // r1 should be earlier than `morning`
  assert.ok(r1 < morning);
  // 16:00 CDT (21:00 UTC) → PM (>=15, <20) → anchor 15:00
  const pm = Date.UTC(2026, 4, 3, 21, 0);
  const r2 = chicagoStartOfRushPeriod(pm);
  assert.ok(r2 < pm);
  assert.ok(r2 > r1);
});
