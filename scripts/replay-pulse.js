#!/usr/bin/env node
// Replays pulse detection against the observations table at synthetic `now`
// values. Pure read-only — no DB writes, no Bluesky calls. Used to test
// detector changes against historical incidents (e.g. 2026-05-03 16:00–18:00)
// without burning a real shadow week.
//
// Usage:
//   node scripts/replay-pulse.js --line=red --start=2026-05-03T20:00Z --end=2026-05-03T22:30Z
//   node scripts/replay-pulse.js --all-lines --start=...
//   node scripts/replay-pulse.js --days-back=7 --line=g

require('../src/shared/env');

const minimist = require('minimist');
const { detectDeadSegments } = require('../src/train/pulse');
const { detectHeldClusters } = require('../src/train/heldClusters');
const { ALL_LINES, lineLabel } = require('../src/train/api');
const {
  expectedTrainHeadwayMin,
  expectedTrainHeadwayMinAnyDir,
  expectedTrainActiveTripsAnyDir,
} = require('../src/shared/gtfs');
const { getRecentTrainPositions, getLineCorridorBbox } = require('../src/shared/observations');
const trainLines = require('../src/train/data/trainLines.json');
const trainStations = require('../src/train/data/trainStations.json');

const STEP_MS_DEFAULT = 5 * 60 * 1000;
const LOOKBACK_MS = 20 * 60 * 1000;
const COLD_HEADWAY_MULT_FOR_LOOKBACK = 2.5;
const RAMP_UP_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const CORRIDOR_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const COLD_START_RECENT_MS = 60 * 60 * 1000;

function safeHeadway(line, now) {
  try {
    const direct = expectedTrainHeadwayMin(line, null, new Date(now));
    if (direct != null) return direct;
    return expectedTrainHeadwayMinAnyDir(line, new Date(now));
  } catch (_e) {
    return null;
  }
}

function parseTime(v) {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`unparseable time: ${v}`);
  return t;
}

function parseStep(v) {
  if (!v) return STEP_MS_DEFAULT;
  const m = /^(\d+)(s|m|min|h)?$/.exec(v);
  if (!m) throw new Error(`unparseable step: ${v}`);
  const n = parseInt(m[1], 10);
  const unit = m[2] || 'm';
  if (unit === 's') return n * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  return n * 60 * 1000;
}

function tickOnce(line, now) {
  const headwayMin = safeHeadway(line, now);
  let expectedAnyDir = 0;
  try {
    expectedAnyDir = expectedTrainActiveTripsAnyDir(line, new Date(now));
  } catch (_e) {
    expectedAnyDir = 0;
  }
  if (expectedAnyDir < 1) {
    return { line, ts: now, status: 'wind-down', expectedAnyDir };
  }

  const LOOKBACK_BUFFER_MS = 5 * 60 * 1000;
  const headwayDrivenLookbackMs = headwayMin
    ? COLD_HEADWAY_MULT_FOR_LOOKBACK * headwayMin * 60 * 1000 + LOOKBACK_BUFFER_MS
    : 0;
  const lineLookbackMs = Math.max(LOOKBACK_MS, headwayDrivenLookbackMs);
  const sinceTs = now - lineLookbackMs;

  const allRecent = getRecentTrainPositions(sinceTs).filter((r) => r.ts <= now);
  const lineRecent = allRecent.filter((r) => r.line === line);
  const corridorBbox = getLineCorridorBbox(line, now - CORRIDOR_LOOKBACK_MS);
  const recentlyActive = !!getLineCorridorBbox(line, now - COLD_START_RECENT_MS);
  if (!recentlyActive) {
    return { line, ts: now, status: 'no-recent-obs' };
  }
  const longRecent = getRecentTrainPositions(now - RAMP_UP_LOOKBACK_MS)
    .filter((r) => r.ts <= now)
    .filter((r) => r.line === line);

  const detection = detectDeadSegments({
    line,
    trainLines,
    stations: trainStations,
    headwayMin,
    now,
    opts: {
      lookbackMs: lineLookbackMs,
      corridorBbox,
      recentPositions: lineRecent.map((r) => ({
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
        rn: r.rn,
        trDr: r.trDr,
      })),
      longLookbackPositions: longRecent.map((r) => ({
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
        trDr: r.trDr,
      })),
    },
  });

  let heldCandidates = [];
  try {
    const out = detectHeldClusters({
      line,
      trainLines,
      stations: trainStations,
      headwayMin,
      now,
      recent: lineRecent.map((r) => ({
        ts: r.ts,
        lat: r.lat,
        lon: r.lon,
        rn: r.rn,
        trDr: r.trDr,
      })),
    });
    heldCandidates = out.candidates || [];
  } catch (e) {
    heldCandidates = [];
    if (process.env.REPLAY_VERBOSE) console.error(`held detect failed: ${e.message}`);
  }

  return {
    line,
    ts: now,
    status: 'evaluated',
    headwayMin,
    skipped: detection.skipped || null,
    coldCandidates: detection.candidates || [],
    heldCandidates,
  };
}

