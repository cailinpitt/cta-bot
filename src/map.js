const axios = require('axios');
const sharp = require('sharp');
const { encode } = require('./polyline');
const { cumulativeDistances, haversineFt, bearing } = require('./geo');
const { buildLinePolyline, snapToLine } = require('./trainSpeedmap');
const { colorForBusSpeed, colorForTrainSpeed } = require('./speedmap');
const { fitZoom, project } = require('./projection');

const STYLE = 'mapbox/dark-v11';
const WIDTH = 1200;
const HEIGHT = 1200;

// Two-tone route line: dark halo + bright core makes the route pop against the basemap.
const ROUTE_HALO_COLOR = '000';
const ROUTE_HALO_STROKE = 9;
const ROUTE_CORE_COLOR = '00d8ff';
const ROUTE_CORE_STROKE = 4;

const BUS_COLOR = 'ff2a6d';         // hot pink/red reads well on dark
const CONTEXT_PAD_FT = 1500;        // feet of route context on each side of the bunch

/**
 * Slice pattern points to a window around the bunched buses' geographic position.
 *
 * We walk the polyline in seq order building a cumulative haversine distance,
 * then find the cumulative-distance positions nearest to each bus (matching by
 * straight-line proximity) and slice with CONTEXT_PAD_FT buffer around that range.
 *
 * We can't trust point.pdist for this — the CTA API only populates pdist on stops,
 * leaving waypoints at 0, which would make a naive pdist filter pull in every
 * waypoint scattered across the whole route.
 */
