#!/usr/bin/env node
// Cross-line train bunching: a cluster at one spot involving 2+ lines (e.g. the
// shared Loop track — Brown/Orange/Pink/Purple close together at Tower 18). detect →
// render station map → post (train account), keyed on the PLACE. Runs just
// before bin/train/bunching.js so its posted clusters suppress the per-line post
// for the same trains. Replies with a ~10-min timelapse (from observation
// history). Supports --dry-run.
require('../../src/shared/env');

const argv = require('minimist')(process.argv.slice(2));

const { getAllTrainPositions, LINE_COLORS } = require('../../src/train/api');
const { buildLinePolyline } = require('../../src/train/speedmap');
const trainLines = require('../../src/train/data/trainLines.json');
const { detectCrossLineBunches, groupByLine } = require('../../src/train/crossBunching');
const { getRecentTrainPositions } = require('../../src/shared/observations');
const { haversineFt } = require('../../src/shared/geo');
const stations = require('../../src/train/data/trainStations.json');
const { renderCrossBunchingMap, pointsFromCluster } = require('../../src/map');
const { captureCrossBunchingVideo } = require('../../src/map/crossBunchingVideo');
const {
  buildPostText,
  buildAltText,
  buildVideoPostText,
  buildVideoAltText,
  lineLabel,
} = require('../../src/train/crossBunchingPost');
const { loginTrain, postWithImage, postWithVideo, postText } = require('../../src/train/bluesky');
const { isOnCooldown } = require('../../src/shared/state');
const { commitAndPost } = require('../../src/shared/postDetection');
const history = require('../../src/shared/history');
const { setup, writeDryRunAsset, runBin } = require('../../src/shared/runBin');

const WINDOW_MS = 5 * 60 * 1000;
const VIDEO_WINDOW_MS = 10 * 60 * 1000; // history window for the timelapse reply
const STOPPED_DRIFT_FT = 350; // a train that moved < this across the window is stuck
const PLACE_MAX_FT = 2200; // a station farther than this isn't a fair label
const CROSS_TRAIN_DAILY_CAP = 2;

// Trains that barely moved across the recent window — the congestion gate.
function stoppedRunsFrom(rows) {
  const byRn = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (!byRn.has(r.rn)) byRn.set(r.rn, []);
    byRn.get(r.rn).push(r);
  }
  const stopped = new Set();
  for (const [rn, pts] of byRn) {
    if (pts.length < 2) continue;
    let drift = 0;
    for (let a = 0; a < pts.length; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const d = haversineFt(pts[a], pts[b]);
        if (d > drift) drift = d;
      }
    }
    if (drift <= STOPPED_DRIFT_FT) stopped.add(rn);
  }
  return stopped;
}

function nearestStation(centroid) {
  let best = null;
  for (const s of stations) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = haversineFt(centroid, s);
    if (!best || d < best.d) best = { d, name: s.name };
  }
  return best && best.d <= PLACE_MAX_FT ? best.name : null;
}

function placeKeyFor(centroid) {
  return `${centroid.lat.toFixed(3)},${centroid.lon.toFixed(3)}`;
}

// Route-line overlays for the map: each involved line's polyline, colored to
// match its discs + legend (groupIndex = index in groupOrder). The map module
// clips each to the framed intersection, so passing the whole line is fine.
// Best-effort — a line with no shape just renders without a trace line.
function buildRoutePaths(groupOrder) {
  const paths = [];
  for (let groupIndex = 0; groupIndex < groupOrder.length; groupIndex++) {
    // buildLinePolyline points are [lat, lon] arrays; the map wants { lat, lon }.
    const { points } = buildLinePolyline(trainLines, groupOrder[groupIndex]);
    const pts = (points || [])
      .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p) => ({ lat: p[0], lon: p[1] }));
    if (pts.length >= 2) paths.push({ points: pts, groupIndex });
  }
  return paths;
}

function recordSkip(cluster, placeKey, suppressed) {
  history.recordBunching({
    kind: 'train-multi',
    route: placeKey,
    direction: cluster.lines.join(','),
    vehicleCount: cluster.trains.length,
    severityFt: cluster.spanFt,
    nearStop: null,
    posted: false,
  });
  history.recordMetaSignal({
    kind: 'train',
    line: placeKey,
    direction: cluster.lines.join(','),
    source: 'cross-bunching',
    severity: Math.min(1, cluster.trains.length / 5),
    detail: { trains: cluster.trains.length, lines: cluster.lines, suppressed },
    posted: false,
  });
}

