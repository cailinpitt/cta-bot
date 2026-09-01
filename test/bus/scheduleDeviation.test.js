const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const Path = require('node:path');
const Fs = require('node:fs');
const Database = require('better-sqlite3');

// Point gtfs.js at a throwaway schedule DB before requiring it (the path is
// resolved at module load). `node --test` runs each file in its own process,
// so this env override is isolated to this file.
const TMP_DB = Path.join(os.tmpdir(), `cta-sched-test-${process.pid}.sqlite`);
process.env.GTFS_SCHEDULE_DB_PATH = TMP_DB;

const { formatDeviation, keycapNumber } = require('../../src/shared/format');
const {
  deviationFromStops,
  chicagoSecondsOfDay,
  scheduleDeviationMin,
  scheduledTraverseMin,
} = require('../../src/shared/gtfs');

test('formatDeviation reads as words with no signs', () => {
  assert.equal(formatDeviation(12.4), '12 min late');
  assert.equal(formatDeviation(-3.2), '3 min early');
  assert.equal(formatDeviation(0.3), 'on time'); // dead-band rounds to 0
  assert.equal(formatDeviation(-0.4), 'on time');
  assert.equal(formatDeviation(null), null);
  assert.equal(formatDeviation(undefined), null);
  assert.equal(formatDeviation(Number.NaN), null);
});

test('keycapNumber renders single and multi-digit positions as keycap emoji', () => {
  assert.equal(keycapNumber(1), '1️⃣');
  assert.equal(keycapNumber(3), '3️⃣');
  assert.equal(keycapNumber(13), '1️⃣3️⃣'); // 10+ splits per digit
});

test('chicagoSecondsOfDay converts a UTC instant to Chicago seconds-of-day', () => {
  // 15:30:45 UTC in June (CDT, UTC−5) = 10:30:45 local.
  const sec = chicagoSecondsOfDay(new Date('2026-06-13T15:30:45Z'));
  assert.equal(sec, 10 * 3600 + 30 * 60 + 45);
});

test('deviationFromStops interpolates scheduled time at the projection point', () => {
  // Three stops on a due-east line, 2 min apart.
  const stops = [
    { lat: 41.75, lon: -87.62, schedSec: 36000 },
    { lat: 41.75, lon: -87.6, schedSec: 36120 },
    { lat: 41.75, lon: -87.58, schedSec: 36240 },
  ];
  // Bus exactly halfway along the first segment → scheduled ~36060, on the path.
  const res = deviationFromStops(stops, 41.75, -87.61);
  assert.ok(res.distFt < 20, `expected on-path, got ${res.distFt} ft`);
  assert.ok(Math.abs(res.schedSec - 36060) < 2, `expected ~36060, got ${res.schedSec}`);
});

test('deviationFromStops reports off-path distance for a bus beside the route', () => {
  const stops = [
    { lat: 41.75, lon: -87.62, schedSec: 36000 },
    { lat: 41.75, lon: -87.6, schedSec: 36120 },
  ];
  // ~0.01° latitude north of the line ≈ 3,650 ft off path.
  const res = deviationFromStops(stops, 41.76, -87.61);
  assert.ok(res.distFt > 3000, `expected far off path, got ${res.distFt} ft`);
});

test('deviationFromStops returns null with fewer than two stops', () => {
  assert.equal(
    deviationFromStops([{ lat: 41.75, lon: -87.62, schedSec: 36000 }], 41.75, -87.62),
    null,
  );
  assert.equal(deviationFromStops([], 41.75, -87.62), null);
});

