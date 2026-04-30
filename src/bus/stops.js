const { bearing } = require('../shared/geo');

// CTA pattern points are tagged 'S' (stop) or 'W' (waypoint); only stops
// have stopName populated. We also attach a local bearing computed from a
// short window of surrounding pattern points so the renderer can offset each
// stop perpendicular to its own segment of the route — using a single global
// bearing skews stops on curves to the wrong side of the line.
function getPatternStops(pattern) {
  const pts = pattern.points;
  const stops = [];
  const WINDOW = 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.type !== 'S' || !p.stopName) continue;
    const before = pts[Math.max(0, i - WINDOW)];
    const after = pts[Math.min(pts.length - 1, i + WINDOW)];
    const brg = before === after ? null : bearing(before, after);
    stops.push({
      lat: p.lat,
      lon: p.lon,
      stopName: p.stopName,
      stopId: p.stopId,
      bearing: brg,
    });
  }
  return stops;
}

module.exports = { getPatternStops };
