// Cross-route bunching map — a cluster involving multiple routes/lines at one
// spot. Unlike the per-route bunching map (which traces one pattern's polyline
// with origin/dest glyphs), this is an intersection view centered on the
// cluster centroid: each vehicle is a bus/train marker colored by its route,
// with a white number chip and a legend mapping color → route. Generic over bus
// and train; the caller passes already-normalized points + legend + markerKind.
//
// Split into view / base-map / frame so the cross-route timelapse video
// (src/map/crossBunchingVideo.js) can render many frames against one fetched
// base map — the still map is just a one-frame render.
const sharp = require('sharp');
const {
  fitZoom,
  project,
  lonToX,
  latToY,
  xToLon,
  yToLat,
  TILE_SIZE,
} = require('../shared/projection');
const { encode } = require('../shared/polyline');
const {
  STYLE,
  WIDTH,
  HEIGHT,
  TWEMOJI_BUS_INNER,
  TWEMOJI_TRAIN_INNER,
  requireMapboxToken,
  fetchMapboxStatic,
  separateMarkers,
  markerLabelChip,
  measureTextWidth,
  buildClipProgress,
  thinPolylinePoints,
  xmlEscape,
} = require('./common');

// Distinct, high-contrast marker colors assigned per route group (index 0..n).
const PALETTE = ['ff2a6d', '27c4f5', 'a162e8', 'ffd166', '06d6a0', 'f78c6b', 'ff8c42', 'c0c0c0'];
const MARKER_RADIUS = 32;
const LEGEND_FONT = 26;
// Route-line overlay strokes (per-group color core over a black halo, the same
// halo/core idiom the per-route bunching maps use). Thinner than the per-route
// 14/8 because a cross-route frame can carry several lines at once.
const ROUTE_PATH_HALO_STROKE = 11;
const ROUTE_PATH_CORE_STROKE = 6;
const ROUTE_PATH_HALO_COLOR = '000';
// Grow the clip past the visible frame so route lines that continue beyond the
// cluster always run fully off every edge rather than stopping at the border.
const FRAME_CLIP_MARGIN = 0.35;

function colorForIndex(i) {
  return PALETTE[i % PALETTE.length];
}

// Color for a route group: a caller-supplied per-group color (e.g. official
// train line colors — Brown, Orange…) when present, else the generic palette
// (buses, which have no canonical color). `colors` is aligned to groupIndex.
function colorForGroup(groupIndex, colors) {
  return colors?.[groupIndex] || colorForIndex(groupIndex);
}

// Measured text widths are stable per (label, size) and the legend text repeats
// across every video frame, so cache them per-process (librsvg measurement is
// the same trick buildGhostLegend uses).
const _textWidthCache = new Map();
async function measureCached(label, fontSize) {
  const key = `${fontSize}:${label}`;
  if (!_textWidthCache.has(key)) {
    _textWidthCache.set(key, await measureTextWidth(label, fontSize, { bold: false }));
  }
  return _textWidthCache.get(key);
}

// A vehicle marker: route-colored fill circle + bus/train glyph + white ring.
// Mirrors buildBusMarker / the train bunching marker, but generic over the
// glyph so one renderer serves both modes. Number chip is drawn separately, in
// a layer above all markers, so an overlapping marker can't bury a chip.
function buildCrossMarker({ x, y, radius, color, inner, opacity = 1 }) {
  const size = radius * 1.6;
  const body = [
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="#${color}"/>`,
    `<svg x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}" viewBox="0 0 36 36">${inner}</svg>`,
    `<circle cx="${x}" cy="${y}" r="${radius}" fill="none" stroke="#fff" stroke-width="4"/>`,
  ].join('');
  return opacity < 1 ? `<g opacity="${opacity}">${body}</g>` : body;
}

// Framing (center + zoom) covering all `points` ({ lat, lon }). For a video,
// pass every position across the whole window so the viewport stays stable.
function computeCrossView(points) {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const bbox = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
  };
  // Pad so a tight cluster isn't max-zoomed into a blank patch of map; the min
  // floor handles a 0-span cluster (all vehicles close together at one stop).
  const padLat = Math.max((bbox.maxLat - bbox.minLat) * 0.25, 0.0025);
  const padLon = Math.max((bbox.maxLon - bbox.minLon) * 0.25, 0.0025);
  const padded = {
    minLat: bbox.minLat - padLat,
    maxLat: bbox.maxLat + padLat,
    minLon: bbox.minLon - padLon,
    maxLon: bbox.maxLon + padLon,
  };
  const centerLat = (padded.minLat + padded.maxLat) / 2;
  const centerLon = (padded.minLon + padded.maxLon) / 2;
  // Fractional zoom (Mapbox static accepts it) — flooring dropped up to a full
  // level, doubling the ground area and leaving a wide cluster tiny in the frame.
  const zoom = Math.max(12, Math.min(17, fitZoom(padded, WIDTH, HEIGHT, 90)));
  return { centerLat, centerLon, zoom, bbox: padded };
}

