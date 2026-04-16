// Fetch CTA L line polylines from the authoritative CTA GTFS feed.
// Run manually when line geometries change (new stations, reroutes).
//
// Why GTFS instead of OSM: GTFS ships one ordered polyline per direction
// (shape_id), so we don't need to chain OSM ways, filter out closed-loop
// junctions, or dedupe parallel northbound/southbound tracks.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const Fs = require('fs-extra');
const Path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const readline = require('readline');

const execAsync = promisify(exec);

// Stream-read a file from the zip line by line. Used for stop_times.txt which
// is too large to buffer in memory.
async function streamFromZip(filename, onLine) {
  return new Promise((resolve, reject) => {
    const proc = spawn('unzip', ['-p', ZIP_PATH, filename]);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', onLine);
    rl.on('close', resolve);
    proc.on('error', reject);
    proc.stderr.on('data', (d) => process.stderr.write(d));
  });
}
const GTFS_URL = 'https://www.transitchicago.com/downloads/sch_data/google_transit.zip';
const ZIP_PATH = '/tmp/cta-gtfs.zip';

// Map CTA's GTFS route_id values to our internal line keys. Discovered by
// inspecting routes.txt — CTA uses 1-char codes for most lines.
const ROUTE_ID_MAP = {
  Red:  'red',
  Blue: 'blue',
  Brn:  'brn',
  G:    'g',
  Org:  'org',
  P:    'p',
  Pink: 'pink',
  Y:    'y',
};

async function downloadGtfs() {
  if (Fs.existsSync(ZIP_PATH)) {
    const age = Date.now() - Fs.statSync(ZIP_PATH).mtimeMs;
    if (age < 24 * 60 * 60 * 1000) {
      console.log(`Using cached GTFS zip (< 1 day old)`);
      return;
    }
  }
  console.log(`Downloading GTFS from ${GTFS_URL}...`);
  const resp = await axios.get(GTFS_URL, { responseType: 'arraybuffer', timeout: 120000 });
  Fs.writeFileSync(ZIP_PATH, resp.data);
  console.log(`  ${(resp.data.length / 1024 / 1024).toFixed(1)} MB`);
}

async function readFromZip(filename) {
  const { stdout } = await execAsync(`unzip -p "${ZIP_PATH}" "${filename}"`, { maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

// Minimal CSV parser. GTFS files are standard RFC 4180 — fields with commas
// or newlines are quoted. We don't have any quoted newlines to worry about in
// routes/trips/shapes, so a straightforward split per line works.
function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',').map((s) => s.replace(/"/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map((s) => s.replace(/"/g, '').trim());
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = parts[j];
    rows.push(row);
  }
  return rows;
}

// Perpendicular distance from point p to the line segment a–b, in degrees.
// Good enough for comparing relative distances within a small geographic area.
function perpendicularDist(p, a, b) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) {
    return Math.sqrt((p.lon - a.lon) ** 2 + (p.lat - a.lat) ** 2);
  }
  const t = Math.max(0, Math.min(1, ((p.lon - a.lon) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy)));
  const projLon = a.lon + t * dx;
  const projLat = a.lat + t * dy;
  return Math.sqrt((p.lon - projLon) ** 2 + (p.lat - projLat) ** 2);
}

