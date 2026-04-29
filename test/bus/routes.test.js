const test = require('node:test');
const assert = require('node:assert/strict');
const { loadIndex } = require('../../src/shared/gtfs');
const { ghosts, gaps } = require('../../src/bus/routes');

// Gaps and ghosts both *require* GTFS lookups (headway/expected-active gates)
// — a missing index entry there silently disables detection. allRoutes is
// broader (includes Night Owl + seasonal variants that CTA omits from the
// published GTFS feed); pulse tolerates missing entries by skipping the
// route, so it's not asserted here.
test('every gap/ghost-polled bus route is present in the GTFS index', () => {
  const idx = loadIndex();
  const polled = [...new Set([...ghosts, ...gaps])];
  const missing = polled.filter((r) => !idx.routes[r]);
  assert.deepEqual(missing, [], `re-run scripts/fetch-gtfs.js to index: ${missing.join(', ')}`);
});