function fmtTs(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', 'Z');
}

function summarizeTick(tick) {
  const tag = `[${fmtTs(tick.ts)}] ${lineLabel(tick.line)}`;
  if (tick.status === 'wind-down') return `${tag} wind-down (${tick.expectedAnyDir} trips/h)`;
  if (tick.status === 'no-recent-obs') return `${tag} no-recent-obs`;
  if (tick.skipped) return `${tag} skipped=${tick.skipped}`;
  const cold = tick.coldCandidates.length;
  const held = tick.heldCandidates.length;
  if (cold === 0 && held === 0) return `${tag} clear`;
  const parts = [];
  for (const c of tick.coldCandidates) {
    const colded = c.lastSeenInRunMs ? Math.round((tick.ts - c.lastSeenInRunMs) / 60000) : '?';
    parts.push(
      `cold ${c.fromStation.name}→${c.toStation.name} run=${(c.runLengthFt / 5280).toFixed(2)}mi coldMs=${colded}min stations=${c.coldStations}`,
    );
  }
  for (const h of tick.heldCandidates) {
    parts.push(
      `held ${h.fromStation.name}→${h.toStation.name} trains=${h.heldEvidence?.trainCount} stationaryMs=${Math.round((h.heldEvidence?.stationaryMs || 0) / 60000)}min`,
    );
  }
  return `${tag} ${parts.join(' | ')}`;
}

async function main() {
  const argv = minimist(process.argv.slice(2));
  let start = parseTime(argv.start);
  let end = parseTime(argv.end);
  const stepMs = parseStep(argv.step);
  const daysBack = argv['days-back'] ? parseInt(argv['days-back'], 10) : null;
  if (daysBack && !start) {
    end = end || Date.now();
    start = end - daysBack * 24 * 60 * 60 * 1000;
  }
  if (!start || !end) {
    console.error(
      'Usage: replay-pulse.js --start=ISO --end=ISO [--line=red] [--all-lines] [--step=5m]',
    );
    process.exit(2);
  }
  const lines = argv['all-lines'] ? ALL_LINES : argv.line ? [argv.line] : ['red'];

  let totalCold = 0;
  let totalHeld = 0;
  for (let now = start; now <= end; now += stepMs) {
    for (const line of lines) {
      const tick = tickOnce(line, now);
      if (tick.status === 'evaluated') {
        totalCold += tick.coldCandidates.length;
        totalHeld += tick.heldCandidates.length;
      }
      if (
        tick.status !== 'evaluated' ||
        tick.coldCandidates.length > 0 ||
        tick.heldCandidates.length > 0 ||
        argv.verbose
      ) {
        console.log(summarizeTick(tick));
      }
    }
  }
  console.log(
    `\nreplay summary: ${lines.length} line(s) × ${Math.ceil((end - start) / stepMs)} ticks → ${totalCold} cold candidate(s), ${totalHeld} held candidate(s)`,
  );
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
