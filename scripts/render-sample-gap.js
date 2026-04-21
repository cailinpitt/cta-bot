#!/usr/bin/env node
// Render a synthetic gap for a given line + destination so we can eyeball
// the label placement without waiting for the real line to produce a gap.
// Usage: node scripts/render-sample-gap.js <line> <destName> <trailingStationName> <leadingStationName>

require('../src/shared/env');
const Fs = require('fs-extra');
const Path = require('path');
const { LINE_COLORS, LINE_NAMES } = require('../src/train/api');
const { renderTrainGap } = require('../src/map');
const { buildLinePolyline, snapToLine } = require('../src/train/speedmap');
const trainLines = require('../src/train/data/trainLines.json');
const trainStations = require('../src/train/data/trainStations.json');

const [line, destName, trailingName, leadingName] = process.argv.slice(2);
if (!line || !destName || !trailingName || !leadingName) {
  console.error('usage: <line> <destName> <trailingStation> <leadingStation>');
  process.exit(2);
}

const byName = (n) => trainStations.find((s) => s.name === n && s.lines?.includes(line));
const trailingSt = byName(trailingName);
const leadingSt = byName(leadingName);
if (!trailingSt || !leadingSt) {
  console.error('station not found on line', { trailingSt, leadingSt });
  process.exit(1);
}

const { points, cumDist } = buildLinePolyline(trainLines, line);
const trailingTrackDist = snapToLine(trailingSt.lat, trailingSt.lon, points, cumDist);
const leadingTrackDist = snapToLine(leadingSt.lat, leadingSt.lon, points, cumDist);

// Direction-code heuristic: 1 = toward downtown-ish, 5 = away. Doesn't matter
// for rendering, just needs to be consistent.
const trDr = '1';
const trailing = { line, trDr, lat: trailingSt.lat, lon: trailingSt.lon, heading: 90, destination: destName, nextStation: trailingName };
const leading  = { line, trDr, lat: leadingSt.lat,  lon: leadingSt.lon,  heading: 90, destination: destName, nextStation: leadingName };

const gap = {
  line, trDr, leading, trailing,
  leadingTrackDist, trailingTrackDist,
  nearStation: null,
  gapFt: Math.abs(leadingTrackDist - trailingTrackDist),
  gapMin: 20, expectedMin: 8, ratio: 2.5,
};

(async () => {
  const img = await renderTrainGap(gap, LINE_COLORS, trainLines, trainStations);
  const out = Path.join(__dirname, '..', 'assets', `sample-gap-${line}-${Date.now()}.jpg`);
  Fs.ensureDirSync(Path.dirname(out));
  Fs.writeFileSync(out, img);
  console.log(out);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
