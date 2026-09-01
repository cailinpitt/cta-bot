const STALE_MS = 3 * 60 * 1000;
// 10 mph ≈ 880 ft/min once stops + signals are factored in. Crude, but only
// used as a ratio against GTFS-scheduled headway — not an absolute ETA.
const TYPICAL_SPEED_FT_PER_MIN = 880;
const { terminalZoneFt } = require('../shared/geo');
// Absolute floor protects low-frequency routes (30-min schedule) from
// spamming on every 31-min drift.
const RATIO_THRESHOLD = 2.5;
const ABSOLUTE_MIN_MIN = 15;

// `scheduledTraverseFor(trailing, leading)` → CTA-timetabled minutes to cover
// the empty stretch between the two buses, or null. When available it replaces
// the flat-10-mph estimate (which overstates express-on-Lake-Shore-Drive gaps
// ~2x). Trusted only when it lands in a sane band around the crude estimate —
// the schedule can be much faster on express segments, rarely much slower.
function detectAllGaps(
  vehicles,
  expectedHeadwayForPid,
  patternForPid,
  now = new Date(),
  scheduledTraverseFor = null,
) {
  const fresh = vehicles.filter((v) => now - v.tmstmp < STALE_MS);

  const byPid = new Map();
  for (const v of fresh) {
    if (!byPid.has(v.pid)) byPid.set(v.pid, []);
    byPid.get(v.pid).push(v);
  }

  const gaps = [];
  for (const [pid, group] of byPid) {
    if (group.length < 2) continue;
    const expectedMin = expectedHeadwayForPid(pid);
    if (expectedMin == null) continue;

    const sorted = [...group].sort((a, b) => a.pdist - b.pdist);
    const pattern = patternForPid(pid);
    const patternLengthFt = pattern?.lengthFt || 0;
    if (!patternLengthFt) continue;
    const zoneFt = terminalZoneFt(patternLengthFt);
    // Named stops along the pattern, used to find the pair flanking each gap.
    const patternStops = (pattern?.points || []).filter(
      (p) => p.type === 'S' && p.stopName && p.pdist != null,
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const gapFt = b.pdist - a.pdist;
      const distGapMin = gapFt / TYPICAL_SPEED_FT_PER_MIN;

      // Buses inside the terminal zone aren't in "service territory" yet —
      // their headway measurement against the next bus is misleading.
      if (a.pdist < zoneFt) continue;
      if (patternLengthFt - b.pdist < zoneFt) continue;

      // Prefer CTA's scheduled run time for this exact stretch over the flat
      // 10-mph model. Guard band: schedule up to 4x faster (express segments)
      // and up to 2x slower than the crude estimate — outside that is a
      // misprojection (short-turn trip, terminal clamp), so keep the flat number.
      const schedGapMin = scheduledTraverseFor ? scheduledTraverseFor(a, b) : null;
      const schedBased =
        schedGapMin != null && schedGapMin >= distGapMin / 4 && schedGapMin <= distGapMin * 2;
      const gapMin = schedBased ? schedGapMin : distGapMin;

      const ratio = gapMin / expectedMin;
      if (gapMin < ABSOLUTE_MIN_MIN) continue;
      if (ratio < RATIO_THRESHOLD) continue;

      // Stops flanking the empty stretch — the stop just *outside* each bus — so
      // the post can name the gap as a range ("between A and B") instead of
      // collapsing a multi-mile hole onto one stop. flankBefore sits behind the
      // trailing bus (a, lower pdist); flankAfter sits ahead of the leading bus
      // (b, higher pdist).
      let flankBefore = null;
      let flankAfter = null;
      for (const s of patternStops) {
        if (s.pdist < a.pdist) {
          if (!flankBefore || s.pdist > flankBefore.pdist) flankBefore = s;
        } else if (s.pdist > b.pdist) {
          if (!flankAfter || s.pdist < flankAfter.pdist) flankAfter = s;
        }
      }

      gaps.push({
        pid,
        route: a.route,
        // a is upstream (sorted by pdist asc) — a rider near `leading` (b) just
        // watched it pass and is waiting on `trailing` (a).
        leading: b,
        trailing: a,
        flankBefore: flankBefore
          ? {
              stopName: flankBefore.stopName,
              pdist: flankBefore.pdist,
              lat: flankBefore.lat,
              lon: flankBefore.lon,
            }
          : null,
        flankAfter: flankAfter
          ? {
              stopName: flankAfter.stopName,
              pdist: flankAfter.pdist,
              lat: flankAfter.lat,
              lon: flankAfter.lon,
            }
          : null,
        gapFt,
        gapMin,
        gapMinDist: distGapMin,
        schedBased,
        expectedMin,
        ratio,
      });
    }
  }

  gaps.sort((a, b) => b.ratio - a.ratio);
  return gaps;
}

module.exports = { detectAllGaps, RATIO_THRESHOLD, ABSOLUTE_MIN_MIN, TYPICAL_SPEED_FT_PER_MIN };
