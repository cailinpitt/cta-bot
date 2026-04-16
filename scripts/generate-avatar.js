// Render the 🚌 bus emoji as the profile avatar. We download the Twemoji SVG
// so the emoji renders identically regardless of the OS font — Apple's bus
// emoji wouldn't display consistently on the Ubuntu deploy host.
const Fs = require('fs-extra');
const Path = require('path');
const axios = require('axios');
const sharp = require('sharp');

// Bus = U+1F68C
const BUS_SVG_URL = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/1f68c.svg';
const W = 1024;
const H = 1024;

async function main() {
  console.log(`Fetching ${BUS_SVG_URL}...`);
  const { data: svg } = await axios.get(BUS_SVG_URL, { responseType: 'text', timeout: 30000 });

  // Soft gradient circle behind the emoji so the avatar reads well inside
  // Bluesky's circular crop (and the corners don't matter).
  const emojiSize = 760;
  const composite = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="bg" cx="50%" cy="50%" r="70%">
        <stop offset="0%" stop-color="#ffe98a"/>
        <stop offset="100%" stop-color="#f9b928"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
  </svg>`;

  const outPath = Path.join(__dirname, '..', 'assets', 'avatar.png');
  Fs.ensureDirSync(Path.dirname(outPath));

  // Render background, then composite the emoji centered.
  const bgBuffer = await sharp(Buffer.from(composite)).png().toBuffer();
  // Rasterize emoji at high res, trim transparent padding (Twemoji SVGs have
  // built-in whitespace that throws off centering), then resize to target.
  const emojiBuffer = await sharp(Buffer.from(svg), { density: 600 })
    .png()
    .trim()
    .resize(emojiSize, emojiSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  await sharp(bgBuffer)
    .composite([{ input: emojiBuffer, gravity: 'center' }])
    .png()
    .toFile(outPath);

  console.log(`Wrote ${outPath}`);
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
