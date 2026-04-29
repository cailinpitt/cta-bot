const { haversineFt } = require('../shared/geo');

// CTA pattern points are tagged 'S' (stop) or 'W' (waypoint); only stops
// have stopName populated. Strip waypoints so callers don't have to.
function getPatternStops(pattern) {
  return pattern.points
    .filter((p) => p.type === 'S' && p.stopName)
    .map((p) => ({ lat: p.lat, lon: p.lon, stopName: p.stopName, stopId: p.stopId }));
}

// Drop stops that sit near a traffic signal — signals already mark the
// intersection, so the stop glyph would just pile on top. minFt defaults to
// ~150ft, roughly a typical near-side/far-side stop offset from the corner.
function dedupeStopsNearSignals(stops, signals, minFt = 150) {
  if (signals.length === 0) return stops;
  return stops.filter((s) => !signals.some((sig) => haversineFt(s, sig) < minFt));
}

module.exports = { getPatternStops, dedupeStopsNearSignals };
