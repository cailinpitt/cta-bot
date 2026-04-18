const Fs = require('fs-extra');
const Path = require('path');
const { haversineFt } = require('./geo');

const CACHE_PATH = Path.join(__dirname, '..', 'data', 'signals', 'chicago.json');

let memo;

function loadAll() {
  if (memo) return memo;
  if (!Fs.existsSync(CACHE_PATH)) {
    console.warn(`No signal cache at ${CACHE_PATH} — run \`npm run fetch-signals\` to populate`);
    memo = [];
    return memo;
  }
  try {
    memo = Fs.readJsonSync(CACHE_PATH);
  } catch (err) {
    console.warn(`Signal cache unreadable: ${err.message}`);
    memo = [];
  }
  return memo;
}

/**
 * Return OSM traffic-signal nodes inside the given bbox. Reads from a
 * pre-fetched city-wide snapshot (`npm run fetch-signals`) — runtime never
 * touches the network, so rendering is deterministic and Overpass outages
 * can't block a post.
 */
function fetchSignalsInBbox(bbox) {
  return loadAll().filter((s) =>
    s.lat >= bbox.minLat && s.lat <= bbox.maxLat
    && s.lon >= bbox.minLon && s.lon <= bbox.maxLon,
  );
}

// Perpendicular distance (feet) from a point to a polyline, computed as the
// minimum across each segment. Uses planar projection of lon/lat — acceptable
// here since signals we're filtering are already within a sub-mile bbox.
function perpDistFtToPolyline(point, linePts) {
  let best = Infinity;
  for (let i = 0; i < linePts.length - 1; i++) {
    const a = linePts[i];
    const b = linePts[i + 1];
    const ax = a.lon;
    const ay = a.lat;
    const dx = b.lon - ax;
    const dy = b.lat - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) t = Math.max(0, Math.min(1, ((point.lon - ax) * dx + (point.lat - ay) * dy) / lenSq));
    const d = haversineFt(point, { lat: ay + t * dy, lon: ax + t * dx });
    if (d < best) best = d;
  }
  return best;
}

/**
 * Keep only signals within `maxPerpFt` of the route polyline. Filters out
 * intersections on side streets that happen to sit in the render bbox but
 * aren't actually on the route the buses are running.
 */
function filterSignalsOnRoute(signals, routePoints, maxPerpFt = 120) {
  return signals.filter((s) => perpDistFtToPolyline(s, routePoints) <= maxPerpFt);
}

/**
 * Greedy dedupe: collapse signals within `minFt` of a previously-kept signal
 * into a single marker. OSM often tags the four corners of an intersection
 * as separate nodes, and we want one glyph per intersection.
 */
function dedupeNearbySignals(signals, minFt = 150) {
  const kept = [];
  for (const s of signals) {
    if (kept.every((k) => haversineFt(s, k) > minFt)) kept.push(s);
  }
  return kept;
}

module.exports = { fetchSignalsInBbox, filterSignalsOnRoute, dedupeNearbySignals };
