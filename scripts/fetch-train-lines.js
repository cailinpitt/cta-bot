// One-shot script to pull CTA 'L' line polylines from OpenStreetMap via the
// Overpass API and save a compact per-line JSON. Run manually when geometries
// change (very rare — new stations, reroutes).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const Fs = require('fs-extra');
const Path = require('path');

const LINE_QUERY = `
[out:json][timeout:120];
area[name='Chicago']->.a;
(
  relation['route'='subway']['network'='CTA'](area.a);
);
out geom;`;

// Stations: CTA L stations in OSM are nodes tagged station=subway or railway=station
// with operator=Chicago Transit Authority. We query all CTA-operated station nodes
// in the Chicago area and keep the distinct ones.
const STATION_QUERY = `
[out:json][timeout:60];
area[name='Chicago']->.a;
(
  node['railway'='station']['operator'='Chicago Transit Authority'](area.a);
  node['station'='subway']['operator'='Chicago Transit Authority'](area.a);
);
out;`;

const REF_KEY_MAP = {
  Red: 'red',
  Blue: 'blue',
  Brown: 'brn',
  Green: 'g',
  Orange: 'org',
  Purple: 'p',
  Pink: 'pink',
  Yellow: 'y',
};

// Decimate to approximately targetCount points by keeping every Nth point.
// Mapbox static URLs have a ~8k char limit and we need room for 8 paths + many pins,
// so each line's polyline must be short. Subtle visual doesn't need high fidelity.
function decimateTo(points, targetCount) {
  if (points.length <= targetCount) return points;
  const step = Math.ceil(points.length / targetCount);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// Dedupe consecutive identical points that come from abutting ways within a relation.
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  return out;
}

