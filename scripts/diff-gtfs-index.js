// Compare two GTFS index JSON files and report per-bucket headway deltas.
// Usage: node scripts/diff-gtfs-index.js <before.json> <after.json>
// Flags any (route|dir|dayType|hour) bucket whose |delta| > FLAG_MIN.
const Fs = require('fs-extra');

const FLAG_MIN = 3;

function walk(index, kind) {
  const out = new Map();
  const group = index[kind] || {};
  for (const [route, dirs] of Object.entries(group)) {
    for (const [dir, info] of Object.entries(dirs)) {
      const headways = info.headways || {};
      for (const [dayType, hours] of Object.entries(headways)) {
        for (const [hour, val] of Object.entries(hours)) {
          out.set(`${kind}|${route}|${dir}|${dayType}|${hour}`, val);
        }
      }
    }
  }
  return out;
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('Usage: node scripts/diff-gtfs-index.js <before.json> <after.json>');
    process.exit(2);
  }
  const before = Fs.readJsonSync(beforePath);
  const after = Fs.readJsonSync(afterPath);

  const rows = [];
  const addedKeys = [];
  const removedKeys = [];
  for (const kind of ['routes', 'lines']) {
    const b = walk(before, kind);
    const a = walk(after, kind);
    const allKeys = new Set([...b.keys(), ...a.keys()]);
    for (const k of allKeys) {
      const bv = b.get(k);
      const av = a.get(k);
      if (bv == null && av != null) { addedKeys.push(k); continue; }
      if (av == null && bv != null) { removedKeys.push(k); continue; }
      const delta = av - bv;
      rows.push({ k, before: bv, after: av, delta });
    }
  }

  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const flagged = rows.filter((r) => Math.abs(r.delta) > FLAG_MIN);
  console.log(`\nFlagged buckets (|delta| > ${FLAG_MIN} min): ${flagged.length}`);
  for (const r of flagged) {
    console.log(`  ${r.k}  before=${r.before}  after=${r.after}  delta=${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}`);
  }

  console.log(`\nTop 25 deltas overall:`);
  for (const r of rows.slice(0, 25)) {
    console.log(`  ${r.k}  before=${r.before}  after=${r.after}  delta=${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}`);
  }

  console.log(`\nAdded buckets (new in after): ${addedKeys.length}`);
  console.log(`Removed buckets (gone in after): ${removedKeys.length}`);
  if (removedKeys.length) for (const k of removedKeys.slice(0, 25)) console.log(`  - ${k}`);

  const totalChanged = rows.filter((r) => r.delta !== 0).length;
  console.log(`\nSummary: ${rows.length} shared buckets, ${totalChanged} changed, ${flagged.length} flagged`);
}

main();