// Geographic bounds of the rendered frame, recovered from its center + zoom and
// grown by `margin` (fraction of the frame) on every side. Clipping route lines
// to *this* — the actual viewport, not the data bbox — is what guarantees a line
// that continues past the cluster runs all the way off every edge, at any zoom.
function frameBounds(view, margin = FRAME_CLIP_MARGIN) {
  const worldSize = TILE_SIZE * 2 ** view.zoom;
  const cx = lonToX(view.centerLon);
  const cy = latToY(view.centerLat);
  const halfX = (WIDTH / 2 / worldSize) * (1 + margin);
  const halfY = (HEIGHT / 2 / worldSize) * (1 + margin);
  return {
    minLon: xToLon(cx - halfX),
    maxLon: xToLon(cx + halfX),
    maxLat: yToLat(cy - halfY), // smaller mercator-y = higher latitude
    minLat: yToLat(cy + halfY),
  };
}

// Keep only the stretch of a route polyline that's within (a slightly grown)
// frame. A full pattern/line shape runs miles past this intersection view;
// baking the whole thing wastes Mapbox URL budget (several routes at once) and
// draws nothing visible. We keep a point whenever it OR a neighbor is inside, so
// a segment crossing the boundary keeps its outside endpoint and the line runs
// to the frame edge instead of stopping short.
function clipPathToView(points, view) {
  if (!Array.isArray(points) || points.length < 2 || !view) return [];
  const box = frameBounds(view);
  const inside = (p) =>
    p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= box.minLat &&
    p.lat <= box.maxLat &&
    p.lon >= box.minLon &&
    p.lon <= box.maxLon;
  const kept = points.filter((p, i) => inside(p) || inside(points[i - 1]) || inside(points[i + 1]));
  return kept.length >= 2 ? kept : [];
}

// Mapbox static `path-` overlays for each route group's polyline, clipped to the
// view and colored to match that group's discs + legend. All halos first, then
// all cores, so where two routes cross a core is never buried under another
// route's halo. `routePaths`: [{ points:[{lat,lon}], groupIndex }].
function buildRoutePathOverlays(routePaths, view, colors) {
  const halos = [];
  const cores = [];
  for (const rp of routePaths || []) {
    // Clip to the frame, then thin so a dense GTFS shape (a vertex every few
    // feet) doesn't blow the Mapbox static URL length with several lines at once.
    const pts = thinPolylinePoints(clipPathToView(rp?.points, view), 120);
    if (pts.length < 2) continue;
    const encoded = encodeURIComponent(encode(pts.map((p) => [p.lat, p.lon])));
    halos.push(`path-${ROUTE_PATH_HALO_STROKE}+${ROUTE_PATH_HALO_COLOR}(${encoded})`);
    cores.push(
      `path-${ROUTE_PATH_CORE_STROKE}+${colorForGroup(rp.groupIndex, colors)}(${encoded})`,
    );
  }
  return [...halos, ...cores];
}

async function fetchCrossBaseMap(view, routePaths = [], colors = []) {
  const token = requireMapboxToken();
  const overlays = buildRoutePathOverlays(routePaths, view, colors);
  const overlaySeg = overlays.length ? `${overlays.join(',')}/` : '';
  const url = `https://api.mapbox.com/styles/v1/${STYLE}/static/${overlaySeg}${view.centerLon.toFixed(5)},${view.centerLat.toFixed(5)},${view.zoom.toFixed(2)}/${WIDTH}x${HEIGHT}@2x?access_token=${token}`;
  return fetchMapboxStatic(url, 20000);
}

// Legend bottom-left: a color swatch + route label per group, in a box sized to
// the widest label (measured) so long names don't spill past the background.
async function buildLegend(legend, colors) {
  if (!legend.length) return '';
  const padX = 16;
  const r = 14;
  const gap = 12;
  const rowH = 40;
  const textX = padX + 2 * r + gap; // label start, relative to box left
  const widths = await Promise.all(legend.map((g) => measureCached(g.label, LEGEND_FONT)));
  const maxLabelW = Math.max(0, ...widths);
  const boxW = Math.ceil(textX + maxLabelW + padX);
  const boxH = legend.length * rowH + 16;
  const x0 = 24;
  const y0 = HEIGHT - boxH - 24;
  const els = [
    `<rect x="${x0}" y="${y0}" width="${boxW}" height="${boxH}" rx="8" fill="#000" fill-opacity="0.7"/>`,
  ];
  legend.forEach((g, i) => {
    const cy = y0 + 16 + i * rowH + rowH / 2 - 8;
    const color = `#${colorForGroup(g.groupIndex, colors)}`;
    els.push(
      `<circle cx="${x0 + padX + r}" cy="${cy}" r="${r}" fill="${color}" stroke="#fff" stroke-width="2"/>`,
      `<text x="${x0 + textX}" y="${cy + 9}" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${LEGEND_FONT}" font-weight="600">${xmlEscape(g.label)}</text>`,
    );
  });
  return els.join('');
}

