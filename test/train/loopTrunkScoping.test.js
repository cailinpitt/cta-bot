const test = require('node:test');
const assert = require('node:assert');
const { LOOP_TRUNK_LINES } = require('../../src/train/speedmap');

test('LOOP_TRUNK_LINES is restricted to round-trip lines', () => {
  assert.ok(LOOP_TRUNK_LINES.has('brn'));
  assert.ok(LOOP_TRUNK_LINES.has('org'));
  assert.ok(LOOP_TRUNK_LINES.has('pink'));
  assert.ok(LOOP_TRUNK_LINES.has('p'));
  assert.equal(LOOP_TRUNK_LINES.has('red'), false);
  assert.equal(LOOP_TRUNK_LINES.has('blue'), false);
  assert.equal(LOOP_TRUNK_LINES.has('g'), false);
  assert.equal(LOOP_TRUNK_LINES.has('y'), false);
});
