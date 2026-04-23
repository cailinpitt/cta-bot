const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText } = require('../../src/shared/recapPost');

const points = [
  { label: 'Foster & Marine Drive', lat: 41.97, lon: -87.64, count: 7, bunching: 1, gap: 6 },
  { label: 'Michigan & Delaware', lat: 41.90, lon: -87.62, count: 6, bunching: 0, gap: 6 },
  { label: 'Western & Pershing', lat: 41.82, lon: -87.69, count: 3, bunching: 3, gap: 0 },
  { label: 'Clark & Grand', lat: 41.89, lon: -87.63, count: 2, bunching: 2, gap: 0 },
];

test('buildPostText names the top-3 worst spots with counts', () => {
  const text = buildPostText({ mode: 'bus', window: 'month', points, totalIncidents: 18 });
  assert.ok(text.includes('🚌'));
  assert.ok(text.includes('this month'));
  assert.ok(text.includes('18 bunches'));
  assert.ok(text.includes('4 stops'));
  assert.ok(text.includes('Foster & Marine Drive (7)'));
  assert.ok(text.includes('Michigan & Delaware (6)'));
  assert.ok(text.includes('Western & Pershing (3)'));
  // 4th spot should NOT be called out.
  assert.ok(!text.includes('Clark & Grand'));
  // No leftover "Worst spots:" heading.
  assert.ok(!text.includes('Worst spots'));
});

test('buildPostText uses singular nouns when counts are 1', () => {
  const text = buildPostText({
    mode: 'train',
    window: 'week',
    points: [{ label: 'North/Clybourn', lat: 41.91, lon: -87.65, count: 1, bunching: 1, gap: 0 }],
    totalIncidents: 1,
  });
  assert.ok(text.includes('1 bunch '));
  assert.ok(text.includes('1 station'));
  assert.ok(!text.includes('1 stations'));
  assert.ok(!text.includes('1 bunches'));
});

test('buildPostText uses train noun and emoji for train mode', () => {
  const text = buildPostText({ mode: 'train', window: 'week', points, totalIncidents: 18 });
  assert.ok(text.includes('🚆'));
  assert.ok(text.includes('this week'));
  assert.ok(text.includes('stations'));
});

test('buildPostText handles an empty window cleanly', () => {
  const text = buildPostText({ mode: 'bus', window: 'week', points: [], totalIncidents: 0 });
  assert.ok(text.includes('No chronic bunching'));
  assert.ok(!text.includes('Worst spots'));
});

test('buildAltText summarizes the map for screen readers', () => {
  const alt = buildAltText({ mode: 'bus', window: 'month', points, totalIncidents: 18 });
  assert.ok(alt.includes('Heatmap of Chicago'));
  assert.ok(alt.includes('18 bunches'));
  assert.ok(alt.includes('4 stops'));
  assert.ok(alt.includes('Foster & Marine Drive (7)'));
});