// Composite one frame: bus/train markers colored per route group + white number
// chips (honoring per-vehicle `opacity` so dropped vehicles fade), legend,
// title, and an optional clip progress bar (video). `vehicles` =
// [{ lat, lon, label, groupIndex, opacity? }].
async function renderCrossFrame(
  view,
  baseMap,
  vehicles,
  { legend = [], title = '', clock = null, markerKind = 'bus', colors = [] } = {},
) {
  const inner = markerKind === 'train' ? TWEMOJI_TRAIN_INNER : TWEMOJI_BUS_INNER;
  const raw = vehicles.map((p) =>
    project(p.lat, p.lon, view.centerLat, view.centerLon, view.zoom, WIDTH, HEIGHT),
  );
  const sep = separateMarkers(raw, MARKER_RADIUS * 2 + 6);
  const markerEls = vehicles.map((p, i) =>
    buildCrossMarker({
      x: sep[i].x,
      y: sep[i].y,
      radius: MARKER_RADIUS,
      color: colorForGroup(p.groupIndex, colors),
      inner,
      opacity: p.opacity ?? 1,
    }),
  );
  // Chips in their own layer above every marker so an overlapping marker can't
  // bury a neighbor's number. Fade with the marker when it's a ghost.
  const chipEls = vehicles.map((p, i) => {
    const chip = markerLabelChip(sep[i].x, sep[i].y, MARKER_RADIUS, p.label);
    const op = p.opacity ?? 1;
    return op < 1 && chip ? `<g opacity="${op}">${chip}</g>` : chip;
  });

  const legendEl = await buildLegend(legend, colors);

  const titleEls = [];
  if (title) {
    const pillH = 56;
    const pillW = Math.min(WIDTH - 80, title.length * 20 + 48);
    const x0 = (WIDTH - pillW) / 2;
    titleEls.push(
      `<rect x="${x0}" y="24" width="${pillW}" height="${pillH}" rx="10" fill="#000" fill-opacity="0.72"/>`,
      `<text x="${WIDTH / 2}" y="${24 + pillH / 2 + 11}" text-anchor="middle" fill="#fff" font-family="Inter, Helvetica, Arial, sans-serif" font-size="32" font-weight="700">${xmlEscape(title)}</text>`,
    );
  }

  const clockEls = clock ? [buildClipProgress({ ...clock, width: WIDTH, height: HEIGHT })] : [];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${titleEls.join('')}${legendEl}${markerEls.join('')}${chipEls.join('')}${clockEls.join('')}</svg>`;
  return sharp(baseMap)
    .resize(WIDTH, HEIGHT)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

// `points`: [{ lat, lon, label, groupIndex }]. `legend`: [{ label, groupIndex }].
// `markerKind`: 'bus' | 'train'. Returns a JPEG buffer (single frame); throws
// (caller posts text-only) on <2 points or a missing Mapbox token.
async function renderCrossBunchingMap({
  points,
  legend = [],
  title = '',
  markerKind = 'bus',
  routePaths = [],
  colors = [],
}) {
  if (!points || points.length < 2) throw new Error('cross-bunching map needs ≥2 points');
  const view = computeCrossView(points);
  const baseMap = await fetchCrossBaseMap(view, routePaths, colors);
  return renderCrossFrame(view, baseMap, points, { legend, title, markerKind, colors });
}

// Build the normalized { points, legend } the renderer wants from a cluster's
// vehicles/trains. `items` are the cluster members; `idOf`/`groupKeyOf` read an
// item's id and its route/line; `labels` is the Map(id→discNumber) from
// groupByRoute/groupByLine; `groupOrder` is the ordered list of route/line keys
// (so legend + color indices match the post text); `legendLabelOf` renders a
// group key to its display label.
function pointsFromCluster(items, { idOf, groupKeyOf, labels, groupOrder, legendLabelOf }) {
  const groupIndex = new Map(groupOrder.map((k, i) => [k, i]));
  const points = items.map((it) => ({
    lat: it.lat,
    lon: it.lon,
    label: String(labels.get(idOf(it)) ?? '?'),
    groupIndex: groupIndex.get(groupKeyOf(it)) ?? 0,
  }));
  const legend = groupOrder.map((k, i) => ({ label: legendLabelOf(k), groupIndex: i }));
  return { points, legend };
}

module.exports = {
  renderCrossBunchingMap,
  renderCrossFrame,
  computeCrossView,
  fetchCrossBaseMap,
  buildRoutePathOverlays,
  clipPathToView,
  pointsFromCluster,
  PALETTE,
};
