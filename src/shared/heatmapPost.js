// Post builder for heatmap rollups. Single module for both bus and train
// since the structure is identical; only the noun ("stops" vs "stations")
// and emoji differ.

const WINDOW_LABELS = { week: 'this week', month: 'this month' };

function titleFor(mode, window) {
  const emoji = mode === 'bus' ? '🚌' : '🚆';
  const label = WINDOW_LABELS[window] || window;
  const noun = mode === 'bus' ? 'bus' : 'train';
  return `${emoji} Chronic ${noun} trouble spots, ${label}`;
}

function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function locNouns(mode) {
  return mode === 'bus' ? ['stop', 'stops'] : ['station', 'stations'];
}

function buildPostText({ mode, window, points, totalIncidents }) {
  const lines = [titleFor(mode, window)];
  if (totalIncidents === 0) {
    lines.push('', 'No reliability incidents recorded.');
    return lines.join('\n');
  }
  const [locSing, locPlur] = locNouns(mode);
  const incidents = pluralize(totalIncidents, 'incident', 'incidents');
  const locs = pluralize(points.length, locSing, locPlur);
  lines.push('', `${incidents} across ${locs}:`);
  for (const p of points.slice(0, 3)) {
    lines.push(`· ${p.label} (${p.count})`);
  }
  return lines.join('\n');
}

function buildAltText({ mode, window, points, totalIncidents }) {
  const subject = mode === 'bus' ? 'bus bunches and gaps' : 'train bunches and gaps';
  const label = WINDOW_LABELS[window] || window;
  if (totalIncidents === 0) {
    return `Map of Chicago with no incidents plotted — no ${subject} were recorded ${label}.`;
  }
  const [locSing, locPlur] = locNouns(mode);
  const incidents = pluralize(totalIncidents, 'incident', 'incidents');
  const locs = pluralize(points.length, locSing, locPlur);
  const top = points.slice(0, 3).map((p) => `${p.label} (${p.count})`).join(', ');
  return `Heatmap of Chicago showing where ${subject} occurred ${label}: ${incidents} across ${locs}, with red circles sized by frequency. Top spots: ${top}.`;
}

module.exports = { buildPostText, buildAltText, titleFor };
