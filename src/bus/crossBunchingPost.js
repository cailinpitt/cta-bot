// Post text for a cross-route bus cluster (2+ routes close together at one spot).
// Unlike the per-route bunching post, the headline is a PLACE, and buses are
// grouped by route with the disc number each carries on the map.
const { names: routeNames } = require('./routes');
const { groupByRoute } = require('./crossBunching');
const { formatCallouts } = require('../shared/history');
const { formatDistance, keycapNumber } = require('../shared/format');

function routeLabel(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

// `ctx` = { placeName }. Returns the primary post text.
function buildPostText(cluster, ctx, callouts = []) {
  const { placeName } = ctx;
  const { byRoute } = groupByRoute(cluster);
  const where = placeName ? ` near ${placeName}` : '';
  const routeCount = byRoute.length;
  const head = `🚍 ${cluster.vehicles.length} buses from ${routeCount} routes are close together${where} right now`;
  const lines = byRoute
    .map((g) => {
      const list = g.vids.map((x) => `#${x.vid} (${keycapNumber(x.n)})`).join(', ');
      return `${routeLabel(g.route)}: ${list}`;
    })
    .join('\n');
  const base = `${head}\n\n${lines}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n\n${tail}` : base;
}

function buildAltText(cluster, ctx) {
  const { placeName } = ctx;
  const where = placeName ? ` near ${placeName}` : '';
  const routes = cluster.routes.map((r) => `Route ${r}`).join(', ');
  return `Map${where} showing ${cluster.vehicles.length} buses from ${cluster.routeCount} routes (${routes}) within ${formatDistance(cluster.spanFt)} of each other.`;
}

function buildVideoPostText(video, cluster) {
  const elapsed = video?.elapsedSec
    ? `${Math.max(1, Math.round(video.elapsedSec / 60))} min`
    : 'Several minutes';
  return `${elapsed} of recent movement from these ${cluster.vehicles.length} buses across ${cluster.routeCount} routes.`;
}

function buildVideoAltText(cluster, ctx = {}) {
  const where = ctx.placeName ? ` near ${ctx.placeName}` : '';
  return `Timelapse map${where} showing recent movement of ${cluster.vehicles.length} buses from ${cluster.routeCount} routes that were close together.`;
}

module.exports = { buildPostText, buildAltText, buildVideoPostText, buildVideoAltText, routeLabel };
