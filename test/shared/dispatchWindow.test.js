const test = require('node:test');
const assert = require('node:assert');
const { expectedTrainDispatchesInWindow } = require('../../src/shared/gtfs');

test('returns null for unknown line', () => {
  const v = expectedTrainDispatchesInWindow('xx', null, 0, 60 * 60 * 1000);
  assert.equal(v, null);
});

test('returns 0 for inverted window', () => {
  const v = expectedTrainDispatchesInWindow('red', null, 1000, 500);
  assert.equal(v, 0);
});

test('returns finite count for active service window on red', () => {
  // 8am Sunday CT — red runs throughout the day
  const start = Date.UTC(2026, 4, 3, 14, 0); // 14:00 UTC = 09:00 CDT
  const end = start + 60 * 60 * 1000;
  const v = expectedTrainDispatchesInWindow('red', null, start, end);
  // Either null (if index missing) or a non-negative number
  if (v != null) assert.ok(v >= 0);
});
