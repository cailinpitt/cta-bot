const test = require('node:test');
const assert = require('node:assert');
const {
  splitPatternByPdist,
  nearestStopOnPattern,
  terminalStops,
} = require('../../src/map/bus/disruption');

function buildPattern() {
  // 8 vertices with monotonically-increasing pdist: a-b-c-d-e-f-g-h
  // 4 of them are stops (S), the rest are waypoints (W).
  return {
    points: [
      { lat: 41.99, lon: -87.66, pdist: 0, type: 'S', stopName: 'Howard Terminal' },
      { lat: 41.985, lon: -87.66, pdist: 1000, type: 'W' },
      { lat: 41.98, lon: -87.66, pdist: 2000, type: 'S', stopName: 'Thorndale' },
      { lat: 41.97, lon: -87.66, pdist: 3500, type: 'W' },
      { lat: 41.96, lon: -87.66, pdist: 5000, type: 'S', stopName: 'Foster' },
      { lat: 41.95, lon: -87.66, pdist: 7000, type: 'W' },
      { lat: 41.93, lon: -87.66, pdist: 9000, type: 'S', stopName: 'Lawrence' },
      { lat: 41.9, lon: -87.66, pdist: 12000, type: 'S', stopName: 'Belmont Loop' },
    ],
  };
}

test('splitPatternByPdist: focus zone splits into before / inside / after', () => {
  const pattern = buildPattern();
  const { before, inside, after } = splitPatternByPdist(pattern, 1500, 6000);
  assert.ok(before.length >= 2, 'before should have ≥2 vertices');
  assert.ok(inside.length >= 2, 'inside should have ≥2 vertices');
  assert.ok(after.length >= 2, 'after should have ≥2 vertices');
});

test('splitPatternByPdist: boundary vertex is duplicated into the next bucket', () => {
  const pattern = buildPattern();
  const { before, inside } = splitPatternByPdist(pattern, 2500, 6000);
  // The vertex at pdist=2000 ends `before`; it should also lead `inside`
  // so the two strokes touch end-to-end with no gap.
  const beforeLast = before[before.length - 1];
  const insideFirst = inside[0];
  assert.deepEqual(beforeLast, insideFirst, 'boundary vertex should be repeated');
});

test('splitPatternByPdist: focus covering whole route → empty before/after', () => {
  const pattern = buildPattern();
  const { before, inside, after } = splitPatternByPdist(pattern, -1, 99999);
  assert.equal(before.length, 0);
  assert.equal(after.length, 0);
  assert.ok(inside.length === pattern.points.length);
});

test('nearestStopOnPattern picks the stop closest to a target pdist', () => {
  const pattern = buildPattern();
  assert.equal(nearestStopOnPattern(pattern, 4900).stopName, 'Foster');
  assert.equal(nearestStopOnPattern(pattern, 1500).stopName, 'Thorndale');
  assert.equal(nearestStopOnPattern(pattern, 50).stopName, 'Howard Terminal');
});

test('terminalStops returns first and last named stops', () => {
  const t = terminalStops(buildPattern());
  assert.equal(t.from.stopName, 'Howard Terminal');
  assert.equal(t.to.stopName, 'Belmont Loop');
});

test('terminalStops returns null when fewer than 2 named stops exist', () => {
  const t = terminalStops({ points: [{ pdist: 0, type: 'S', stopName: 'Only' }] });
  assert.equal(t, null);
});

test('splitPatternByPdist drops vertices missing pdist or coords', () => {
  const pattern = {
    points: [
      { pdist: 0, lat: 41, lon: -87, type: 'S' },
      { pdist: null, lat: 42, lon: -87 },
      { pdist: 100, lat: 41.5, lon: -87 },
      { pdist: 200, lat: null, lon: -87 },
      { pdist: 300, lat: 41.6, lon: -87 },
    ],
  };
  const out = splitPatternByPdist(pattern, 50, 250);
  // 3 valid vertices: pdist=0 (before), 100 (inside), 300 (after)
  // Boundary duplication: 0 also leads inside, 100 also leads after.
  assert.equal(out.before.length, 1);
  assert.equal(out.inside.length, 2);
  assert.equal(out.after.length, 2);
});
