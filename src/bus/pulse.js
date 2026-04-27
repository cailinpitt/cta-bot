// Detects route-level bus blackouts: a tracked route with zero distinct
// vehicles observed in the lookback while GTFS says the route should be
// running and other routes report normally. Pure function — no DB writes,
// no API calls; all I/O comes through injected callbacks. The bin script
// (`bin/bus/pulse.js`) handles persistence/cooldown/threading.
//
// The "strict zero" rule deliberately differs from the train detector. A
// route with even one bus on the air (including a stuck yard bus) suppresses
// the alert — gaps are the bus/gapPost.js channel's job, not pulse's.

const MIN_EXPECTED_ACTIVE = 2;
const MIN_OTHER_ROUTES_ACTIVE = 5;
const MIN_OTHER_DISTINCT_TS = 3;
const MIN_DISTINCT_TS = 3;
const LOOKBACK_FLOOR_MS = 25 * 60 * 1000;
const LOOKBACK_CEIL_MS = 60 * 60 * 1000;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

async function detectBusBlackouts({
  routes,
  routeNames,
  observationsByRoute,
  loadPattern,
  getKnownPidsForRoute,
  expectedActive,
  expectedHeadway,
  globalDistinctTs,
  now,
  opts = {},
}) {
  const minExpectedActive = opts.minExpectedActive ?? MIN_EXPECTED_ACTIVE;
  const minOtherRoutesActive = opts.minOtherRoutesActive ?? MIN_OTHER_ROUTES_ACTIVE;
  const minOtherDistinctTs = opts.minOtherDistinctTs ?? MIN_OTHER_DISTINCT_TS;
  const minDistinctTs = opts.minDistinctTs ?? MIN_DISTINCT_TS;
  const lookbackFloorMs = opts.lookbackFloorMs ?? LOOKBACK_FLOOR_MS;
  const lookbackCeilMs = opts.lookbackCeilMs ?? LOOKBACK_CEIL_MS;

  if (!routes || routes.length === 0) {
    return { skipped: 'no-routes', candidates: [] };
  }
  if ((globalDistinctTs || 0) < minDistinctTs) {
    return { skipped: 'warming-up', candidates: [] };
  }

  // First pass: figure out which routes are "active" right now (≥ minOtherDistinctTs
  // distinct timestamps in the lookback). Used for the cross-route guard so a
  // pipeline-wide outage doesn't masquerade as a single-route blackout.
  const distinctTsByRoute = new Map();
  for (const route of routes) {
    const obs = observationsByRoute.get(String(route)) || [];
    distinctTsByRoute.set(String(route), new Set(obs.map((o) => o.ts)).size);
  }
  const activeRoutes = [...distinctTsByRoute.entries()].filter(
    ([, n]) => n >= minOtherDistinctTs,
  ).length;

  if (activeRoutes < minOtherRoutesActive) {
    return { skipped: 'pipeline-wide-quiet', candidates: [] };
  }

  const candidates = [];
  for (const route of routes) {
    const routeStr = String(route);
    const obs = observationsByRoute.get(routeStr) || [];

    // Pids from this lookback's observations, plus any historically-seen
    // pids the bin supplies via getKnownPidsForRoute. The fallback matters
    // for fully-silent routes — without it, a true blackout has no pids to
    // resolve a pattern from, so the route would be skipped.
    const observedPids = [...new Set(obs.map((o) => o.pid).filter(Boolean))];
    const knownPids = getKnownPidsForRoute ? (await getKnownPidsForRoute(routeStr)) || [] : [];
    const pids = [...new Set([...observedPids, ...knownPids])];
    const patterns = [];
    for (const pid of pids) {
      try {
        const p = await loadPattern(pid);
        if (p) patterns.push(p);
      } catch (_e) {
        /* skip individual pid failures — other pids may still resolve */
      }
    }
    if (patterns.length === 0) continue;

    let expectedActiveSum = 0;
    let minHeadwayMin = null;
    let maxHeadwayMin = null;
    for (const pattern of patterns) {
      const ea = expectedActive(routeStr, pattern, now);
      if (Number.isFinite(ea)) expectedActiveSum += ea;
      const h = expectedHeadway(routeStr, pattern, now);
      if (Number.isFinite(h) && h > 0) {
        if (minHeadwayMin == null || h < minHeadwayMin) minHeadwayMin = h;
        if (maxHeadwayMin == null || h > maxHeadwayMin) maxHeadwayMin = h;
      }
    }

    if (expectedActiveSum < minExpectedActive) continue;

    // Headway-scaled lookback: 3× longest direction's headway, clamped.
    const lookbackMs =
      maxHeadwayMin != null
        ? clamp(3 * maxHeadwayMin * 60_000, lookbackFloorMs, lookbackCeilMs)
        : lookbackFloorMs;
    const sinceTs = now - lookbackMs;
    const inWindow = obs.filter((o) => o.ts >= sinceTs);
    const distinctVids = new Set(inWindow.map((o) => o.vid).filter(Boolean));

    if (distinctVids.size > 0) continue;

    candidates.push({
      route: routeStr,
      name: routeNames?.[routeStr] || routeStr,
      lookbackMin: Math.round(lookbackMs / 60_000),
      minHeadwayMin,
      expectedActive: expectedActiveSum,
    });
  }

  return { skipped: null, candidates };
}

module.exports = {
  detectBusBlackouts,
  MIN_EXPECTED_ACTIVE,
  MIN_OTHER_ROUTES_ACTIVE,
  MIN_OTHER_DISTINCT_TS,
  MIN_DISTINCT_TS,
  LOOKBACK_FLOOR_MS,
  LOOKBACK_CEIL_MS,
};