// Ramer-Douglas-Peucker simplification. Preserves points where the shape
// changes direction (e.g. Loop corners) while reducing straight segments.
function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// Simplify a polyline to approximately targetCount points using RDP.
// Binary-searches for the right epsilon to hit near the target count.
function decimateTo(points, targetCount) {
  if (points.length <= targetCount) return points;
  let lo = 0;
  let hi = 0.01; // degrees — wide enough for any CTA line
  let best = points;
  for (let iter = 0; iter < 30; iter++) {
    const mid = (lo + hi) / 2;
    const result = rdpSimplify(points, mid);
    best = result;
    if (result.length > targetCount) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}

async function main() {
  await downloadGtfs();

  console.log('Reading routes.txt...');
  const routes = parseCsv(await readFromZip('routes.txt'));
  const lRoutes = routes.filter((r) => ROUTE_ID_MAP[r.route_id]);
  console.log(`  ${lRoutes.length} L routes:`, lRoutes.map((r) => r.route_id).join(', '));

  console.log('Reading trips.txt...');
  const trips = parseCsv(await readFromZip('trips.txt'));
  // Collect unique shape_ids per route, preserving direction distinction.
  const shapesByLine = new Map();
  for (const trip of trips) {
    const lineKey = ROUTE_ID_MAP[trip.route_id];
    if (!lineKey) continue;
    if (!shapesByLine.has(lineKey)) shapesByLine.set(lineKey, new Set());
    shapesByLine.get(lineKey).add(trip.shape_id);
  }
  for (const [line, shapes] of shapesByLine) {
    console.log(`  ${line}: ${shapes.size} distinct shape_ids`);
  }

  console.log('Reading shapes.txt (this is the big one)...');
  const shapesText = await readFromZip('shapes.txt');
  const shapes = parseCsv(shapesText);
  console.log(`  ${shapes.length} shape points total`);

  // Group shape points by shape_id, ordered by sequence.
  const pointsByShape = new Map();
  for (const row of shapes) {
    const id = row.shape_id;
    if (!pointsByShape.has(id)) pointsByShape.set(id, []);
    pointsByShape.get(id).push({
      seq: parseInt(row.shape_pt_sequence, 10),
      lat: parseFloat(row.shape_pt_lat),
      lon: parseFloat(row.shape_pt_lon),
    });
  }
  for (const pts of pointsByShape.values()) pts.sort((a, b) => a.seq - b.seq);

  // Keep only direction_id='0' shapes. GTFS ships separate geometries for
  // direction 0 (outbound) and direction 1 (inbound); they trace each physical
  // track with slight offsets, so rendering both creates parallel-line artifacts
  // at spots where the offsets diverge (e.g. Red Line at Ranch Triangle).
  //
  // For single-trunk lines this leaves us with one polyline.
  // For Green (branched), each branch has its own direction-0 shape, so we
  // still get both Ashland/63rd and Cottage Grove branches — but only once.
  const directionByShape = new Map();
  for (const trip of trips) {
    if (!directionByShape.has(trip.shape_id)) {
      directionByShape.set(trip.shape_id, trip.direction_id);
    }
  }

  const out = {};
  for (const [line, shapeIds] of shapesByLine) {
    // Pick whichever direction this line uses. Most lines have both directions,
    // but loop-style lines (Orange, Pink, Purple, Yellow) are modeled only as
    // direction 1 since their trips start and end at the same terminal.
    const dir0 = [...shapeIds].filter((id) => directionByShape.get(id) === '0');
    const dir1 = [...shapeIds].filter((id) => directionByShape.get(id) === '1');
    const chosenShapes = dir0.length > 0 ? dir0 : dir1;

    // Sort by length desc. Keep shapes whose length is at least 80% of the
    // longest — that's the heuristic that separates real branches (similar
    // length to trunk; e.g. Green has two 85%-length shapes for its branches)
    // from shortturn variants (typically 40-75% of trunk length, e.g. Blue's
    // Jefferson Park → UIC-Halsted at ~47%).
    const sortedShapes = chosenShapes
      .map((id) => ({ id, points: pointsByShape.get(id) || [] }))
      .filter((s) => s.points.length >= 2)
      .sort((a, b) => b.points.length - a.points.length);
    const longestLength = sortedShapes[0]?.points.length || 0;
    const kept = sortedShapes.filter((s) => s.points.length >= longestLength * 0.8);

    const polylines = kept.map((shape) => {
      const decimated = decimateTo(shape.points, 80);
      return decimated.map((p) => [
        Math.round(p.lat * 1e5) / 1e5,
        Math.round(p.lon * 1e5) / 1e5,
      ]);
    });
    out[line] = polylines;
    const totalPts = polylines.reduce((a, s) => a + s.length, 0);
    const chosenDir = dir0.length > 0 ? '0' : '1';
    console.log(`  ${line}: ${chosenShapes.length} dir-${chosenDir} shapes → ${polylines.length} kept (${totalPts} pts)`);
  }

  const outPath = Path.join(__dirname, '..', 'src', 'data', 'trainLines.json');
  Fs.ensureDirSync(Path.dirname(outPath));
  Fs.writeJsonSync(outPath, out);
  console.log(`Wrote ${outPath} (${(Fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  // Now extract CTA L stations. GTFS stops.txt mixes rail and bus stops; we
  // trace rail-route trips through stop_times to find only the L stops, then
  // resolve each to its parent station (stop_id where location_type=1).
  const lTripIds = new Set(trips.filter((t) => ROUTE_ID_MAP[t.route_id]).map((t) => t.trip_id));

  // Track which line serves each trip so we can annotate stations with their lines.
  const lineByTrip = new Map();
  for (const t of trips) {
    const line = ROUTE_ID_MAP[t.route_id];
    if (line) lineByTrip.set(t.trip_id, line);
  }

  console.log('Streaming stop_times.txt to find rail stops...');
  const linesPerStop = new Map(); // stop_id -> Set of line keys
  let header = null;
  let tripIdIdx = -1;
  let stopIdIdx = -1;
  await streamFromZip('stop_times.txt', (line) => {
    if (!header) {
      header = line.split(',').map((s) => s.replace(/"/g, '').trim());
      tripIdIdx = header.indexOf('trip_id');
      stopIdIdx = header.indexOf('stop_id');
      return;
    }
    const parts = line.split(',');
    const tripId = parts[tripIdIdx];
    const lineKey = lineByTrip.get(tripId);
    if (!lineKey) return;
    const stopId = parts[stopIdIdx];
    if (!linesPerStop.has(stopId)) linesPerStop.set(stopId, new Set());
    linesPerStop.get(stopId).add(lineKey);
  });
  const railStopIds = new Set(linesPerStop.keys());
  console.log(`  ${railStopIds.size} unique rail stop_ids`);

  console.log('Reading stops.txt...');
  const stops = parseCsv(await readFromZip('stops.txt'));
  const byStopId = new Map(stops.map((s) => [s.stop_id, s]));

  // Platforms have parent_station set; stations have location_type='1'. Collect
  // each parent and merge the line sets of its child platforms.
  const stationLineSets = new Map(); // station_id -> Set of line keys
  for (const sid of railStopIds) {
    const stop = byStopId.get(sid);
    if (!stop) continue;
    const parentId = stop.parent_station || (stop.location_type === '1' ? sid : null);
    if (!parentId) continue;
    if (!stationLineSets.has(parentId)) stationLineSets.set(parentId, new Set());
    for (const l of linesPerStop.get(sid) || []) stationLineSets.get(parentId).add(l);
  }

  const stationsOut = [];
  const seenNames = new Set();
  for (const [sid, lineSet] of stationLineSets) {
    const s = byStopId.get(sid);
    if (!s || !s.stop_name || seenNames.has(s.stop_name)) continue;
    seenNames.add(s.stop_name);
    stationsOut.push({
      name: s.stop_name,
      lat: Math.round(parseFloat(s.stop_lat) * 1e5) / 1e5,
      lon: Math.round(parseFloat(s.stop_lon) * 1e5) / 1e5,
      lines: [...lineSet].sort(),
    });
  }

  const stationPath = Path.join(__dirname, '..', 'src', 'data', 'trainStations.json');
  Fs.writeJsonSync(stationPath, stationsOut);
  console.log(`Wrote ${stationPath} (${stationsOut.length} stations)`);
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