async function main() {
  setup();
  console.log('Fetching train positions...');
  const trains = await getAllTrainPositions();
  console.log(`Got ${trains.length} trains`);

  const stoppedRns = stoppedRunsFrom(getRecentTrainPositions(Date.now() - WINDOW_MS));
  const clusters = detectCrossLineBunches(trains, { stoppedRns });
  if (clusters.length === 0) {
    console.log('No cross-line train bunching detected');
    return;
  }
  console.log(`Found ${clusters.length} candidate cross-line cluster(s)`);

  let chosen = null;
  let placeKey = null;
  let cooldownOverridden = false;
  for (const cluster of clusters) {
    const pk = placeKeyFor(cluster.centroid);
    console.log(
      `  ${cluster.trains.length} trains / ${cluster.lineCount} lines (${cluster.lines.join(', ')}) @ ${pk}`,
    );
    if (!argv['dry-run']) {
      const cdKey = `xbunch:train:${pk}`;
      const cd = isOnCooldown(cdKey);
      const cooldownAllows = history.bunchingCooldownAllows({
        kind: 'train-multi',
        route: pk,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
      });
      if (cd && !cooldownAllows) {
        console.log('  skip: on cooldown');
        recordSkip(cluster, pk, 'cooldown');
        continue;
      }
      if (cd && cooldownAllows) cooldownOverridden = true;
      const capAllows = history.bunchingCapAllows({
        kind: 'train-multi',
        route: pk,
        candidate: { vehicleCount: cluster.trains.length, severityFt: cluster.spanFt },
        cap: CROSS_TRAIN_DAILY_CAP,
      });
      if (!capAllows) {
        console.log('  skip: at daily cap and not more severe');
        recordSkip(cluster, pk, 'cap');
        continue;
      }
    }
    chosen = cluster;
    placeKey = pk;
    break;
  }

  if (!chosen) {
    console.log('All candidates filtered (cooldown/cap), nothing to post');
    return;
  }

  const placeName = nearestStation(chosen.centroid);
  const callouts = history.bunchingCallouts({
    kind: 'train-multi',
    route: placeKey,
    routeLabel: placeName ? `cluster at ${placeName}` : 'multi-line cluster',
    calloutNoun: '',
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
  });

  const { byLine, labels } = groupByLine(chosen);
  const ctx = { placeName };
  const text = buildPostText(chosen, ctx, callouts);
  const alt = buildAltText(chosen, ctx);

  const { points, legend } = pointsFromCluster(chosen.trains, {
    idOf: (t) => t.rn,
    groupKeyOf: (t) => t.line,
    labels,
    groupOrder: byLine.map((g) => g.line),
    legendLabelOf: (l) => lineLabel(l),
  });
  const mapTitle = `${chosen.trains.length} trains · ${chosen.lineCount} lines`;
  const groupLines = byLine.map((g) => g.line);
  const routePaths = buildRoutePaths(groupLines);
  // Official CTA line colors (Red, Brown, Orange…) so each disc + line reads as
  // its real line rather than an arbitrary palette swatch.
  const colors = groupLines.map((line) => LINE_COLORS[line] || null);

  let image;
  try {
    image = await renderCrossBunchingMap({
      points,
      legend,
      title: mapTitle,
      markerKind: 'train',
      routePaths,
      colors,
    });
  } catch (e) {
    console.warn(`Map render failed (${e.message}); will post text-only`);
    image = null;
  }

  if (argv['dry-run']) {
    const out = image
      ? writeDryRunAsset(
          image,
          `cross-train-${placeKey.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}.jpg`,
        )
      : '(render failed - text only)';
    console.log(`\n--- DRY RUN ---\n${text}\n\nAlt: ${alt}\nImage: ${out}`);
    return;
  }

  const baseEvent = {
    kind: 'train-multi',
    route: placeKey,
    direction: chosen.lines.join(','),
    vehicleCount: chosen.trains.length,
    severityFt: chosen.spanFt,
    nearStop: placeName,
    memberIds: chosen.trains.map((t) => t.rn),
  };
  const posted = await commitAndPost({
    cooldownKeys: [`xbunch:train:${placeKey}`],
    forceClearCooldown: cooldownOverridden,
    recordSkip: () => history.recordBunching({ ...baseEvent, posted: false }),
    agentLogin: loginTrain,
    image,
    text,
    alt,
    recordPosted: (primary) => {
      history.recordBunching({ ...baseEvent, posted: true, postUri: primary.uri });
      history.recordMetaSignal({
        kind: 'train',
        line: placeKey,
        direction: chosen.lines.join(','),
        source: 'cross-bunching',
        severity: Math.min(1, chosen.trains.length / 5),
        detail: { trains: chosen.trains.length, lines: chosen.lines, nearStop: placeName },
        posted: true,
      });
    },
    postWithImage,
    postText,
  });

  // Timelapse reply is non-fatal — the primary post already went out. Built from
  // observation history (observe-trains records positions every ~30s).
  if (posted?.primary?.uri) {
    try {
      const groupOrder = byLine.map((g) => g.line);
      const groupIndexByLine = new Map(groupOrder.map((l, i) => [l, i]));
      const memberSet = new Set(chosen.trains.map((t) => String(t.rn)));
      const videoRows = getRecentTrainPositions(Date.now() - VIDEO_WINDOW_MS)
        .filter(
          (o) => memberSet.has(String(o.rn)) && Number.isFinite(o.lat) && Number.isFinite(o.lon),
        )
        .map((o) => ({
          id: String(o.rn),
          lat: o.lat,
          lon: o.lon,
          ts: o.ts,
          label: String(labels.get(o.rn) ?? '?'),
          groupIndex: groupIndexByLine.get(o.line) ?? 0,
        }));
      const video = await captureCrossBunchingVideo(videoRows, {
        legend,
        title: mapTitle,
        markerKind: 'train',
        routePaths,
        colors,
      });
      if (!video) {
        console.log('Timelapse history produced <2 frames, skipping reply');
        return;
      }
      const replyRef = {
        root: { uri: posted.primary.uri, cid: posted.primary.cid },
        parent: { uri: posted.primary.uri, cid: posted.primary.cid },
      };
      const reply = await postWithVideo(
        posted.agent,
        buildVideoPostText(video, chosen),
        video.buffer,
        buildVideoAltText(chosen, ctx),
        replyRef,
      );
      console.log(`Timelapse reply: ${reply.url}`);
    } catch (e) {
      console.warn(`Timelapse reply failed: ${e.message}`);
    }
  }
}

runBin(main);
