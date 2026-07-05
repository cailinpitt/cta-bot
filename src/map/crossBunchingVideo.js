// Cross-route bunching timelapse — animates a multi-route cluster over the
// observation window. Unlike the per-route videos, vehicles aren't snapped to
// one polyline (the cluster spans routes), so motion is a free lat/lon glide:
// the shared dropout kernel (src/shared/videoTracks.js) with no `pointAlong`
// interpolates positions and fades vehicles that drop out. Generic over bus and
// train — the bin passes member rows already tagged with disc label + route
// color group.
const { buildVehicleSeries, vehicleStateAt } = require('../shared/videoTracks');
const { computeCrossView, fetchCrossBaseMap, renderCrossFrame } = require('./crossBunching');
const { encodeFrames } = require('../shared/video');

const INTERPOLATE = 4; // in-between frames per observation gap, for smooth glide
const TAIL_FADE_MS = 60 * 1000; // fade a dropped vehicle out over a minute

// `memberRows`: [{ id, lat, lon, ts, label, groupIndex }] over the window — all
// members of the cluster, one row per observation. `routePaths` (optional):
// [{ points:[{lat,lon}], groupIndex }] for each route, baked into the shared
// base map so the lines sit under the gliding discs. `colors` (optional):
// per-group hex overrides (official line colors) aligned to groupIndex. Returns
// { buffer, elapsedSec } or null (<2 distinct snapshots / encode produced nothing).
async function captureCrossBunchingVideo(
  memberRows,
  {
    legend = [],
    title = '',
    markerKind = 'bus',
    routePaths = [],
    colors = [],
    interpolate = INTERPOLATE,
  } = {},
) {
  const rows = (memberRows || []).filter(
    (r) => Number.isFinite(r?.lat) && Number.isFinite(r?.lon) && Number.isFinite(r?.ts),
  );
  if (rows.length < 2) return null;

  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  const snapshots = [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ts, vehicles]) => ({ ts, vehicles }));
  if (snapshots.length < 2) return null;

  const view = computeCrossView(rows.map((r) => ({ lat: r.lat, lon: r.lon })));
  const baseMap = await fetchCrossBaseMap(view, routePaths, colors);

  const series = buildVehicleSeries(snapshots, {
    itemsOf: (s) => s.vehicles,
    idOf: (v) => v.id,
    trackOf: () => null, // no polyline → lat/lon lerp
  });
  const startTs = snapshots[0].ts;
  const videoEndTs = snapshots[snapshots.length - 1].ts;

  const frames = [];
  const times = [];
  const pushFrame = (ts) => {
    const vehicles = [];
    for (const s of series.values()) {
      const st = vehicleStateAt(s, ts, { pointAlong: null, videoEndTs, tailFadeMs: TAIL_FADE_MS });
      if (st) vehicles.push(st);
    }
    frames.push(vehicles);
    times.push(ts);
  };
  for (let i = 0; i < snapshots.length - 1; i++) {
    const span = snapshots[i + 1].ts - snapshots[i].ts;
    for (let k = 0; k < interpolate; k++) pushFrame(snapshots[i].ts + (span * k) / interpolate);
  }
  pushFrame(videoEndTs);

  const totalSec = Math.max(1, (videoEndTs - startTs) / 1000);
  const images = [];
  for (let i = 0; i < frames.length; i++) {
    images.push(
      await renderCrossFrame(view, baseMap, frames[i], {
        legend,
        title,
        markerKind,
        colors,
        clock: { elapsedSec: (times[i] - startTs) / 1000, totalSec },
      }),
    );
  }
  const buffer = await encodeFrames(images, { prefix: 'cta-cross-bunch' });
  if (!buffer) return null;
  return { buffer, elapsedSec: Math.round((videoEndTs - startTs) / 1000) };
}

module.exports = { captureCrossBunchingVideo, INTERPOLATE };
