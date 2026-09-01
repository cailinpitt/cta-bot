const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveServiceDayTypes,
  referenceDates,
  occupancyWeightedHeadwayMin,
  MIN_PATTERN_TRIPS,
  TWO_TRIP_MIN_HEADWAY_MIN,
  MAX_MEANINGFUL_GAP_MIN,
} = require('../../scripts/fetch-gtfs');

const H = (h, m = 0) => h * 3600 + m * 60;

test('occupancyWeightedHeadwayMin: uniform service returns the uniform interval', () => {
  const deps = [];
  for (let m = 0; m < 60; m += 10) deps.push(H(14, m));
  const hw = occupancyWeightedHeadwayMin(deps, 14);
  assert.ok(Math.abs(hw - 10) < 0.5, `expected ~10, got ${hw}`);
});

test('occupancyWeightedHeadwayMin: cluster after a hole reports the wait a real rider faces', () => {
  // 7 buses 14:39–14:59 after a 25-min hole — the median-of-gaps bug read 5.5.
  const deps = [H(14, 7), H(14, 14), H(14, 39), H(14, 45), H(14, 50), H(14, 55), H(14, 59)];
  const hw = occupancyWeightedHeadwayMin(deps, 14);
  assert.ok(hw > 12 && hw < 20, `expected a mid-teens wait, got ${hw}`);
});

test('occupancyWeightedHeadwayMin: ramp-down — quiet tail dominates the hour', () => {
  // Last three buses of the night at :02/:10/:18, next not until 00:15.
  const deps = [H(22, 2), H(22, 10), H(22, 18), H(24, 15)];
  const hw = occupancyWeightedHeadwayMin(deps, 22);
  assert.ok(hw > 30, `expected the long tail spacing, got ${hw}`);
});

test('occupancyWeightedHeadwayMin: after-midnight departures count for the wrapped hour', () => {
  const deps = [H(25, 5), H(25, 25), H(25, 45)]; // 1:05, 1:25, 1:45 AM
  assert.ok(Math.abs(occupancyWeightedHeadwayMin(deps, 1) - 20) < 1);
  assert.equal(occupancyWeightedHeadwayMin(deps, 14), null); // nothing in hour 14
});

test('occupancyWeightedHeadwayMin: an end-of-service gap is capped', () => {
  const deps = [H(8, 0), H(8, 10), H(8, 20), H(15, 0)]; // rush short-turn, then nothing till 3pm
  const hw = occupancyWeightedHeadwayMin(deps, 8);
  assert.ok(hw <= MAX_MEANINGFUL_GAP_MIN, `expected cap, got ${hw}`);
});

test('occupancyWeightedHeadwayMin: fewer than two departures returns null', () => {
  assert.equal(occupancyWeightedHeadwayMin([H(9, 0)], 9), null);
  assert.equal(occupancyWeightedHeadwayMin([], 9), null);
});

// 2026-08-31 is a Monday; 08-29 Sat, 08-30 Sun, 08-28 Fri.
test('referenceDates: weekday build points each bucket at the nearest real instance', () => {
  const r = referenceDates('20260831'); // Monday
  assert.equal(r.weekday, '20260831');
  assert.equal(r.saturday, '20260829'); // nearest Saturday (2 days back)
  assert.equal(r.sunday, '20260830'); // nearest Sunday (yesterday)
});

test('referenceDates: weekend build keeps a weekday reference (prior Friday)', () => {
  assert.equal(referenceDates('20260829').weekday, '20260828'); // Sat → Fri
  assert.equal(referenceDates('20260830').weekday, '20260828'); // Sun → Fri
  assert.equal(referenceDates('20260829').saturday, '20260829'); // today
  assert.equal(referenceDates('20260830').sunday, '20260830'); // today
  assert.equal(referenceDates('20260830').saturday, '20260829'); // Sun → yesterday
});

const cal = (o) => ({
  monday: '0',
  tuesday: '0',
  wednesday: '0',
  thursday: '0',
  friday: '0',
  saturday: '0',
  sunday: '0',
  start_date: '20260101',
  end_date: '20261231',
  ...o,
});

