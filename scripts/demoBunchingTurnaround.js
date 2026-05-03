// Demo script for the terminal-arrival turnaround glyph in bunching videos.
//
// Mirrors demoBunchingGhost.js but places the dropped bus's last-seen
// position within the turnaround radius of the pattern's terminus, so it
// gets classified as "arrived at terminal" instead of a mid-line signal
// loss.
//
// Run: node scripts/demoBunchingTurnaround.js

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env') });

const Fs = require('node:fs');
const Path = require('node:path');

const apiPath = require.resolve('../src/bus/api');
require(apiPath);

const pattern = require('../data/patterns/100.json');

const totalPts = pattern.points.length;

function patternLengthFt() {
  let cum = 0;
  for (let i = 1; i < totalPts; i++) {
    const a = pattern.points[i - 1];
    const b = pattern.points[i];
    const dLat = (b.lat - a.lat) * 364000;
    const dLon = (b.lon - a.lon) * 288200;
    cum += Math.hypot(dLat, dLon);
  }
  return cum;
}

function pointAtPdist(targetFt) {
  const pts = pattern.points;
  let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dLat = (b.lat - a.lat) * 364000;
    const dLon = (b.lon - a.lon) * 288200;
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

const totalFt = patternLengthFt();
// Bunch sits a few hundred ft short of the terminus so bus C has somewhere
// to "arrive."
const stride = 250;
const startPdist = totalFt - 1500;

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

// Bus C reaches the terminus at tick 3 and disappears. A and B keep moving;
// they'll fall short of the terminus by clip end (~150 ft per tick over 5
// remaining ticks).
const advancePerTick = 150;
const NUM_TICKS = 10;
const scripted = [];
for (let i = 1; i < NUM_TICKS; i++) {
  const buses = [
    makeBus('A', Math.min(totalFt - 50, startPdist + advancePerTick * i)),
    makeBus('B', Math.min(totalFt - 50, startPdist + stride + advancePerTick * i)),
  ];
  if (i < 3) {
    // Bus C parked right at the terminus (within turnaround radius) on its
    // last visible tick, then drops.
    buses.push(makeBus('C', Math.min(totalFt - 50, startPdist + stride * 2 + advancePerTick * i)));
  }
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
    tickMs: 50,
    ticks: NUM_TICKS,
    interpolate: 4,
    framerate: 8,
  });
  if (!result) {
    console.error('captureBunchingVideo returned null');
    process.exit(1);
  }
  const out = Path.join(__dirname, '..', 'tmp', 'turnaround-demo.mp4');
  Fs.writeFileSync(out, result.buffer);
  console.log(
    `wrote ${out} — ${result.ticksCaptured} ticks, ${result.elapsedSec}s elapsed, ` +
      `initialSpan=${result.initialSpanFt}ft finalSpan=${result.finalSpanFt}ft`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