// --- scheduleDeviationMin end-to-end against a temp schedule DB ---
test('scheduleDeviationMin: vehicle on-route returns + late minutes', (t) => {
  const db = new Database(TMP_DB);
  t.after(() => {
    db.close();
    Fs.rmSync(TMP_DB, { force: true });
  });
  db.exec(`
    CREATE TABLE sched_stops (
      route TEXT, start_sec INTEGER, trip_id TEXT, seq INTEGER,
      lat REAL, lon REAL, sched_sec INTEGER
    );
    CREATE INDEX idx_sched_route_start ON sched_stops(route, start_sec);
  `);
  const ins = db.prepare('INSERT INTO sched_stops VALUES (?, ?, ?, ?, ?, ?, ?)');
  // Trip T1: eastbound line, scheduled to cover the segment 10:00:00→10:05:00.
  ins.run('79', 36000, 'T1', 1, 41.75, -87.62, 36000);
  ins.run('79', 36000, 'T1', 2, 41.75, -87.6, 36300);
  // Trip T2: same (route, start_sec) but a different (northern) line — the
  // direction-disambiguation case. A bus near T1 must not match T2.
  ins.run('79', 36000, 'T2', 1, 41.85, -87.62, 36000);
  ins.run('79', 36000, 'T2', 2, 41.85, -87.6, 36300);

  // --- scheduledTraverseMin fixtures (module caches the DB handle, so every
  // DB-backed assertion in this file shares this one connection) ---
  // Route 147: slow first leg (10 min / 0.02°), then two fast "express" legs
  // (2 min each) — a flat speed would badly overstate the tail.
  ins.run('147', 60000, 'N1', 1, 41.9, -87.68, 60000);
  ins.run('147', 60000, 'N1', 2, 41.9, -87.66, 60600);
  ins.run('147', 60000, 'N1', 3, 41.9, -87.64, 60720);
  ins.run('147', 60000, 'N1', 4, 41.9, -87.62, 60840);
  // Route 6: two full trips, identical geometry, 8 vs 12 min booked end to end
  // (distinct service_ids) + a short-turn ending mid-route.
  for (const [tid, t3] of [
    ['A', 60480],
    ['B', 60720],
  ]) {
    ins.run('6', 60000, tid, 1, 41.9, -87.68, 60000);
    ins.run('6', 60000, tid, 2, 41.9, -87.64, 60240);
    ins.run('6', 60000, tid, 3, 41.9, -87.6, t3);
  }
  ins.run('6', 60000, 'S', 1, 41.9, -87.68, 60000);
  ins.run('6', 60000, 'S', 2, 41.9, -87.64, 60180);

  // Bus at the segment midpoint (scheduled ~36150) observed at 10:05:00 CDT
  // (=36300s) → ~2.5 min behind schedule.
  const now = new Date('2026-06-13T15:05:00Z');
  const dev = scheduleDeviationMin(
    { route: '79', schedStartSec: 36000, lat: 41.75, lon: -87.61 },
    now,
  );
  assert.ok(dev != null && Math.abs(dev - 2.5) < 0.2, `expected ~2.5, got ${dev}`);

  // Off-route bus → null (beyond the off-path gate).
  assert.equal(
    scheduleDeviationMin({ route: '79', schedStartSec: 36000, lat: 41.95, lon: -87.61 }, now),
    null,
  );
  // No scheduled trip for that start_sec → null.
  assert.equal(
    scheduleDeviationMin({ route: '79', schedStartSec: 99999, lat: 41.75, lon: -87.61 }, now),
    null,
  );
  // Missing schedule anchor → null (e.g. a snapshot row that predates capture).
  assert.equal(scheduleDeviationMin({ route: '79', lat: 41.75, lon: -87.61 }, now), null);

  // --- scheduledTraverseMin: CTA-timetabled run time for an arbitrary stretch ---
  const n147 = { route: '147', schedStartSec: 60000 };
  // Mid-first-leg (~60300) to just shy of the last stop (~60840) → ~9 min, and
  // the fast tail alone is only ~2 min — a flat 10-mph model can't see that.
  const full = scheduledTraverseMin(n147, { lat: 41.9, lon: -87.67 }, { lat: 41.9, lon: -87.621 });
  assert.ok(full != null && Math.abs(full - 9) < 1.5, `expected ~9 min, got ${full}`);
  const tail = scheduledTraverseMin(n147, { lat: 41.9, lon: -87.66 }, { lat: 41.9, lon: -87.641 });
  assert.ok(tail != null && tail < 3, `express leg should be ~2 min, got ${tail}`);

  // Off-route `from` → null (caller falls back to its distance estimate).
  assert.equal(
    scheduledTraverseMin(n147, { lat: 41.95, lon: -87.67 }, { lat: 41.9, lon: -87.62 }),
    null,
  );
  // Missing anchor / unknown start_sec → null.
  assert.equal(
    scheduledTraverseMin({ route: '147' }, { lat: 41.9, lon: -87.67 }, { lat: 41.9, lon: -87.62 }),
    null,
  );
  assert.equal(
    scheduledTraverseMin(
      { route: '147', schedStartSec: 1 },
      { lat: 41.9, lon: -87.67 },
      { lat: 41.9, lon: -87.62 },
    ),
    null,
  );

  // Multiple trips sharing an anchor → median (robust to one odd booking). For
  // the -87.675→-87.605 stretch trip A ≈ 7 min, trip B ≈ 11 min → ~9. Short-turn
  // 'S' ends at -87.64, so `to` lands far off its path and it's dropped.
  const med = scheduledTraverseMin(
    { route: '6', schedStartSec: 60000 },
    { lat: 41.9, lon: -87.675 },
    { lat: 41.9, lon: -87.605 },
  );
  assert.ok(med != null && med > 6 && med < 12, `expected ~9 (median of 7 & 11), got ${med}`);
});