test('plain Mon–Fri service lands in the weekday bucket', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [
      cal({
        service_id: 'WD',
        monday: '1',
        tuesday: '1',
        wednesday: '1',
        thursday: '1',
        friday: '1',
      }),
    ],
    calendarDates: [],
    todayStr: '20260831',
  });
  assert.deepEqual([...serviceDayType.get('WD')], ['weekday']);
});

test('Monday-only service is no longer dropped on a Monday build', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [cal({ service_id: 'MON', monday: '1' })],
    calendarDates: [],
    todayStr: '20260831',
  });
  assert.deepEqual([...serviceDayType.get('MON')], ['weekday']);
});

test('a Friday-only service is absent on a Monday build (does not run the reference day)', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [cal({ service_id: 'FRI', friday: '1' })],
    calendarDates: [],
    todayStr: '20260831', // Monday
  });
  assert.equal(serviceDayType.has('FRI'), false);
});

test('Saturday-only service still populates the saturday bucket on a weekday build', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [cal({ service_id: 'SAT', saturday: '1' })],
    calendarDates: [],
    todayStr: '20260831',
  });
  assert.deepEqual([...serviceDayType.get('SAT')], ['saturday']);
});

test('a Tue–Sat owl service feeds both the weekday and saturday buckets', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [
      cal({
        service_id: 'OWL',
        tuesday: '1',
        wednesday: '1',
        thursday: '1',
        friday: '1',
        saturday: '1',
      }),
    ],
    calendarDates: [],
    todayStr: '20260901', // Tuesday — the weekday reference is a day OWL runs
  });
  assert.deepEqual([...serviceDayType.get('OWL')].sort(), ['saturday', 'weekday']);
});

test('calendar_dates exception_type=2 removes the service from today only', () => {
  const { serviceDayType, removeForToday } = resolveServiceDayTypes({
    calendars: [
      cal({
        service_id: 'WD',
        monday: '1',
        tuesday: '1',
        wednesday: '1',
        thursday: '1',
        friday: '1',
      }),
    ],
    calendarDates: [{ date: '20260831', service_id: 'WD', exception_type: '2' }],
    todayStr: '20260831',
  });
  assert.equal(serviceDayType.has('WD'), false);
  assert.equal(removeForToday.has('WD'), true);
});

test('calendar_dates exception_type=1 adds a holiday-only service_id with no calendar row', () => {
  const { serviceDayType, addForToday } = resolveServiceDayTypes({
    calendars: [
      cal({
        service_id: 'WD',
        monday: '1',
        tuesday: '1',
        wednesday: '1',
        thursday: '1',
        friday: '1',
      }),
    ],
    calendarDates: [
      { date: '20260831', service_id: 'WD', exception_type: '2' },
      { date: '20260831', service_id: 'HOLIDAY', exception_type: '1' },
    ],
    todayStr: '20260831',
  });
  assert.deepEqual([...serviceDayType.get('HOLIDAY')], ['weekday']);
  assert.equal(serviceDayType.has('WD'), false);
  assert.equal(addForToday.has('HOLIDAY'), true);
});

test('a holiday add on a Saturday build maps to the saturday bucket', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [],
    calendarDates: [{ date: '20260829', service_id: 'JULY4', exception_type: '1' }],
    todayStr: '20260829', // Saturday
  });
  assert.deepEqual([...serviceDayType.get('JULY4')], ['saturday']);
});

test('service_ids outside their active date range are excluded', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [
      cal({ service_id: 'SUMMER', sunday: '1', start_date: '20260601', end_date: '20260831' }),
    ],
    calendarDates: [],
    todayStr: '20260906', // a Sunday after the range
  });
  assert.equal(serviceDayType.has('SUMMER'), false);
});

test('filter constants are sane', () => {
  assert.ok(MIN_PATTERN_TRIPS >= 8);
  assert.ok(TWO_TRIP_MIN_HEADWAY_MIN >= 5);
});
