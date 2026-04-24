// Ghost train detection. Mirrors detectBusGhosts — compares observed active
// train count (median per snapshot) against the scheduled active-trip count
// per hour (trips whose [dep, arr] interval overlaps the current hour),
// grouped by (line, trDr).

const { MISSING_PCT_THRESHOLD, MISSING_ABS_THRESHOLD, MIN_SNAPSHOTS, MIN_OBSERVED, MAX_EXPECTED_ACTIVE, RAMP_FILL_RATIO, RAMP_TAIL_FRACTION } = require('../bus/ghosts');
const { median } = require('../shared/stats');

function tailMedian(perSnapshot) {
  const pairs = [...perSnapshot.entries()].sort((a, b) => a[0] - b[0]);
  const tailLen = Math.max(3, Math.ceil(pairs.length * RAMP_TAIL_FRACTION));
  const tail = pairs.slice(-tailLen).map(([, set]) => set.size);
  return median(tail);
}

/**
 * Detect ghost trains for a set of lines over a time window.
 *
 * Dependencies injected:
 *   - `getObservations(line)` → [{ ts, direction (trDr), vehicle_id, destination }]
 *   - `findStation(line, destinationName)` → { lat, lon, name } | null
 *   - `expectedHeadway(line, destinationStation)` → minutes or null
 *   - `expectedDuration(line, destinationStation)` → minutes or null
 *   - `isLoopLine(line)` → true for lines whose GTFS ships a single
 *     direction_id covering the full round trip (Brown/Orange/Pink/Purple/
 *     Yellow). Optional; defaults to false. Loop lines can't be split by
 *     trDr without halving the expected count — it's simpler to compare the
 *     line-wide observed vehicle count against the line-wide expected.
 */
async function detectTrainGhosts({
  lines,
  getObservations,
  findStation,
  expectedHeadway,
  expectedDuration,
  expectedActive,
  isLoopLine,
}) {
  const events = [];

  for (const line of lines) {
    const obs = getObservations(line);
    if (obs.length === 0) continue;

    // Loop lines: aggregate across trDrs. GTFS gives us one duration (full
    // Midway→Loop→Midway leg) and one headway for the whole line, so
    // `duration / headway` is the total active train count line-wide — which
    // is what we need to compare against.
    if (isLoopLine && isLoopLine(line)) {
      const headway = expectedHeadway(line, null);
      const duration = expectedDuration(line, null);
      const active = expectedActive(line, null);
      if (active == null || active <= 0) continue;

      if (active < 2) continue;
      if (active > MAX_EXPECTED_ACTIVE) {
        console.warn(`ghosts: ${line} line-wide expectedActive=${active.toFixed(1)} exceeds cap (${MAX_EXPECTED_ACTIVE}) — skipping, likely schedule-index bug`);
        continue;
      }

      const perSnapshot = new Map();
      for (const o of obs) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = active - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / active < MISSING_PCT_THRESHOLD) continue;
      if (observedActive < MIN_OBSERVED) continue;
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
      const stddev = Math.sqrt(variance);
      if (stddev > observedActive) continue;
      if (tailMedian(perSnapshot) >= RAMP_FILL_RATIO * active) continue;

      events.push({
        line,
        trDr: null,
        destination: null,
        expectedActive: active,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
        headway,
        duration,
      });
      continue;
    }

    // Bi-directional lines: group by trDr and use the direction-specific
    // GTFS headway/duration selected by destination.
    const byDir = new Map(); // trDr → observations[]
    for (const o of obs) {
      if (!o.direction) continue;
      if (!byDir.has(o.direction)) byDir.set(o.direction, []);
      byDir.get(o.direction).push(o);
    }

    for (const [trDr, group] of byDir) {
      // Prefer a destination that resolves to a flagged terminal station.
      // Short-turn destinations (e.g. UIC-Halsted on the Blue) would otherwise
      // point the headway lookup at a mid-route station whose terminalLat/Lon
      // doesn't match either GTFS direction cleanly, producing an unreliable
      // expectedActive. Skip the direction entirely if no terminal destination
      // was seen — safety > coverage.
      const destinations = [...new Set(group.map((o) => o.destination).filter(Boolean))];
      let bestDest = null;
      let destStation = null;
      for (const d of destinations) {
        const s = findStation(line, d);
        if (s && s.isTerminal) { bestDest = d; destStation = s; break; }
      }
      if (!destStation) continue;
      const sampleDest = bestDest;
      const headway = expectedHeadway(line, destStation);
      const duration = expectedDuration(line, destStation);
      const active = expectedActive(line, destStation);
      if (active == null || active <= 0) continue;

      if (active < 2) continue;
      if (active > MAX_EXPECTED_ACTIVE) {
        console.warn(`ghosts: ${line}/${trDr} expectedActive=${active.toFixed(1)} exceeds cap (${MAX_EXPECTED_ACTIVE}) — skipping, likely schedule-index bug`);
        continue;
      }

      const perSnapshot = new Map();
      for (const o of group) {
        if (!perSnapshot.has(o.ts)) perSnapshot.set(o.ts, new Set());
        perSnapshot.get(o.ts).add(o.vehicle_id);
      }
      if (perSnapshot.size < MIN_SNAPSHOTS) continue;

      const counts = [...perSnapshot.values()].map((s) => s.size);
      const observedActive = median(counts);
      const missing = active - observedActive;
      if (missing < MISSING_ABS_THRESHOLD) continue;
      if (missing / active < MISSING_PCT_THRESHOLD) continue;
      if (observedActive < MIN_OBSERVED) continue;
      const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
      const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
      const stddev = Math.sqrt(variance);
      if (stddev > observedActive) continue;
      if (tailMedian(perSnapshot) >= RAMP_FILL_RATIO * active) continue;

      events.push({
        line,
        trDr,
        destination: sampleDest,
        expectedActive: active,
        observedActive,
        missing,
        snapshots: perSnapshot.size,
        headway,
        duration,
      });
    }
  }

  events.sort((a, b) => b.missing - a.missing);
  return events;
}

module.exports = { detectTrainGhosts };
