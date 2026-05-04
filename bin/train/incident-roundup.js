#!/usr/bin/env node
// Multi-signal correlation roundup: when several detectors have sub-threshold
// signals on the same line within a 30-min window, post a single text-only
// rollup acknowledging that something is up. Catches incidents where no
// individual gate fires but the union of signals is loud (e.g. 2026-05-03
// Red: gap suppressed at 2.66x, ghost 2.5/8.5 missing, pulse on a small
// mid-Loop segment).

require('../../src/shared/env');

const { setup, runBin } = require('../../src/shared/runBin');
const { ALL_LINES, lineLabel } = require('../../src/train/api');
const { getRecentMetaSignals, getDb } = require('../../src/shared/history');
const { acquireCooldown } = require('../../src/shared/state');
const { loginAlerts, postText } = require('../../src/shared/bluesky');

const WINDOW_MS = 30 * 60 * 1000;
const SCORE_THRESHOLD = 2.0;
const ROUNDUP_COOLDOWN_MS = 60 * 60 * 1000;
const KIND = 'train';
const DRY_RUN = process.env.ROUNDUP_DRY_RUN === '1' || process.argv.includes('--dry-run');

function scoreSignals(signals) {
  // Sum severity per source, then sum source contributions. Distinct sources
  // count more than redundant ones.
  const bySource = new Map();
  for (const s of signals) {
    const cur = bySource.get(s.source) || 0;
    if (s.severity > cur) bySource.set(s.source, s.severity);
  }
  let total = 0;
  for (const v of bySource.values()) total += v;
  return { total, bySource };
}

function describeSignal(s) {
  let detail = {};
  try {
    detail = s.detail ? JSON.parse(s.detail) : {};
  } catch (_e) {
    detail = {};
  }
  if (s.source === 'gap') {
    return `· ${detail.ratio || '?'}x gap (${detail.suppressed || 'recorded'})`;
  }
  if (s.source === 'ghost') {
    return `· ${Math.round((detail.missing || 0) * 10) / 10} of ${Math.round((detail.expected || 0) * 10) / 10} trains missing`;
  }
  if (s.source === 'pulse-cold' || s.source === 'pulse-held') {
    const seg =
      detail.fromStation && detail.toStation ? ` ${detail.fromStation} → ${detail.toStation}` : '';
    return `· pulse near-miss${seg}`;
  }
  return `· ${s.source}`;
}

function buildRoundupText(line, signals) {
  const lineName = lineLabel(line);
  const lines = [`⚠ ${lineName} Line · multiple service signals`];
  const seen = new Set();
  for (const s of signals) {
    const key = s.source;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(describeSignal(s));
  }
  lines.push('');
  lines.push(
    'None individually crossed its alert threshold; together they suggest service is degraded.',
  );
  return lines.join('\n');
}

async function main() {
  setup();
  const now = Date.now();

  let agent = null;
  const agentGetter = async () => {
    if (!agent) agent = await loginAlerts();
    return agent;
  };

  for (const line of ALL_LINES) {
    const signals = getRecentMetaSignals({ kind: KIND, line, withinMs: WINDOW_MS }, now);
    if (signals.length === 0) continue;
    const { total, bySource } = scoreSignals(signals);
    if (total < SCORE_THRESHOLD) {
      console.log(
        `roundup: ${lineLabel(line)} score=${total.toFixed(2)} sources=${[...bySource.keys()].join(',')} below threshold`,
      );
      continue;
    }
    const cooldownKey = `train_roundup_${line}`;
    if (DRY_RUN) {
      console.log(
        `--- DRY RUN roundup ${lineLabel(line)} score=${total.toFixed(2)} ---\n${buildRoundupText(line, signals)}`,
      );
      continue;
    }
    if (!acquireCooldown(cooldownKey, now, ROUNDUP_COOLDOWN_MS)) {
      console.log(`roundup: ${lineLabel(line)} cooldown active, skipping`);
      continue;
    }
    const text = buildRoundupText(line, signals);
    try {
      const a = await agentGetter();
      const result = await postText(a, text, null);
      console.log(`Posted roundup ${lineLabel(line)}: ${result.url}`);
      // Mark contributing signals as posted via meta_signals.posted = 1
      const ids = signals.map((s) => s.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        getDb()
          .prepare(`UPDATE meta_signals SET posted = 1 WHERE id IN (${placeholders})`)
          .run(...ids);
      }
    } catch (e) {
      console.error(`roundup post failed for ${lineLabel(line)}: ${e.stack || e.message}`);
    }
  }
}

module.exports = { scoreSignals, buildRoundupText, describeSignal };

if (require.main === module) runBin(main);
