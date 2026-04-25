const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeBusDominantOrigin,
  BUS_DOMINANCE_THRESHOLD,
  resolveServiceDayTypes,
} = require('../../scripts/fetch-gtfs');

function mkTrips(spec) {
  const tripMeta = new Map();
  const firstStopId = new Map();
  let n = 0;
  for (const { route, dir, origin, count, mode = 'bus' } of spec) {
    for (let i = 0; i < count; i++) {
      const id = `T${n++}`;
      tripMeta.set(id, { route, dir, mode });
      firstStopId.set(id, origin);
    }
  }
  return { tripMeta, firstStopId };
}

test('threshold constant is 60%', () => {
  assert.equal(BUS_DOMINANCE_THRESHOLD, 0.6);
});

test('dominance locks onto the main origin when it carries >=60% of trips', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '55', dir: '0', origin: 'MAIN', count: 80 },
    { route: '55', dir: '0', origin: 'GARAGE', count: 20 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('55|0'), 'MAIN');
});

test('dominance skips the key when the top origin is under 60% (keeps all origins)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '66', dir: '1', origin: 'A', count: 50 },
    { route: '66', dir: '1', origin: 'B', count: 50 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.has('66|1'), false);
});

test('rail trips are ignored entirely', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: 'Red', dir: '0', origin: 'HOWARD', count: 100, mode: 'rail' },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.size, 0);
});

test('exactly 60% qualifies (>= threshold, not strictly greater)', () => {
  const { tripMeta, firstStopId } = mkTrips([
    { route: '77', dir: '0', origin: 'MAIN', count: 6 },
    { route: '77', dir: '0', origin: 'ALT', count: 4 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('77|0'), 'MAIN');
});

test('trips missing an origin are skipped without crashing', () => {
  const tripMeta = new Map([
    ['T1', { route: '9', dir: '0', mode: 'bus' }],
    ['T2', { route: '9', dir: '0', mode: 'bus' }],
    ['T3', { route: '9', dir: '0', mode: 'bus' }],
  ]);
  const firstStopId = new Map([
    ['T1', 'X'],
    ['T2', 'X'],
  ]); // T3 has no origin
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('9|0'), 'X');
});

const WEEKDAY_CAL = {
  service_id: 'REG',
  monday: '1',
  tuesday: '1',
  wednesday: '1',
  thursday: '1',
  friday: '1',
  saturday: '0',
  sunday: '0',
  start_date: '20260101',
  end_date: '20261231',
};
const SUNDAY_CAL = {
  service_id: 'SUN',
  monday: '0',
  tuesday: '0',
  wednesday: '0',
  thursday: '0',
  friday: '0',
  saturday: '0',
  sunday: '1',
  start_date: '20260101',
  end_date: '20261231',
};

test('calendar_dates exception_type=2 removes the regular service_id on the target date', () => {
  const { serviceDayType, removeForToday } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [{ date: '20260525', service_id: 'REG', exception_type: '2' }],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.has('REG'), false);
  assert.equal(removeForToday.has('REG'), true);
});

test('calendar_dates exception_type=1 adds a holiday-only service_id', () => {
  const { serviceDayType, addForToday } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [
      { date: '20260525', service_id: 'REG', exception_type: '2' },
      { date: '20260525', service_id: 'HOLIDAY', exception_type: '1' },
    ],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.get('HOLIDAY'), 'weekday');
  assert.equal(addForToday.has('HOLIDAY'), true);
  assert.equal(serviceDayType.has('REG'), false);
});

test('calendar_dates exceptions for other dates are ignored', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [WEEKDAY_CAL],
    calendarDates: [{ date: '20260526', service_id: 'REG', exception_type: '2' }],
    todayStr: '20260525',
    todayDow: 'Mon',
  });
  assert.equal(serviceDayType.get('REG'), 'weekday');
});

test('added holiday service_id maps to saturday when today is Saturday', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [],
    calendarDates: [{ date: '20260704', service_id: 'JULY4', exception_type: '1' }],
    todayStr: '20260704',
    todayDow: 'Sat',
  });
  assert.equal(serviceDayType.get('JULY4'), 'saturday');
});

test('service_ids outside their active date range are still excluded', () => {
  const { serviceDayType } = resolveServiceDayTypes({
    calendars: [{ ...SUNDAY_CAL, start_date: '20260601', end_date: '20260831' }],
    calendarDates: [],
    todayStr: '20260422',
    todayDow: 'Wed',
  });
  assert.equal(serviceDayType.has('SUN'), false);
});

test('staggered two-origin scenario: dominant terminal drives bucketing', () => {
  // Simulates Bug C: a main terminal with 70% of trips plus a garage pullout
  // with 30%. The dominance filter keeps only main-terminal trips downstream
  // so the per-hour headway median reflects the rider-facing schedule.
  const { tripMeta, firstStopId } = mkTrips([
    { route: '20', dir: '0', origin: 'TERMINAL', count: 70 },
    { route: '20', dir: '0', origin: 'GARAGE', count: 30 },
  ]);
  const dom = computeBusDominantOrigin(tripMeta, firstStopId);
  assert.equal(dom.get('20|0'), 'TERMINAL');
});