async function main() {
  console.log('Querying Overpass API...');
  async function overpass(query) {
    const endpoints = [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ];
    for (const endpoint of endpoints) {
      try {
        console.log(`  ${endpoint}...`);
        const resp = await axios.post(
          endpoint,
          'data=' + encodeURIComponent(query),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 120000 }
        );
        if (typeof resp.data === 'string' && resp.data.includes('rate_limited')) {
          console.log('    rate-limited, trying next');
          continue;
        }
        return resp.data;
      } catch (e) {
        console.log(`    failed: ${e.message}`);
      }
    }
    throw new Error('All Overpass mirrors failed');
  }

  console.log('Fetching line geometries...');
  const data = await overpass(LINE_QUERY);

  const relations = data.elements || [];
  console.log(`Got ${relations.length} relations`);

  function samePoint(a, b) {
    return a && b && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  }

  // Chain a relation's member ways into continuous segments. Ways that don't
  // connect to the current chain start a new segment.
  function chainRelation(rel) {
    const segments = [];
    let currentSegment = null;
    for (const member of rel.members || []) {
      if (member.type !== 'way' || !member.geometry) continue;
      const points = member.geometry.map((g) => [g.lat, g.lon]);
      if (points.length < 2) continue;

      if (!currentSegment) {
        currentSegment = [...points];
        continue;
      }

      const tail = currentSegment[currentSegment.length - 1];
      // Only chain when the next way starts where the previous way ended. Reverse-matching
      // (way's end touches previous way's end) accidentally stitches parallel northbound
      // and southbound tracks into a narrow loop, producing visible cycles in the render.
      if (samePoint(tail, points[0])) {
        currentSegment.push(...points.slice(1));
      } else {
        segments.push(currentSegment);
        currentSegment = [...points];
      }
    }
    if (currentSegment) segments.push(currentSegment);
    return segments;
  }

  // Combine segments across all of a line's relations. Each line has 2-4 directional
  // variants; relations for the reverse direction are usually the same track traversed
  // backwards. Branched lines (Green especially) need multiple relations to cover
  // all branches — one relation typically covers trunk + one branch.
  const segmentsByLine = new Map();
  for (const rel of relations) {
    const key = REF_KEY_MAP[rel.tags?.ref];
    if (!key) continue;
    if (!segmentsByLine.has(key)) segmentsByLine.set(key, []);
    segmentsByLine.get(key).push(...chainRelation(rel));
  }

  // Haversine distance in feet between two [lat, lon] points.
  function distFt(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * 20902231 * Math.asin(Math.sqrt(h));
  }

  // Is segA mostly a subset of segB? i.e. does the bulk of segA lie geographically
  // along segB? This catches the OSM parallel-tracks problem: northbound and
  // southbound tracks are mapped as separate ways ~5m apart, but after chaining
  // and decimation their points don't exactly match, so a sort-and-sign dedup
  // misses them. Here we ask: what fraction of segA's points have a segB point
  // within NEAR_FT of them? If high, the two segments trace the same physical track.
  const NEAR_FT = 400;
  function coverageRatio(segA, segB) {
    let close = 0;
    for (const a of segA) {
      for (const b of segB) {
        if (distFt(a, b) < NEAR_FT) {
          close++;
          break;
        }
      }
    }
    return close / segA.length;
  }

  // Greedy dedup: walk segments longest-first, keep each unless it's mostly
  // subsumed by an already-kept segment.
  function dedupeSegments(segments) {
    const sorted = [...segments].sort((a, b) => b.length - a.length);
    const kept = [];
    for (const seg of sorted) {
      const subsumed = kept.some((k) => coverageRatio(seg, k) > 0.8);
      if (!subsumed) kept.push(seg);
    }
    return kept;
  }

  // Keep only the longest few segments per line. OSM splits tracks at every station
  // and crossover, producing dozens of tiny ways — the top segments by length cover
  // the trunk and branches; the rest are short crossovers we can skip.
  const MAX_SEGMENTS_PER_LINE = 4;

  // Drop closed-loop segments (start ≈ end). These are OSM-mapped service wyes,
  // crossovers, or junction tracks — not revenue routes, and they render as weird
  // little circles on the map.
  function isClosedLoop(seg) {
    const start = seg[0];
    const end = seg[seg.length - 1];
    const latDiff = Math.abs(start[0] - end[0]);
    const lonDiff = Math.abs(start[1] - end[1]);
    return latDiff < 0.0002 && lonDiff < 0.0002; // ~20m
  }

  const out = {};
  for (const [line, rawSegments] of segmentsByLine) {
    const openSegments = rawSegments.filter((s) => !isClosedLoop(s));
    const unique = dedupeSegments(openSegments);
    const sortedByLength = [...unique].sort((a, b) => b.length - a.length);
    const kept = sortedByLength.slice(0, MAX_SEGMENTS_PER_LINE);
    const decimated = kept
      .map((s) => dedupe(s))
      .map((s) => decimateTo(s, 22))
      .map((s) => s.map(([lat, lon]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]))
      .filter((s) => s.length >= 2);
    out[line] = decimated;
    const finalPts = decimated.reduce((a, s) => a + s.length, 0);
    const loopsDropped = rawSegments.length - openSegments.length;
    console.log(`  ${line}: ${rawSegments.length} raw (${loopsDropped} loops dropped) → ${unique.length} unique → kept top ${decimated.length} (${finalPts} pts)`);
  }

  const outPath = Path.join(__dirname, '..', 'src', 'data', 'trainLines.json');
  Fs.ensureDirSync(Path.dirname(outPath));
  Fs.writeJsonSync(outPath, out);
  console.log(`Wrote ${outPath}`);

  console.log('Fetching stations...');
  const stationData = await overpass(STATION_QUERY);
  const stations = [];
  const seenNames = new Set();
  for (const node of stationData.elements || []) {
    if (node.type !== 'node') continue;
    const name = node.tags?.name;
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    stations.push({
      name,
      lat: Math.round(node.lat * 1e5) / 1e5,
      lon: Math.round(node.lon * 1e5) / 1e5,
    });
  }
  const stationPath = Path.join(__dirname, '..', 'src', 'data', 'trainStations.json');
  Fs.writeJsonSync(stationPath, stations);
  console.log(`Wrote ${stationPath} (${stations.length} stations)`);
}

main().catch((e) => {
  console.error(e.response?.data || e.stack || e);
  process.exit(1);
});
