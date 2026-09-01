const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveServiceDayTypes,
  referenceDates,
  MIN_PATTERN_TRIPS,
  TWO_TRIP_MIN_HEADWAY_MIN,
} = require('../../scripts/fetch-gtfs');

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
