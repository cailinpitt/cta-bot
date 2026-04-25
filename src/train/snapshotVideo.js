const Fs = require('fs-extra');
const Os = require('node:os');
const Path = require('node:path');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const { getAllTrainPositions } = require('./api');
const {
  computeSnapshotView,
  computeLoopInsetView,
  fetchSnapshotBaseLayer,
  renderSnapshotFrame,
} = require('../map');

const execP = promisify(exec);

const DEFAULT_TICK_MS = 15_000;
const DEFAULT_TICKS = 60; // 15 min of real time
const DEFAULT_INTERPOLATE = 4;
const DEFAULT_FRAMERATE = 16;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function captureSnapshotVideo(initialTrains, lineColors, trainLines, opts = {}) {
  const tickMs = opts.tickMs || DEFAULT_TICK_MS;
  const ticks = opts.ticks || DEFAULT_TICKS;
  const framerate = opts.framerate || DEFAULT_FRAMERATE;
  const interpolate = Math.max(1, opts.interpolate || DEFAULT_INTERPOLATE);

  const snapshots = [{ ts: Date.now(), trains: initialTrains }];

  for (let i = 1; i < ticks; i++) {
    await sleep(tickMs);
    try {
      const trains = await getAllTrainPositions();
      snapshots.push({ ts: Date.now(), trains });
    } catch (e) {
      console.warn(`snapshot video tick ${i}: fetch failed — ${e.message}`);
    }
  }

  if (snapshots.length < 2) return null;

  const view = computeSnapshotView(trainLines);
  const insetView = computeLoopInsetView();
  const layers = await fetchSnapshotBaseLayer(view, insetView, lineColors, trainLines);

  // Linear lat/lon interpolation between adjacent snapshots, per-rn. At system
  // zoom the cartesian shortcut across curves is invisible — pin radius (~8px)
  // is wider than the deviation a 15s, half-mile leg would produce.
  const trainFrames = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const a = new Map(snapshots[i].trains.map((t) => [t.rn, t]));
    const b = new Map(snapshots[i + 1].trains.map((t) => [t.rn, t]));
    const allRns = new Set([...a.keys(), ...b.keys()]);
    for (let k = 0; k < interpolate; k++) {
      const t = k / interpolate;
      const frame = [];
      for (const rn of allRns) {
        const ta = a.get(rn);
        const tb = b.get(rn);
        // Trains entering/leaving service mid-window: hold their position from
        // whichever side has them. Cheaper than fading and visually fine at
        // this scale.
        const from = ta || tb;
        const to = tb || ta;
        const lat = from.lat + (to.lat - from.lat) * t;
        const lon = from.lon + (to.lon - from.lon) * t;
        frame.push({ rn, line: from.line, lat, lon });
      }
      trainFrames.push(frame);
    }
  }
  trainFrames.push(snapshots[snapshots.length - 1].trains);

  const tmpDir = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'cta-train-snapshot-video-'));
  try {
    for (let i = 0; i < trainFrames.length; i++) {
      const buf = await renderSnapshotFrame(layers, lineColors, trainFrames[i]);
      const framePath = Path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.jpg`);
      await Fs.writeFile(framePath, buf);
    }
    // Hold last frame for one second so the final state reads before loop.
    const holdFrames = framerate;
    const lastIdx = trainFrames.length - 1;
    const lastPath = Path.join(tmpDir, `frame_${String(lastIdx).padStart(4, '0')}.jpg`);
    for (let k = 1; k <= holdFrames; k++) {
      const dst = Path.join(tmpDir, `frame_${String(lastIdx + k).padStart(4, '0')}.jpg`);
      await Fs.copyFile(lastPath, dst);
    }

    const outPath = Path.join(tmpDir, 'out.mp4');
    const cmd = [
      'ffmpeg -y -hide_banner -loglevel error',
      `-framerate ${framerate}`,
      `-i "${Path.join(tmpDir, 'frame_%04d.jpg')}"`,
      '-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2"',
      '-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart',
      `"${outPath}"`,
    ].join(' ');
    await execP(cmd, { timeout: 120_000 });
    const buffer = await Fs.readFile(outPath);

    const startTs = snapshots[0].ts;
    const endTs = snapshots[snapshots.length - 1].ts;
    const elapsedSec = Math.round((endTs - startTs) / 1000);
    const finalTrains = snapshots[snapshots.length - 1].trains;
    return { buffer, ticksCaptured: snapshots.length, elapsedSec, finalTrains, startTs, endTs };
  } finally {
    await Fs.remove(tmpDir).catch(() => {});
  }
}

module.exports = { captureSnapshotVideo };
