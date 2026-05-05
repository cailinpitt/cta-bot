#!/usr/bin/env node
// One-off: re-render a past bunching event from the observations table so it
// can be posted manually after the live cron skipped it (e.g. cooldown).
// Usage: node scripts/render-historical-bunch.js --pid=6662 --ts="2026-05-05 14:00:02"
require('../src/shared/env');

const Fs = require('node:fs');
const argv = require('minimist')(process.argv.slice(2));

const { getDb } = require('../src/shared/history');
const { loadPattern, findNearestStop } = require('../src/bus/patterns');
const { detectAllBunching } = require('../src/bus/bunching');
const { renderBunchingMap } = require('../src/map');
const {
  fetchSignalsInBbox,
  filterSignalsOnRoute,
  dedupeNearbySignals,
  annotateSignalOrientations,
} = require('../src/bus/trafficSignals');
const { getPatternStops } = require('../src/bus/stops');

async function main() {
  const pid = String(argv.pid || '');
  const tsStr = argv.ts;
  const out = argv.out || '/tmp/historical-bunch.jpg';
  if (!pid || !tsStr) {
    console.error(
      'Usage: node scripts/render-historical-bunch.js --pid=<pid> --ts="YYYY-MM-DD HH:MM:SS" [--out=path]',
    );
    process.exit(1);
  }
  // Treat ts as UTC seconds (matches sqlite datetime() output formatting).
  const tsMs = Date.parse(`${tsStr.replace(' ', 'T')}Z`);
  if (Number.isNaN(tsMs)) {
    console.error(`Cannot parse ts: ${tsStr}`);
    process.exit(1);
  }

  const rows = getDb()
    .prepare(
      `SELECT vehicle_id, destination, lat, lon, pdist, heading, route, vehicle_ts
         FROM observations
        WHERE kind='bus' AND direction=? AND ts BETWEEN ? AND ?
        ORDER BY ts, vehicle_id`,
    )
    .all(pid, tsMs - 60_000, tsMs + 60_000);

  // Dedupe by vehicle (closest sample to target ts wins).
  const byVid = new Map();
  for (const r of rows) {
    const cur = byVid.get(r.vehicle_id);
    if (!cur || Math.abs(r.vehicle_ts - tsMs) < Math.abs(cur.vehicle_ts - tsMs)) {
      byVid.set(r.vehicle_id, r);
    }
  }

  const vehicles = Array.from(byVid.values()).map((r) => ({
    vid: r.vehicle_id,
    rt: r.route,
    pid,
    lat: r.lat,
    lon: r.lon,
    pdist: r.pdist,
    hdg: 0,
    des: r.destination,
    tmstmp: r.vehicle_ts,
  }));
  console.log(`Reconstructed ${vehicles.length} vehicles for pid ${pid} at ${tsStr}`);

  const bunches = detectAllBunching(vehicles, new Date(tsMs));
  if (bunches.length === 0) {
    console.error('No bunch detected from the reconstructed vehicles.');
    process.exit(1);
  }
  const bunch = bunches[0];
  console.log(
    `Bunch: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, span ${bunch.spanFt} ft, maxGap ${bunch.maxGapFt} ft`,
  );

  const pattern = await loadPattern(pid);
  const stop = findNearestStop(pattern, bunch.vehicles[0].pdist);
  console.log(`Anchor stop: ${stop?.stopName}`);

  const patternBbox = {
    minLat: Math.min(...pattern.points.map((p) => p.lat)),
    maxLat: Math.max(...pattern.points.map((p) => p.lat)),
    minLon: Math.min(...pattern.points.map((p) => p.lon)),
    maxLon: Math.max(...pattern.points.map((p) => p.lon)),
  };
  const bboxSignals = await fetchSignalsInBbox(patternBbox);
  const onRoute = filterSignalsOnRoute(bboxSignals, pattern.points);
  const signals = annotateSignalOrientations(dedupeNearbySignals(onRoute), pattern.points);
  const stops = getPatternStops(pattern);

  const image = await renderBunchingMap(bunch, pattern, signals, stops);
  Fs.writeFileSync(out, image);
  console.log(`wrote ${out} (${image.length} bytes)`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
