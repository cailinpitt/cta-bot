const { haversineFt } = require('./geo');
const { buildLinePolyline, snapToLine } = require('./trainSpeedmap');

const TRAIN_BUNCHING_FT = 2000; // ~0.38 mi, tighter than normal rush-hour headway
const MIN_DISTANCE_FT = 200;    // ignore pairs closer than this — likely same station or API glitch
const TERMINAL_ZONE_FT = 1500;  // trains within this of either end are treated as terminal layovers

/**
 * Detect the tightest bunched pair of trains on the same line heading the same
 * direction (same `trDr`).
 *
 * Uses along-track distance by snapping each train onto the line's polyline.
 * This avoids false positives where two trains are geographically close but far
 * apart along the route (e.g. opposite sides of the Loop).
 *
 * Returns null if no bunch is detected.
 */
function detectTrainBunching(trains, trainLines) {
  const groups = new Map();
  for (const t of trains) {
    if (!t.trDr) continue;
    const key = `${t.line}_${t.trDr}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  // Cache polyline data per line so we don't rebuild it for every pair.
  const lineCache = new Map();
  function getLine(line) {
    if (!lineCache.has(line)) {
      lineCache.set(line, buildLinePolyline(trainLines, line));
    }
    return lineCache.get(line);
  }

  let best = null;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [line, trDr] = key.split('_');
    const { points, cumDist } = getLine(line);
    if (points.length < 2) continue;
    const totalFt = cumDist[cumDist.length - 1];

    // Snap each train onto the polyline once, then compare along-track distances.
    const snapped = group.map((t) => ({
      train: t,
      trackDist: snapToLine(t.lat, t.lon, points, cumDist),
    }));

    for (let i = 0; i < snapped.length; i++) {
      for (let j = i + 1; j < snapped.length; j++) {
        const di = snapped[i].trackDist;
        const dj = snapped[j].trackDist;
        const dist = Math.abs(di - dj);
        if (dist < MIN_DISTANCE_FT || dist > TRAIN_BUNCHING_FT) continue;
        // Skip terminal layovers: if either train sits in the start/end zone,
        // the cluster is a terminal queue (trains about to depart or going out
        // of service) rather than real bunching mid-route.
        if (Math.min(di, dj) < TERMINAL_ZONE_FT) continue;
        if (totalFt - Math.max(di, dj) < TERMINAL_ZONE_FT) continue;
        if (!best || dist < best.distanceFt) {
          best = {
            line,
            trDr,
            trains: [snapped[i].train, snapped[j].train],
            distanceFt: dist,
          };
        }
      }
    }
  }

  return best;
}

module.exports = { detectTrainBunching, TRAIN_BUNCHING_FT, MIN_DISTANCE_FT };
