// Shared fixture builders for tests. Keep these minimal — they exist to make
// test bodies readable, not to re-implement the modules under test.

const FRESH = new Date('2026-04-18T12:00:00Z').getTime();

function bus({
  vid = '1',
  pid = '100',
  route = '22',
  pdist,
  tmstmp = FRESH,
  lat = 41.9,
  lon = -87.65,
}) {
  return { vid, pid, route, pdist, tmstmp, lat, lon };
}

function train({
  rn = '101',
  line = 'red',
  trDr = '1',
  lat,
  lon,
  heading = 0,
  destination = 'Howard',
  nextStation = 'Fullerton',
}) {
  return { rn, line, trDr, lat, lon, heading, destination, nextStation };
}

// Straight N–S polyline of length ~totalFt (by haversine) centered at 41.9,-87.65.
// Simpler than reading real line data. Returns the shape the code expects:
// trainLines[line] is an array of segments, each a [[lat,lon], ...] list.
function straightLine(totalFt = 50000) {
  const FEET_PER_DEG_LAT = 364567;
  const halfDeg = totalFt / 2 / FEET_PER_DEG_LAT;
  const lon = -87.65;
  // Five vertices so cumulative distance math has intermediate points to work with.
  const points = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    points.push([41.9 - halfDeg + t * 2 * halfDeg, lon]);
  }
  return points;
}

// Convert a "feet along a straight N–S line" coordinate back to a {lat, lon}.
// Trains placed via `atFt` snap cleanly onto the line so trackDist equals the
// input, making assertions deterministic.
function pointAtFt(totalFt, ft) {
  const FEET_PER_DEG_LAT = 364567;
  const halfDeg = totalFt / 2 / FEET_PER_DEG_LAT;
  const t = ft / totalFt;
  return { lat: 41.9 - halfDeg + t * 2 * halfDeg, lon: -87.65 };
}

module.exports = { FRESH, bus, train, straightLine, pointAtFt };
