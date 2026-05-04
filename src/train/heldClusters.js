// Held-train cluster detection (Phase 1). Complementary to detectDeadSegments
// which finds bins with no observations: held-cluster finds groups of trains
// that ARE pinging but aren't moving — the failure mode where CTA stops
// service mid-run and trains sit at stations with their doors open.

const { buildLineBranches, snapToLineWithPerp, inLoopTrunk } = require('./speedmap');
const { lineLabel } = require('./api');
const { classifyTrainMotion } = require('./motion');
const { MAX_PERP_FT, stationsAlongBranch, directionKeyFor } = require('./pulse');
const { terminalZoneFt } = require('../shared/geo');

const DEFAULT_HELD_CLUSTER_FT = 5280; // 1 mi
const DEFAULT_HELD_MIN_TRAINS = 2;
const DEFAULT_HELD_MIN_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MOVING_VETO_FT = 5280;

function detectHeldClusters({ line, trainLines, stations, headwayMin, now, recent, opts = {} }) {
  const clusterFt = opts.clusterFt || DEFAULT_HELD_CLUSTER_FT;
  const minTrains = opts.minTrains || DEFAULT_HELD_MIN_TRAINS;
  const minDurationMs = Math.max(
    DEFAULT_HELD_MIN_DURATION_MS,
    headwayMin != null ? 1.5 * headwayMin * 60 * 1000 : DEFAULT_HELD_MIN_DURATION_MS,
  );
  const movingVetoFt = opts.movingVetoFt || DEFAULT_MOVING_VETO_FT;

  const branches = buildLineBranches(trainLines, line);
  if (branches.length === 0 || !recent || recent.length === 0) {
    return { skipped: 'no-input', candidates: [] };
  }

  const motion = classifyTrainMotion({ line, trainLines, recent, now, opts });

  const candidates = [];
  for (let bi = 0; bi < branches.length; bi++) {
    const branch = branches[bi];
    const { points, cumDist, totalFt, trDrFilter, directionHint } = branch;
    if (!points || points.length < 2 || !totalFt) continue;

    const stationary = [];
    const moving = [];
    for (const [rn, m] of motion) {
      if (m.branchIdx !== bi) continue;
      const trainObs = recent.filter((p) => p.rn === rn);
      if (trainObs.length === 0) continue;
      const last = trainObs[trainObs.length - 1];
      const { cumDist: along, perpDist } = snapToLineWithPerp(last.lat, last.lon, points, cumDist);
      if (perpDist > MAX_PERP_FT) continue;
      // Loop-trunk override doesn't apply here — we want per-direction held
      // detection on round-trip lines too.
      if (trDrFilter && last.trDr !== trDrFilter && !inLoopTrunk(last.lat, last.lon)) continue;
      if (m.bucket === 'stationary' && m.spanMs >= minDurationMs) {
        stationary.push({ rn, along, motion: m });
      } else if (m.bucket === 'moving') {
        moving.push({ rn, along, motion: m });
      }
    }
    if (stationary.length < minTrains) continue;

    stationary.sort((a, b) => a.along - b.along);
    let bestStart = 0;
    let bestEnd = 0;
    for (let i = 0; i < stationary.length; i++) {
      let j = i;
      while (
        j + 1 < stationary.length &&
        stationary[j + 1].along - stationary[i].along <= clusterFt
      ) {
        j++;
      }
      if (j - i > bestEnd - bestStart) {
        bestStart = i;
        bestEnd = j;
      }
    }
    const cluster = stationary.slice(bestStart, bestEnd + 1);
    if (cluster.length < minTrains) continue;
    const clusterLoFt = cluster[0].along;
    const clusterHiFt = cluster[cluster.length - 1].along;
    const clusterMidFt = (clusterLoFt + clusterHiFt) / 2;

    const movingNearCluster = moving.filter(
      (m) => Math.abs(m.along - clusterMidFt) <= movingVetoFt,
    );
    if (movingNearCluster.length > 0) continue;

    const zoneFt = terminalZoneFt(totalFt);
    if (clusterLoFt < zoneFt || clusterHiFt > totalFt - zoneFt) continue;

    const stationsOnBranch = stationsAlongBranch(stations, line, points, cumDist);
    if (stationsOnBranch.length === 0) continue;
    const stationsInRun = stationsOnBranch.filter(
      (s) => s.trackDist >= clusterLoFt - 2640 && s.trackDist <= clusterHiFt + 2640,
    );
    if (stationsInRun.length < 1) continue;
    const fromStation = stationsInRun[0];
    const toStation = stationsInRun[stationsInRun.length - 1];
    if (fromStation.station.name === toStation.station.name) continue;

    const stationaryMs = Math.max(...cluster.map((c) => c.motion.spanMs));

    candidates.push({
      line,
      direction: directionKeyFor(branches, bi, directionHint),
      directionHint: directionHint || null,
      runLoFt: clusterLoFt,
      runHiFt: clusterHiFt,
      runLengthFt: clusterHiFt - clusterLoFt,
      fromStation: fromStation.station,
      toStation: toStation.station,
      coldBins: 0,
      totalBins: 0,
      observedTrainsInWindow: motion.size,
      lastSeenInRunMs: now,
      coldThresholdMs: minDurationMs,
      lookbackMs: minDurationMs * 2,
      trainsOutsideRun: moving.length,
      coldStations: stationsInRun.length,
      coldStationNames: stationsInRun.map((s) => s.station.name),
      expectedTrains: null,
      headwayMin: headwayMin != null ? headwayMin : null,
      directionDestinationName: null,
      kind: 'held',
      heldEvidence: {
        trainCount: cluster.length,
        stationaryMs,
        cohesionFt: clusterHiFt - clusterLoFt,
        trainRns: cluster.map((c) => c.rn),
      },
    });
    if (process.env.PULSE_VERBOSE) {
      console.log(
        `[${lineLabel(line)}/branch${bi}] held cluster: ${cluster.length} trains across ${(clusterHiFt - clusterLoFt) / 5280}mi for ${Math.round(stationaryMs / 60000)}min`,
      );
    }
  }

  candidates.sort((a, b) => {
    if (b.heldEvidence.trainCount !== a.heldEvidence.trainCount) {
      return b.heldEvidence.trainCount - a.heldEvidence.trainCount;
    }
    return b.heldEvidence.stationaryMs - a.heldEvidence.stationaryMs;
  });
  return { skipped: null, candidates };
}

module.exports = {
  detectHeldClusters,
  DEFAULT_HELD_CLUSTER_FT,
  DEFAULT_HELD_MIN_TRAINS,
  DEFAULT_HELD_MIN_DURATION_MS,
};
