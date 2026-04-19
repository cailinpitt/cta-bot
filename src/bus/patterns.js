const Path = require('path');
const Fs = require('fs-extra');
const { getPattern } = require('./api');

const CACHE_DIR = Path.join(__dirname, '..', '..', 'data', 'patterns');
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — long enough to avoid churn, short enough to catch reroutes

async function loadPattern(pid) {
  Fs.ensureDirSync(CACHE_DIR);
  const cachePath = Path.join(CACHE_DIR, `${pid}.json`);
  if (Fs.existsSync(cachePath)) {
    const age = Date.now() - Fs.statSync(cachePath).mtimeMs;
    if (age < TTL_MS) return Fs.readJsonSync(cachePath);
  }
  const pattern = await getPattern(pid);
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

module.exports = { loadPattern, findNearestStop };
