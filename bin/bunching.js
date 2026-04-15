#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const Fs = require('fs-extra');
const Path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const { getVehicles } = require('../src/cta');
const { names: routeNames, bunching: bunchingRoutes } = require('../src/routes');
const { detectAllBunching, TERMINAL_PDIST_FT } = require('../src/bunching');
const { loadPattern } = require('../src/patterns');
const { renderBunchingMap } = require('../src/map');
const { login, postWithImage } = require('../src/bluesky');
const { isOnCooldown, markPosted } = require('../src/state');
const { pruneOldAssets } = require('../src/cleanup');

function findNearestStop(pattern, pdist) {
  const stops = pattern.points.filter((p) => p.type === 'S' && p.stopName);
  let best = stops[0];
  let bestDelta = Math.abs(stops[0].pdist - pdist);
  for (const s of stops) {
    const delta = Math.abs(s.pdist - pdist);
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

function formatDistance(ft) {
  if (ft < 1000) return `${ft} ft`;
  return `${(ft / 5280).toFixed(2)} mi`;
}

function buildPostText(bunch, pattern, stop) {
  const name = `${bunch.route} ${routeNames[bunch.route] || ''}`.trim();
  const count = bunch.vehicles.length;
  const dir = pattern.direction;
  const gap = formatDistance(bunch.spanFt);
  return `🚌 ${name} is bunched\n${count} ${dir} buses within ${gap} near ${stop.stopName}`;
}

function buildAltText(bunch, pattern, stop) {
  const name = `${bunch.route} ${routeNames[bunch.route] || ''}`.trim();
  return `Map of ${name} bus route near ${stop.stopName} showing ${bunch.vehicles.length} ${pattern.direction.toLowerCase()} buses clustered within ${formatDistance(bunch.spanFt)} of each other.`;
}

async function main() {
  pruneOldAssets();
  const routes = bunchingRoutes;
  console.log(`Fetching vehicles for ${routes.length} routes...`);
  const vehicles = await getVehicles(routes);
  console.log(`Got ${vehicles.length} vehicles`);

  const bunches = detectAllBunching(vehicles);
  if (bunches.length === 0) {
    console.log('No bunching detected');
    return;
  }

  console.log(`Found ${bunches.length} candidate bunch(es); picking best available:`);
  for (const b of bunches) {
    console.log(`  route ${b.route} pid ${b.pid} — ${b.vehicles.length} buses, span ${b.spanFt} ft, maxGap ${b.maxGapFt} ft`);
  }

  // Walk candidates best-first, skipping any that are on cooldown or fail the
  // end-of-line layover check (which needs the pattern's total length so can
  // only be evaluated after fetching the pattern).
  let bunch = null;
  let pattern = null;
  for (const candidate of bunches) {
    if (!argv['dry-run'] && isOnCooldown(candidate.pid)) {
      console.log(`  skip pid ${candidate.pid}: on cooldown`);
      continue;
    }
    const candidatePattern = await loadPattern(candidate.pid);
    const lastBus = candidate.vehicles[candidate.vehicles.length - 1];
    if (candidatePattern.lengthFt - lastBus.pdist < TERMINAL_PDIST_FT) {
      console.log(`  skip pid ${candidate.pid}: end-of-line layover near pdist ${candidatePattern.lengthFt}`);
      continue;
    }
    bunch = candidate;
    pattern = candidatePattern;
    break;
  }

  if (!bunch) {
    console.log('All candidates filtered (cooldown or terminal layover), nothing to post');
    return;
  }

  console.log(`Posting: route ${bunch.route} pid ${bunch.pid} — ${bunch.vehicles.length} buses, ${bunch.spanFt} ft`);

  const midPdist = (bunch.vehicles[0].pdist + bunch.vehicles[bunch.vehicles.length - 1].pdist) / 2;
  const stop = findNearestStop(pattern, midPdist);

  console.log('Rendering map...');
  const image = await renderBunchingMap(bunch, pattern);

  const text = buildPostText(bunch, pattern, stop);
  const alt = buildAltText(bunch, pattern, stop);

  if (argv['dry-run']) {
    const outPath = Path.join(__dirname, '..', 'assets', `bunching-${bunch.pid}-${Date.now()}.jpg`);
    Fs.ensureDirSync(Path.dirname(outPath));
    Fs.writeFileSync(outPath, image);
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${outPath}`);
    return;
  }

  const agent = await login();
  const url = await postWithImage(agent, text, image, alt);
  markPosted(bunch.pid);
  console.log(`Posted: ${url}`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
