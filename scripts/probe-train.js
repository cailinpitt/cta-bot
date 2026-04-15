require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

async function main() {
  const key = process.env.CTA_TRAIN_KEY;
  if (!key) throw new Error('CTA_TRAIN_KEY missing');

  const lines = process.argv[2] || 'red,blue,brn,g,org,p,pink,y';
  const url = 'http://lapi.transitchicago.com/api/1.0/ttpositions.aspx';
  const { data } = await axios.get(url, {
    params: { key, rt: lines, outputType: 'JSON' },
    timeout: 15000,
  });

  console.log(JSON.stringify(data, null, 2));
}

main().catch((e) => { console.error(e.response?.data || e.message); process.exit(1); });
