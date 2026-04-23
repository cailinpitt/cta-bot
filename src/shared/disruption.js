// Post + alt builders for a service-disruption post. Consumes a Disruption
// object and produces the text payload for a Bluesky post.
//
// Disruption shape:
//   {
//     line: 'red' | 'blue' | 'brn' | 'g' | 'org' | 'p' | 'pink' | 'y',
//     suspendedSegment: { from: string, to: string },
//     alternative:
//       | { type: 'shortTurn', from: string, to: string }
//       | { type: 'shuttle',   from: string, to: string }
//       | null,
//     reason?: string,
//     source: 'cta-alert' | 'observed',
//     detectedAt: number,
//   }
//
// The `source` drives the footer phrasing: 'cta-alert' posts quote CTA's
// alert and point readers at transitchicago.com; 'observed' posts make
// clear the bot is inferring disruption from live positions, not quoting
// a CTA alert.

const { LINE_NAMES } = require('../train/api');

function titleFor(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  return `⚠ ${lineName} Line service suspended`;
}

function buildPostText(d) {
  const { suspendedSegment, alternative, reason, source } = d;
  const lines = [titleFor(d)];
  const reasonPhrase = reason ? ` (${reason})` : '';
  lines.push('', `Between ${suspendedSegment.from} and ${suspendedSegment.to}${reasonPhrase}.`);
  if (alternative?.type === 'shortTurn') {
    lines.push(`Trains currently running: ${alternative.from} ↔ ${alternative.to}.`);
  } else if (alternative?.type === 'shuttle') {
    lines.push(`Shuttle buses running: ${alternative.from} ↔ ${alternative.to}.`);
  }
  lines.push('', footerFor(source));
  return lines.join('\n');
}

function buildAltText(d) {
  const lineName = LINE_NAMES[d.line] || d.line;
  const base = `Map of the ${lineName} Line with the segment between ${d.suspendedSegment.from} and ${d.suspendedSegment.to} dimmed to indicate service is suspended.`;
  if (d.alternative?.type === 'shortTurn') {
    return `${base} Trains are running short-turned between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  if (d.alternative?.type === 'shuttle') {
    return `${base} Shuttle buses are running between ${d.alternative.from} and ${d.alternative.to}.`;
  }
  return base;
}

function footerFor(source) {
  if (source === 'cta-alert') return 'Per CTA. Check transitchicago.com for updates.';
  if (source === 'observed') return "Based on what the bot sees; CTA hasn't issued an alert for this yet.";
  return '';
}

module.exports = { buildPostText, buildAltText, titleFor, footerFor };
