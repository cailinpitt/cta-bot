const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPostText, buildAltText } = require('../../src/bus/gapPost');

const pattern = { direction: 'Southbound' };
const stop = { stopName: 'Foster & Marine Drive' };
const gap = { route: '147', gapMin: 35, expectedMin: 9 };

test('buildPostText includes gap duration, stop, and scheduled headway', () => {
  const text = buildPostText(gap, pattern, stop);
  assert.ok(text.includes('🕳️'));
  assert.ok(text.includes('Route 147'));
  assert.ok(text.includes('Southbound'));
  assert.ok(text.includes('35 min gap'));
  assert.ok(text.includes('Foster & Marine Drive'));
  assert.ok(text.includes('every 9 min'));
});

test('buildAltText describes the gap for screen readers', () => {
  const alt = buildAltText(gap, pattern, stop);
  assert.ok(alt.includes('Route 147'));
  assert.ok(alt.includes('southbound'));
  assert.ok(alt.includes('35 min gap'));
  assert.ok(alt.includes('Foster & Marine Drive'));
});