function slicePatternAroundBunch(pattern, bunch) {
  const cum = cumulativeDistances(pattern.points);

  // For each vehicle, find the pattern point geographically closest to it,
  // and take that point's cumulative distance as the vehicle's position along
  // the line. Then slice the polyline to [min - pad, max + pad].
  const vehiclePositions = bunch.vehicles.map((v) => {
    let bestIdx = 0;
    let bestDist = haversineFt(v, pattern.points[0]);
    for (let i = 1; i < pattern.points.length; i++) {
      const d = haversineFt(v, pattern.points[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return cum[bestIdx];
  });

  const minCum = Math.min(...vehiclePositions) - CONTEXT_PAD_FT;
  const maxCum = Math.max(...vehiclePositions) + CONTEXT_PAD_FT;
  return pattern.points.filter((_, i) => cum[i] >= minCum && cum[i] <= maxCum);
}

async function renderBunchingMap(bunch, pattern) {
  const slice = slicePatternAroundBunch(pattern, bunch);
  const polyline = encode(slice.map((p) => [p.lat, p.lon]));

  const overlays = [];
  // Draw halo first, then core, so core renders on top. Pins render on top of both.
  const encoded = encodeURIComponent(polyline);
  overlays.push(`path-${ROUTE_HALO_STROKE}+${ROUTE_HALO_COLOR}(${encoded})`);
  overlays.push(`path-${ROUTE_CORE_STROKE}+${ROUTE_CORE_COLOR}(${encoded})`);
  // Use the Maki "bus" icon for a clear transit visual on each pin.
  for (const v of bunch.vehicles) {
    overlays.push(`pin-m-bus+${BUS_COLOR}(${v.lon.toFixed(6)},${v.lat.toFixed(6)})`);
  }

  // Compute explicit center/zoom so we can project bus positions for SVG arrows.
  const allLats = [...slice.map((p) => p.lat), ...bunch.vehicles.map((v) => v.lat)];
  const allLons = [...slice.map((p) => p.lon), ...bunch.vehicles.map((v) => v.lon)];
  const bbox = {
    minLat: Math.min(...allLats),
    maxLat: Math.max(...allLats),
    minLon: Math.min(...allLons),
    maxLon: Math.max(...allLons),
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  const rawZoom = fitZoom(bbox, WIDTH, HEIGHT, 60);
  const zoom = Math.max(10, Math.min(17, Math.floor(rawZoom)));

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;

  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });

  // Compute track bearing at each bus using the nearest route segment.
  const slicePoints = slice.map((p) => ({ lat: p.lat, lon: p.lon }));
  function busTrackBearing(v) {
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < slicePoints.length - 1; i++) {
      const a = slicePoints[i];
      const b = slicePoints[i + 1];
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) t = Math.max(0, Math.min(1, ((v.lon - a.lon) * dx + (v.lat - a.lat) * dy) / lenSq));
      const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
      const d = haversineFt(v, proj);
      if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
    }
    const fwd = bearing(bestA, bestB);
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((v.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((v.heading - rev + 540) % 360) - 180);
    return diffFwd <= diffRev ? fwd : rev;
  }

  // Single direction arrow for the route, placed above the leading bus.
  const ARROWS = ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'];
  const BUS_PIN_BODY_OFFSET_Y = -20; // pin-m is smaller than pin-l
  // Pick the leading bus (highest pdist) for arrow placement.
  const leadBus = bunch.vehicles.reduce((a, b) => (b.pdist > a.pdist ? b : a), bunch.vehicles[0]);
  const bearingDeg = busTrackBearing(leadBus);
  const idx = Math.round(bearingDeg / 45) % 8;
  const arrow = ARROWS[idx];
  const { x: ax, y: ay } = project(leadBus.lat, leadBus.lon, centerLat, centerLon, zoom, WIDTH, HEIGHT);
  const arrowElements = [
    `<text x="${ax}" y="${ay + BUS_PIN_BODY_OFFSET_Y - 30}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="bold" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${arrow}</text>`,
  ];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${arrowElements.join('\n')}</svg>`;

  // Bluesky image limit is 1MB; composite arrows then convert to JPEG.
  return sharp(data)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

const SPEEDMAP_SEGMENT_STROKE = 8;
const SPEEDMAP_HALO_STROKE = 12;

/**
 * Slice pattern points into N ordered groups by cumulative distance along the line.
 * Each slice gets an extra point copied from the next slice's start so adjacent
 * colored segments visually connect without gaps.
 */
function slicePatternIntoSegments(pattern, numBins) {
  const cum = cumulativeDistances(pattern.points);
  const total = cum[cum.length - 1];
  const segLen = total / numBins;

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < pattern.points.length; i++) {
    const idx = Math.min(numBins - 1, Math.floor(cum[i] / segLen));
    slices[idx].push(pattern.points[i]);
  }
  // Bridge each slice to the next so colored segments don't have visible gaps.
  for (let i = 0; i < slices.length - 1; i++) {
    if (slices[i + 1].length > 0) slices[i].push(slices[i + 1][0]);
  }
  return slices;
}

async function renderSpeedmap(pattern, binSpeeds) {
  const slices = slicePatternIntoSegments(pattern, binSpeeds.length);

  // Full-route dark halo rendered first, then each colored segment layered on top.
  const fullEncoded = encodeURIComponent(encode(pattern.points.map((p) => [p.lat, p.lon])));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i].map((p) => [p.lat, p.lon])));
    const color = colorForBusSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=30`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const SNAPSHOT_WIDTH = 1200;
const SNAPSHOT_HEIGHT = 1200;

async function renderSnapshot(trains, lineColors, trainLines = null, stations = null) {
  const overlays = [];

  // Subtle line polylines drawn first so they appear under everything else.
  if (trainLines) {
    for (const [line, segments] of Object.entries(trainLines)) {
      const color = lineColors[line] || 'ffffff';
      for (const points of segments) {
        if (!points || points.length < 2) continue;
        const encoded = encodeURIComponent(encode(points));
        overlays.push(`path-2+${color}-0.55(${encoded})`);
      }
    }
  }

  // Small white station markers between lines and trains for subtle network context.
  if (stations) {
    for (const s of stations) {
      overlays.push(`pin-s+ffffff(${s.lon.toFixed(4)},${s.lat.toFixed(4)})`);
    }
  }

  // Colored pin per train, on top of stations so they're the focal point.
  for (const t of trains) {
    const color = lineColors[t.line] || 'ffffff';
    overlays.push(`pin-s+${color}(${t.lon.toFixed(4)},${t.lat.toFixed(4)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

const TRAIN_BUNCH_CONTEXT_FT = 8000; // feet of line shown around the bunch
const TRAIN_BUNCH_NEAREST_STATIONS = 2; // how many stations to label
const TRAIN_BUNCH_BBOX_PADDING_DEG = 0.003; // ~300m — zoom out a little past the trains

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pin anchor offset: Mapbox pin-l tip is at the coordinate; the pin body
// (colored circle) sits ~28px above the tip in the rendered 1200px image.
const PIN_BODY_OFFSET_Y = -28;

function buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, widthPx, heightPx) {
  const fontSize = 18;
  const labelHeight = fontSize + 8;
  const gap = 4; // minimum vertical gap between labels

  // Compute initial label positions, then nudge overlapping ones apart.
  const labels = stationsWithPixels.map(({ station, x, y }) => {
    const label = xmlEscape(station.name);
    const approxWidth = label.length * 10 + 16;
    return { label, x, rectY: y + 18, approxWidth };
  });

  labels.sort((a, b) => a.rectY - b.rectY);
  for (let i = 1; i < labels.length; i++) {
    const prev = labels[i - 1];
    const minY = prev.rectY + labelHeight + gap;
    if (labels[i].rectY < minY) {
      labels[i].rectY = minY;
    }
  }

  // White ring halos around trains that are at a station.
  const halos = atStationPixels.map(({ x, y }) => {
    const cx = x;
    const cy = y + PIN_BODY_OFFSET_Y;
    return `<circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="#fff" stroke-width="3"/>`;
  });

  // Direction arrows above each train pin using Unicode arrows.
  const ARROWS = ['\u2191', '\u2197', '\u2192', '\u2198', '\u2193', '\u2199', '\u2190', '\u2196'];
  const arrows = trainPixels.map(({ x, y, bearingDeg }) => {
    const idx = Math.round(bearingDeg / 45) % 8;
    const arrow = ARROWS[idx];
    const cx = x;
    const cy = y + PIN_BODY_OFFSET_Y - 36;
    return `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="bold" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${arrow}</text>`;
  });

  const labelElements = labels.map(({ label, x, rectY, approxWidth }) => {
    const rectX = x - approxWidth / 2;
    const textX = x;
    const textY = rectY + fontSize + 2;
    return `
    <rect x="${rectX}" y="${rectY}" width="${approxWidth}" height="${labelHeight}" fill="#000" fill-opacity="0.8" rx="3"/>
    <text x="${textX}" y="${textY}" fill="#fff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="600">${label}</text>`;
  });

  const elements = [...halos, ...arrows, ...labelElements].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${elements}</svg>`;
}

async function renderTrainBunching(bunch, lineColors, trainLines, stations) {
  const color = lineColors[bunch.line] || 'ffffff';

  // Use along-track distance to pick stations that bracket the bunch —
  // one ahead of the leading train and one behind the trailing train.
  const { points: linePts, cumDist: lineCumDist } = buildLinePolyline(trainLines, bunch.line);
  const trainTrackDists = bunch.trains.map((t) => snapToLine(t.lat, t.lon, linePts, lineCumDist));
  const minTrainDist = Math.min(...trainTrackDists);
  const maxTrainDist = Math.max(...trainTrackDists);

  const onLineStations = (stations || []).filter((s) => s.lines?.includes(bunch.line));
  const stationsWithDist = onLineStations.map((s) => ({
    station: s,
    trackDist: snapToLine(s.lat, s.lon, linePts, lineCumDist),
  }));

  // Find the closest station behind the trailing train and ahead of the leading train.
  const behind = stationsWithDist
    .filter((s) => s.trackDist < minTrainDist)
    .sort((a, b) => b.trackDist - a.trackDist);
  const ahead = stationsWithDist
    .filter((s) => s.trackDist > maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);
  const between = stationsWithDist
    .filter((s) => s.trackDist >= minTrainDist && s.trackDist <= maxTrainDist)
    .sort((a, b) => a.trackDist - b.trackDist);

  const nearestStations = [];
  if (behind.length > 0) nearestStations.push(behind[0].station);
  if (between.length > 0) nearestStations.push(between[0].station);
  if (ahead.length > 0) nearestStations.push(ahead[0].station);
  // If we didn't get 3, fill from the closest by haversine as fallback.
  if (nearestStations.length < 2) {
    const bunchLat = bunch.trains.reduce((a, t) => a + t.lat, 0) / bunch.trains.length;
    const bunchLon = bunch.trains.reduce((a, t) => a + t.lon, 0) / bunch.trains.length;
    const already = new Set(nearestStations.map((s) => s.name));
    const fallback = onLineStations
      .filter((s) => !already.has(s.name))
      .sort((a, b) => haversineFt({ lat: bunchLat, lon: bunchLon }, a) - haversineFt({ lat: bunchLat, lon: bunchLon }, b));
    for (const s of fallback) {
      if (nearestStations.length >= 2) break;
      nearestStations.push(s);
    }
  }

  // Build bbox to include the bunched trains AND the chosen stations — that
  // way every pin and label we intend to render is inside the rendered viewport.
  const allLats = [...bunch.trains.map((t) => t.lat), ...nearestStations.map((s) => s.lat)];
  const allLons = [...bunch.trains.map((t) => t.lon), ...nearestStations.map((s) => s.lon)];
  const bbox = {
    minLat: Math.min(...allLats) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLat: Math.max(...allLats) + TRAIN_BUNCH_BBOX_PADDING_DEG,
    minLon: Math.min(...allLons) - TRAIN_BUNCH_BBOX_PADDING_DEG,
    maxLon: Math.max(...allLons) + TRAIN_BUNCH_BBOX_PADDING_DEG,
  };
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;
  // Use integer zoom. Mapbox may round or snap fractional zooms during render,
  // which would decouple our projection math from the actual image.
  const rawZoom = fitZoom(bbox, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT, 120);
  const zoom = Math.max(10, Math.min(17, Math.floor(rawZoom)));

  // Clip line polylines to the local area. Instead of filtering individual
  // points (which breaks the line at curves), find the index range of points
  // near the trains and slice with a buffer to keep the track contiguous.
  const overlays = [];
  const lineSegments = trainLines?.[bunch.line] || [];
  for (const seg of lineSegments) {
    let minIdx = seg.length;
    let maxIdx = -1;
    for (let i = 0; i < seg.length; i++) {
      const [lat, lon] = seg[i];
      if (bunch.trains.some((t) => haversineFt({ lat, lon }, t) < TRAIN_BUNCH_CONTEXT_FT)) {
        if (i < minIdx) minIdx = i;
        if (i > maxIdx) maxIdx = i;
      }
    }
    if (maxIdx < 0) continue;
    // Pad the slice by a few points so the track extends smoothly past the trains.
    const pad = 3;
    const sliceStart = Math.max(0, minIdx - pad);
    const sliceEnd = Math.min(seg.length, maxIdx + pad + 1);
    const slice = seg.slice(sliceStart, sliceEnd);
    if (slice.length < 2) continue;
    overlays.push(`path-7+${color}-0.7(${encodeURIComponent(encode(slice))})`);
  }
  // Track which trains are at a station for the SVG halo layer.
  const trainAtStation = new Set();
  for (const s of nearestStations) {
    const coveredByTrain = bunch.trains.some((t) => haversineFt({ lat: s.lat, lon: s.lon }, t) < 500);
    if (!coveredByTrain) {
      overlays.push(`pin-s+ffffff(${s.lon.toFixed(5)},${s.lat.toFixed(5)})`);
    } else {
      bunch.trains.forEach((t) => {
        if (haversineFt({ lat: s.lat, lon: s.lon }, t) < 500) trainAtStation.add(t.rn);
      });
    }
  }
  for (const t of bunch.trains) {
    overlays.push(`pin-l-rail-metro+${color}(${t.lon.toFixed(5)},${t.lat.toFixed(5)})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/${centerLon.toFixed(5)},${centerLat.toFixed(5)},${zoom.toFixed(2)}/${SNAPSHOT_WIDTH}x${SNAPSHOT_HEIGHT}@2x?access_token=${token}`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });

  // Compute track bearing at each train's position by snapping to the polyline.
  const allSegPoints = lineSegments.flatMap((seg) =>
    seg.map(([lat, lon]) => ({ lat, lon }))
  );

  // Find the nearest polyline segment to a point using perpendicular distance.
  function nearestSegment(pt) {
    let bestDist = Infinity;
    let bestA = null;
    let bestB = null;
    for (let i = 0; i < allSegPoints.length - 1; i++) {
      const a = allSegPoints[i];
      const b = allSegPoints[i + 1];
      // Project pt onto segment a–b (in lat/lon space, fine for short segments).
      const dx = b.lon - a.lon;
      const dy = b.lat - a.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 0) t = Math.max(0, Math.min(1, ((pt.lon - a.lon) * dx + (pt.lat - a.lat) * dy) / lenSq));
      const proj = { lat: a.lat + t * dy, lon: a.lon + t * dx };
      const d = haversineFt(pt, proj);
      if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
    }
    return { from: bestA, to: bestB };
  }

  function trackBearingAt(train) {
    const { from, to } = nearestSegment(train);
    const fwd = bearing(from, to);
    // If the train heading is closer to the reverse direction, flip it.
    const rev = (fwd + 180) % 360;
    const diffFwd = Math.abs(((train.heading - fwd + 540) % 360) - 180);
    const diffRev = Math.abs(((train.heading - rev + 540) % 360) - 180);
    return diffFwd <= diffRev ? fwd : rev;
  }

  // Composite station name labels, at-station halos, and direction arrows.
  const stationsWithPixels = nearestStations.map((station) => ({
    station,
    ...project(station.lat, station.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT),
  }));
  const atStationPixels = bunch.trains
    .filter((t) => trainAtStation.has(t.rn))
    .map((t) => project(t.lat, t.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT));
  const trainPixels = bunch.trains.map((t) => ({
    ...project(t.lat, t.lon, centerLat, centerLon, zoom, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT),
    bearingDeg: trackBearingAt(t),
  }));
  const svg = buildTrainOverlaySvg(stationsWithPixels, atStationPixels, trainPixels, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

  return sharp(data)
    .resize(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

/**
 * Slice a trainLines polyline (array of [lat, lon]) into N ordered groups by
 * cumulative distance. Same bridging logic as slicePatternIntoSegments but
 * works on [lat, lon] tuples instead of {lat, lon} objects.
 */
function sliceLineIntoSegments(linePoints, cumDist, numBins) {
  const total = cumDist[cumDist.length - 1];
  const segLen = total / numBins;

  const slices = Array.from({ length: numBins }, () => []);
  for (let i = 0; i < linePoints.length; i++) {
    const idx = Math.min(numBins - 1, Math.floor(cumDist[i] / segLen));
    slices[idx].push(linePoints[i]);
  }
  for (let i = 0; i < slices.length - 1; i++) {
    if (slices[i + 1].length > 0) slices[i].push(slices[i + 1][0]);
  }
  return slices;
}

async function renderTrainSpeedmap(linePoints, cumDist, binSpeeds, lineColor) {
  const slices = sliceLineIntoSegments(linePoints, cumDist, binSpeeds.length);

  // Full-route halo in the line's own color at low opacity, then colored speed segments on top.
  const fullEncoded = encodeURIComponent(encode(linePoints));
  const overlays = [`path-${SPEEDMAP_HALO_STROKE}+${ROUTE_HALO_COLOR}(${fullEncoded})`];

  for (let i = 0; i < slices.length; i++) {
    if (slices[i].length < 2) continue;
    const encoded = encodeURIComponent(encode(slices[i]));
    const color = colorForTrainSpeed(binSpeeds[i]);
    overlays.push(`path-${SPEEDMAP_SEGMENT_STROKE}+${color}(${encoded})`);
  }

  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN missing');

  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlays.join(',')}/auto/${WIDTH}x${HEIGHT}@2x?access_token=${token}&padding=60`;
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return sharp(data).jpeg({ quality: 85 }).toBuffer();
}

module.exports = { renderBunchingMap, renderSpeedmap, renderSnapshot, renderTrainBunching, renderTrainSpeedmap };
