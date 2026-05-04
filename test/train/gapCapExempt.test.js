const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Os = require('node:os');
const Fs = require('node:fs');

const tmpDb = Path.join(Os.tmpdir(), `gapcap-test-${process.pid}-${Date.now()}.sqlite`);
process.env.HISTORY_DB_PATH = tmpDb;
const {
  gapCapAllows,
  recordGap,
  recordDisruption,
  recordMetaSignal,
  recentPulseOnLine,
  recentGhostOnLine,
  chicagoStartOfRushPeriod,
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

test('gapCapAllows allows posting under cap', () => {
  recordGap({
    kind: 'train',
    route: 'red',
    direction: '5',
    gapFt: 5000,
    gapMin: 12,
    expectedMin: 5,
    ratio: 2.4,
    nearStop: 'X',
    posted: true,
  });
  const allowed = gapCapAllows({
    kind: 'train',
    route: 'red',
    candidate: { ratio: 2.5 },
    cap: 2,
    windowStartTs: chicagoStartOfRushPeriod(Date.now()),
  });
  assert.equal(allowed, true);
});

test('gapCapAllows blocks at cap with non-greater ratio', () => {
  // Insert a second posted gap at higher ratio to fill the cap
  recordGap({
    kind: 'train',
    route: 'red',
    direction: '5',
    gapFt: 6000,
    gapMin: 14,
    expectedMin: 5,
    ratio: 3.5,
    nearStop: 'Y',
    posted: true,
  });
  const allowed = gapCapAllows({
    kind: 'train',
    route: 'red',
    candidate: { ratio: 2.7 },
    cap: 2,
    windowStartTs: chicagoStartOfRushPeriod(Date.now()),
  });
  assert.equal(allowed, false, 'cap should suppress when ratio is below all prior posts');
});

test('recentPulseOnLine + recentGhostOnLine power the cap-exempt path', () => {
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
  const p = recentPulseOnLine({ kind: 'train', line: 'blue', withinMs: 30 * 60 * 1000 });
  assert.ok(p, 'recent pulse should be returned');

  recordMetaSignal({
    kind: 'train',
    line: 'g',
    source: 'ghost',
    severity: 0.7,
    detail: { missing: 2.5 },
    posted: false,
  });
  const g = recentGhostOnLine({ kind: 'train', line: 'g', withinMs: 90 * 60 * 1000 });
  assert.ok(g, 'recent ghost should be returned');
});
