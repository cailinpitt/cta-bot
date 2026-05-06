const test = require('node:test');
const assert = require('node:assert');
const { purpleExpressLikelyActive, chicagoWeekdayNow } = require('../../bin/train/pulse');

test('chicagoWeekdayNow returns Wed for a Wednesday CT timestamp', () => {
  // 2026-05-06 16:10 UTC = 11:10 AM CDT, a Wednesday
  assert.equal(chicagoWeekdayNow(new Date('2026-05-06T16:10:00Z')), 'Wed');
});

test('purpleExpressLikelyActive: midday weekday → false', () => {
  // 2026-05-06 (Wed) 16:10 UTC = 11:10 AM CDT, between AM and PM rush
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-06T16:10:00Z')), false);
});

test('purpleExpressLikelyActive: AM rush weekday → true', () => {
  // 2026-05-06 (Wed) 13:00 UTC = 8:00 AM CDT
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-06T13:00:00Z')), true);
});

test('purpleExpressLikelyActive: PM rush weekday → true', () => {
  // 2026-05-06 (Wed) 22:30 UTC = 5:30 PM CDT
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-06T22:30:00Z')), true);
});

test('purpleExpressLikelyActive: Saturday → false even during rush hours', () => {
  // 2026-05-09 (Sat) 13:00 UTC = 8:00 AM CDT
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-09T13:00:00Z')), false);
});

test('purpleExpressLikelyActive: Sunday → false even during rush hours', () => {
  // 2026-05-10 (Sun) 22:30 UTC = 5:30 PM CDT
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-10T22:30:00Z')), false);
});

test('purpleExpressLikelyActive: late evening weekday → false', () => {
  // 2026-05-06 (Wed) 03:00 UTC = 10:00 PM CDT (prev day)
  assert.equal(purpleExpressLikelyActive(new Date('2026-05-07T03:00:00Z')), false);
});
