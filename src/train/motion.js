// Per-train motion classification, used by held-train detection (Phase 1).
// Pure function; no DB writes.

const { buildLineBranches, snapToLineWithPerp } = require('./speedmap');
const { MAX_PERP_FT } = require('./pulse');

const DEFAULT_STATIONARY_FT = 500;
// Two pings in the same place over a ≥5 min span is enough to call a train
// stationary. Demanding three pings was rejecting genuinely-held trains during
// outages — the failure mode where a held train's GPS goes sparse (or stops
// entirely) often produces exactly 1-2 obs before silence, which used to fall
// to 'unknown' and never count toward held-cluster detection.
const DEFAULT_STATIONARY_MIN_OBS = 2;
const DEFAULT_STATIONARY_MIN_SPAN_MS = 5 * 60 * 1000;
const DEFAULT_MOVING_MIN_FT = 500;
const DEFAULT_MOVING_MIN_OBS = 2;

function classifyTrainMotion({ line, trainLines, recent, now: _now, opts = {} }) {
  const stationaryFt = opts.stationaryFt || DEFAULT_STATIONARY_FT;
  const stationaryMinObs = opts.stationaryMinObs || DEFAULT_STATIONARY_MIN_OBS;
  const stationaryMinSpanMs = opts.stationaryMinSpanMs || DEFAULT_STATIONARY_MIN_SPAN_MS;
  const movingMinFt = opts.movingMinFt || DEFAULT_MOVING_MIN_FT;
  const movingMinObs = opts.movingMinObs || DEFAULT_MOVING_MIN_OBS;

  const branches = buildLineBranches(trainLines, line);
  const result = new Map();
  if (branches.length === 0 || !recent || recent.length === 0) return result;

  const byTrain = new Map();
  for (const p of recent) {
    if (!p.rn) continue;
    let best = { branchIdx: -1, along: 0, perp: Infinity };
    for (let bi = 0; bi < branches.length; bi++) {
      const b = branches[bi];
      if (!b.points || b.points.length < 2) continue;
      const { cumDist: along, perpDist } = snapToLineWithPerp(p.lat, p.lon, b.points, b.cumDist);
      if (perpDist < best.perp) best = { branchIdx: bi, along, perp: perpDist };
    }
    if (best.branchIdx < 0 || best.perp > MAX_PERP_FT) continue;
    let arr = byTrain.get(p.rn);
    if (!arr) {
      arr = [];
      byTrain.set(p.rn, arr);
    }
    arr.push({ ts: p.ts, along: best.along, branchIdx: best.branchIdx, trDr: p.trDr });
  }

  for (const [rn, obs] of byTrain) {
    obs.sort((a, b) => a.ts - b.ts);
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    let minTs = Infinity;
    let maxTs = -Infinity;
    const branchCounts = new Map();
    for (const o of obs) {
      if (o.along < minAlong) minAlong = o.along;
      if (o.along > maxAlong) maxAlong = o.along;
      if (o.ts < minTs) minTs = o.ts;
      if (o.ts > maxTs) maxTs = o.ts;
      branchCounts.set(o.branchIdx, (branchCounts.get(o.branchIdx) || 0) + 1);
    }
    const displacementFt = maxAlong - minAlong;
    const obsCount = obs.length;
    const spanMs = maxTs - minTs;

    let dominantBranch = -1;
    let bestCount = -1;
    for (const [bi, count] of branchCounts) {
      if (count > bestCount) {
        bestCount = count;
        dominantBranch = bi;
      }
    }
    const dominantTrDr = obs[obs.length - 1]?.trDr || null;

    let bucket = 'unknown';
    if (
      displacementFt <= stationaryFt &&
      obsCount >= stationaryMinObs &&
      spanMs >= stationaryMinSpanMs
    ) {
      bucket = 'stationary';
    } else if (displacementFt >= movingMinFt && obsCount >= movingMinObs) {
      bucket = 'moving';
    }

    result.set(rn, {
      bucket,
      displacementFt,
      obsCount,
      spanMs,
      branchIdx: dominantBranch,
      trDr: dominantTrDr,
      lastAlong: obs[obs.length - 1].along,
      firstTs: minTs,
      lastTs: maxTs,
    });
  }

  return result;
}

function summarizeMotion(motionMap) {
  let moving = 0;
  let stationary = 0;
  let unknown = 0;
  for (const m of motionMap.values()) {
    if (m.bucket === 'moving') moving++;
    else if (m.bucket === 'stationary') stationary++;
    else unknown++;
  }
  return { moving, stationary, unknown, total: motionMap.size };
}

module.exports = {
  classifyTrainMotion,
  summarizeMotion,
  DEFAULT_STATIONARY_FT,
  DEFAULT_STATIONARY_MIN_OBS,
  DEFAULT_STATIONARY_MIN_SPAN_MS,
  DEFAULT_MOVING_MIN_FT,
};
