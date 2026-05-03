const axios = require('axios');
const { recordTrainObservations } = require('../shared/observations');
const { withRetry } = require('../shared/retry');

const BASE = 'https://lapi.transitchicago.com/api/1.0';
const ALL_LINES = ['red', 'blue', 'brn', 'g', 'org', 'p', 'pink', 'y'];

// Official CTA line colors (hex without leading #) for Mapbox overlays and post text.
const LINE_COLORS = {
  red: 'c60c30',
  blue: '00a1de',
  brn: '62361b',
  g: '009b3a',
  org: 'f9461c',
  p: '522398',
  pink: 'e27ea6',
  y: 'f9e300',
};

const LINE_NAMES = {
  red: 'Red',
  blue: 'Blue',
  brn: 'Brown',
  g: 'Green',
  org: 'Orange',
  p: 'Purple',
  pink: 'Pink',
  y: 'Yellow',
};

// Friendly line label for log lines (`brn` → `Brown`). Falls back to the raw
// code when something hands us a key we don't recognize, so logs never
// silently lose information.
const lineLabel = (line) => LINE_NAMES[line] || line;

// Unicode has no pink square; 🩷 (pink heart) is the closest color-block stand-in.
const LINE_EMOJI = {
  red: '🟥',
  blue: '🟦',
  brn: '🟫',
  g: '🟩',
  org: '🟧',
  p: '🟪',
  pink: '🩷',
  y: '🟨',
};

function parseTrain(line, raw) {
  return {
    line,
    rn: raw.rn,
    destination: raw.destNm,
    trDr: raw.trDr, // Direction code — '1' or '5'. Use with destination for context.
    nextStation: raw.nextStaNm,
    approaching: raw.isApp === '1',
    delayed: raw.isDly === '1',
    lat: parseFloat(raw.lat),
    lon: parseFloat(raw.lon),
    heading: parseInt(raw.heading, 10),
  };
}

// Rough Chicagoland bounding box. Trains reporting outside this are API glitches
// (e.g. a known issue where unpositioned trains come back with lat/lon 0,0).
function isInChicagoland(lat, lon) {
  return lat > 41 && lat < 43 && lon > -88.5 && lon < -87;
}

async function getAllTrainPositions(lines = ALL_LINES) {
  const { data } = await withRetry(
    () =>
      axios.get(`${BASE}/ttpositions.aspx`, {
        params: { key: process.env.CTA_TRAIN_KEY, rt: lines.join(','), outputType: 'JSON' },
        timeout: 15000,
      }),
    { label: 'CTA train positions' },
  );
  const body = data.ctatt;
  if (body.errCd !== '0') throw new Error(`Train API error ${body.errCd}: ${body.errNm}`);

  const trains = [];
  let filtered = 0;
  for (const route of body.route || []) {
    const line = route['@name'];
    // API returns `train` as an object when there's exactly one train on the line,
    // and as an array otherwise. Normalize.
    const raws = Array.isArray(route.train) ? route.train : route.train ? [route.train] : [];
    for (const raw of raws) {
      const train = parseTrain(line, raw);
      if (!isInChicagoland(train.lat, train.lon)) {
        filtered++;
        continue;
      }
      trains.push(train);
    }
  }
  if (filtered > 0) console.log(`Filtered ${filtered} train(s) with out-of-bounds coordinates`);
  recordTrainObservations(trains);
  return trains;
}

// Strip the trailing parenthetical from a station name. Station data carries
// line/branch tags (e.g. "Western (Blue - Forest Park Branch)") to disambiguate
// same-named stops across the system, but bunching/gap posts and maps already
// display the line, so the tag reads as clutter. Branch ambiguity (two
// "Western" on the Blue Line) is rare enough to tolerate in exchange.
const TRAILING_PARENS = /\s*\([^)]*\)\s*$/;
// Station names longer than the typical ~15 char label eat horizontal space
// on dense stretches (Green Line west branch) and spill their rect across
// adjacent station pins. Override with a shorter form; the line is already
// stated in the post so the omitted qualifier doesn't harm readability.
const STATION_NAME_OVERRIDES = {
  'Conservatory-Central Park Drive': 'Conservatory',
  'Jefferson Park Transit Center': 'Jefferson Park',
  'Illinois Medical District': 'IMD',
  'Cermak-McCormick Place': 'Cermak',
  '35th-Bronzeville-IIT': '35th-Bronzeville',
};
function shortStationName(name) {
  if (!name) return name;
  if (STATION_NAME_OVERRIDES[name]) return STATION_NAME_OVERRIDES[name];
  return name.replace(TRAILING_PARENS, '');
}

module.exports = {
  getAllTrainPositions,
  LINE_COLORS,
  LINE_NAMES,
  lineLabel,
  LINE_EMOJI,
  ALL_LINES,
  shortStationName,
};
