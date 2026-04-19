const { names: routeNames } = require('./routes');
const { formatCallouts } = require('../shared/history');
const { formatMinutes } = require('../shared/format');

function routeTitle(route) {
  const name = routeNames[route];
  return name ? `Route ${route} (${name})` : `Route ${route}`;
}

function buildPostText(gap, pattern, stop, callouts = []) {
  const base = `🕳️ ${routeTitle(gap.route)} — ${pattern.direction}\n${formatMinutes(gap.gapMin)} gap near ${stop.stopName} — currently scheduled every ${formatMinutes(gap.expectedMin)}`;
  const tail = formatCallouts(callouts);
  return tail ? `${base}\n${tail}` : base;
}

function buildAltText(gap, pattern, stop) {
  return `Map of ${routeTitle(gap.route)} ${pattern.direction.toLowerCase()} showing a ${formatMinutes(gap.gapMin)} gap between buses near ${stop.stopName}.`;
}

module.exports = { buildPostText, buildAltText };
