// Demo script for the tail-drop ghost rendering in bunching videos.
//
// Builds synthetic snapshots of three buses on CTA pattern 100 (route 72,
// North Ave eastbound) where one bus disappears mid-clip and never returns.
// Stubs getVehicles via the require cache so captureBunchingVideo runs its
// normal pipeline against scripted data, then writes the resulting MP4 to
// tmp/ for visual inspection.
//
// Run: node scripts/demoBunchingGhost.js

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const Fs = require('node:fs');
const Path = require('node:path');

const apiPath = require.resolve('../src/bus/api');
require(apiPath);

const pattern = require('../data/patterns/100.json');

// Pick three points roughly mid-pattern for the bunch's starting cluster.
const startPdist = 8000;
const stride = 250; // ~250 ft between buses → tight bunch

function pointAtPdist(targetFt) {
  const pts = pattern.points;
  let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dLat = (b.lat - a.lat) * 364000;
    const dLon = (b.lon - a.lon) * 288200; // ft per deg, ~lat 41.9
    const seg = Math.hypot(dLat, dLon);
    if (cum + seg >= targetFt) {
      const t = (targetFt - cum) / seg;
      return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    }
    cum += seg;
  }
  const last = pts[pts.length - 1];
  return { lat: last.lat, lon: last.lon };
}

function makeBus(vid, pdist) {
  const { lat, lon } = pointAtPdist(pdist);
  return { vid, lat, lon, heading: 90, pid: pattern.pid, pdist, rt: '72' };
}

// Initial bunch: three buses ~250 ft apart, all moving forward.
const bunch = {
  route: '72',
  pid: pattern.pid,
  spanFt: stride * 2,
  vehicles: [
    makeBus('A', startPdist),
    makeBus('B', startPdist + stride),
    makeBus('C', startPdist + stride * 2),
  ],
};

// Scripted polls: each tick advances every still-tracked bus ~150 ft. Bus C
// drops out at tick 3 and never returns — should be rendered as a ghost
// that fades out over MAX_DEAD_RECKON_MS (30s = 2 ticks at 15s) and then
// disappears entirely for the rest of the clip.
const advancePerTick = 150;
const NUM_TICKS = 8;
const scripted = [];
for (let i = 1; i < NUM_TICKS; i++) {
  const buses = [
    makeBus('A', startPdist + advancePerTick * i),
    makeBus('B', startPdist + stride + advancePerTick * i),
  ];
  if (i < 3) buses.push(makeBus('C', startPdist + stride * 2 + advancePerTick * i));
  scripted.push(buses);
}

let pollIdx = 0;
require.cache[apiPath].exports.getVehicles = async () => {
  const out = scripted[pollIdx] || [];
  pollIdx++;
  return out;
};

const { captureBunchingVideo } = require('../src/bus/bunchingVideo');

(async () => {
  const result = await captureBunchingVideo(bunch, pattern, {
    tickMs: 50, // fast playback through the scripted polls
    ticks: NUM_TICKS,
    interpolate: 4,
    framerate: 8,
  });
  if (!result) {
    console.error('captureBunchingVideo returned null');
    process.exit(1);
  }
  const out = Path.join(__dirname, '..', 'tmp', 'ghost-demo.mp4');
  Fs.writeFileSync(out, result.buffer);
  console.log(
    `wrote ${out} — ${result.ticksCaptured} ticks, ${result.elapsedSec}s elapsed, ` +
      `initialSpan=${result.initialSpanFt}ft finalSpan=${result.finalSpanFt}ft`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
