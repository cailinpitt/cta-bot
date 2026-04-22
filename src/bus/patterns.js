const Path = require('path');
const Fs = require('fs-extra');
const { getPattern } = require('./api');

const CACHE_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
// Shortened from 7d → 24h so a mid-week reroute (detour, terminal moved)
// gets picked up within a day instead of a week. Patterns are tiny and the
// CTA pattern endpoint is fast, so the extra fetches are cheap.
const TTL_MS = 24 * 60 * 60 * 1000;

// Stable identifier for the served geometry: length + first/last point. If
// CTA reissues the pattern with different coords or stop count, the signature
// changes and downstream code can detect the drift without re-fetching.
function patternSignature(pattern) {
  const first = pattern.points[0];
  const last = pattern.points[pattern.points.length - 1];
  return `${pattern.lengthFt}:${pattern.points.length}:${first.lat},${first.lon}:${last.lat},${last.lon}`;
}

async function loadPattern(pid) {
  Fs.ensureDirSync(CACHE_DIR);
  const cachePath = Path.join(CACHE_DIR, `${pid}.json`);
  if (Fs.existsSync(cachePath)) {
    const age = Date.now() - Fs.statSync(cachePath).mtimeMs;
    if (age < TTL_MS) return Fs.readJsonSync(cachePath);
  }
  let pattern;
  try {
    pattern = await getPattern(pid);
  } catch (e) {
    // One-shot retry on transient failure before giving up. The caller (ghost
    // detection) skips the whole route if this still throws, so a short retry
    // pays for itself many times over.
    await new Promise((r) => setTimeout(r, 250));
    pattern = await getPattern(pid);
  }
  pattern.signature = patternSignature(pattern);
  Fs.writeJsonSync(cachePath, pattern);
  return pattern;
}

// Nearest on-pattern stop to a given pdist. Used by bunching/gap post builders
// so the "near X" label comes from the pattern's stop list rather than the
// raw bus position.
function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) { best = s; bestDelta = delta; }
  }
  return best;
}

module.exports = { loadPattern, findNearestStop, patternSignature };
