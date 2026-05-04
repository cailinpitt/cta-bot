const test = require('node:test');
const assert = require('node:assert');
const {
  scoreSignals,
  buildRoundupText,
  describeSignal,
  buildResolutionText,
} = require('../../bin/incident-roundup');

test('scoreSignals dedupes by source, takes max severity', () => {
  const signals = [
    { source: 'gap', severity: 0.5, detail: null },
    { source: 'gap', severity: 0.8, detail: null },
    { source: 'pulse-cold', severity: 0.5, detail: null },
  ];
  const { total, bySource } = scoreSignals(signals);
  assert.equal(bySource.get('gap'), 0.8);
  assert.equal(bySource.get('pulse-cold'), 0.5);
  assert.equal(Math.round(total * 10) / 10, 1.3);
});

test('train roundup text includes line name and signals', () => {
  const text = buildRoundupText({
    kind: 'train',
    line: 'red',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 2.6, suppressed: 'cap' }) },
      { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 2.5, expected: 8.5 }) },
    ],
  });
  assert.ok(text.includes('Red'));
  assert.ok(text.includes('multiple service signals'));
  assert.ok(text.includes('2.6x'));
  assert.ok(text.includes('trains missing'));
});

test('bus roundup text uses #route framing and "buses missing"', () => {
  const text = buildRoundupText({
    kind: 'bus',
    line: '147',
    name: 'Outer DuSable Lake Shore Express',
    signals: [
      { source: 'gap', severity: 0.7, detail: JSON.stringify({ ratio: 4.0, suppressed: 'cap' }) },
      {
        source: 'bunching',
        severity: 0.6,
        detail: JSON.stringify({ vehicles: 3, span_ft: 1040, suppressed: 'cap' }),
      },
      {
        source: 'pulse-held',
        severity: 1.0,
        detail: JSON.stringify({ route: '147', kind: 'held' }),
      },
    ],
  });
  assert.ok(text.includes('#147'));
  assert.ok(text.includes('Outer DuSable'));
  assert.ok(text.includes('buses bunched together'));
  assert.ok(text.includes('appear stuck in place') || text.includes('service gap forming'));
});

test('describeSignal handles unknown source gracefully', () => {
  const text = describeSignal({ source: 'unknown', severity: 0.5, detail: null }, 'train');
  assert.ok(text.includes('unknown'));
});

test('describeSignal: bunching uses plain-language suppression reason', () => {
  const cd = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 4, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.ok(cd.includes('4 buses bunched together'));
  assert.ok(cd.includes('covered by a recent post'));
  assert.ok(!cd.toLowerCase().includes('near-miss'));

  const cap = describeSignal(
    {
      source: 'bunching',
      severity: 0.8,
      detail: JSON.stringify({ vehicles: 5, suppressed: 'cap' }),
    },
    'bus',
  );
  assert.ok(cap.includes("over today's post limit"));
});

test('describeSignal: gap ratio rounds to one decimal', () => {
  const text = describeSignal(
    {
      source: 'gap',
      severity: 0.6,
      detail: JSON.stringify({ ratio: 4.073404856013552, suppressed: 'cooldown' }),
    },
    'bus',
  );
  assert.ok(text.includes('4.1x'));
  assert.ok(!text.includes('4.073'));
});

test('describeSignal: ghost missing/expected round to whole vehicles', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.7, detail: JSON.stringify({ missing: 7.3, expected: 18.3 }) },
    'bus',
  );
  assert.ok(text.includes('7 of 18 buses missing'));
  assert.ok(!text.includes('.3'));
});

test('describeSignal: bus ghost says "buses" not "trains"', () => {
  const text = describeSignal(
    { source: 'ghost', severity: 0.9, detail: JSON.stringify({ missing: 4, expected: 12 }) },
    'bus',
  );
  assert.ok(text.includes('buses missing'));
});

test('buildResolutionText: bus uses 🚌✅ + #route framing', () => {
  const text = buildResolutionText({ kind: 'bus', line: '66', name: 'Chicago' });
  assert.ok(text.startsWith('🚌✅'));
  assert.ok(text.includes('#66 Chicago'));
  assert.ok(text.includes('back to normal'));
});

test('sweepResolutions: posts after MIN_CLEAR_TICKS consecutive sub-threshold ticks', async () => {
  const Path = require('node:path');
  const Fs = require('node:fs');
  const Os = require('node:os');
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-resolve-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  delete require.cache[require.resolve('../../src/shared/history')];
  delete require.cache[require.resolve('../../bin/incident-roundup')];
  const history = require('../../src/shared/history');
  const { sweepResolutions: sweep } = require('../../bin/incident-roundup');
  history.getDb();
  try {
    const ROUNDUP_URI = 'at://did:plc:alerts/app.bsky.feed.post/roundup-1';
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: ROUNDUP_URI,
      postCid: 'cid-1',
      ts: Date.now() - 10 * 60_000,
    });
    const posts = [];
    const agent = {
      session: { did: 'did:plc:test' },
      com: {
        atproto: {
          repo: {
            getRecord: async () => ({ data: { uri: ROUNDUP_URI, cid: 'cid-1', value: {} } }),
          },
        },
      },
      post: async (req) => {
        const r = { uri: 'at://did:plc:test/app.bsky.feed.post/resolve-1', cid: 'cid-r' };
        posts.push({ ...req, ...r });
        return r;
      },
    };
    const agentGetter = async () => agent;

    // No meta_signals at all → score=0 → clear ticks should accumulate.
    const now = Date.now();
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now });
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 60_000 });
    assert.equal(posts.length, 0, 'should not resolve before MIN_CLEAR_TICKS');

    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 120_000 });
    assert.equal(posts.length, 1, 'should resolve on 3rd consecutive clear tick');
    assert.ok(posts[0].text.startsWith('🚌✅'));
    assert.equal(posts[0].reply.root.uri, ROUNDUP_URI);

    // Subsequent sweeps shouldn't post again — resolved_ts is now set.
    await sweep({ kind: 'bus', getName: () => 'Chicago', agentGetter, now: now + 180_000 });
    assert.equal(posts.length, 1, 'resolved roundups are not swept again');
  } finally {
    try {
      history.getDb().close();
    } catch (_e) {}
    delete require.cache[require.resolve('../../src/shared/history')];
    delete require.cache[require.resolve('../../bin/incident-roundup')];
    delete process.env.HISTORY_DB_PATH;
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepResolutions: elevated score resets clear_ticks counter', async () => {
  const Path = require('node:path');
  const Fs = require('node:fs');
  const Os = require('node:os');
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-resolve2-'));
  process.env.HISTORY_DB_PATH = Path.join(dir, 'history.sqlite');
  delete require.cache[require.resolve('../../src/shared/history')];
  delete require.cache[require.resolve('../../bin/incident-roundup')];
  const history = require('../../src/shared/history');
  const { sweepResolutions: sweep } = require('../../bin/incident-roundup');
  history.getDb();
  try {
    history.recordRoundupAnchor({
      kind: 'bus',
      line: '66',
      postUri: 'at://x/p/r',
      postCid: 'c',
      ts: Date.now(),
    });
    // Seed a fresh hot signal so score >= RESOLVE_SCORE_THRESHOLD (1.0).
    history.recordMetaSignal({
      kind: 'bus',
      line: '66',
      direction: null,
      source: 'gap',
      severity: 1.0,
      detail: { ratio: 4.0 },
      posted: true,
    });
    // Pre-set clear_ticks to 2 so we'd be one tick from resolving if quiet.
    history.getDb().prepare('UPDATE roundup_anchors SET clear_ticks = 2').run();

    const posts = [];
    const agent = {
      post: async () => {
        posts.push(1);
        return { uri: 'x', cid: 'y' };
      },
      com: {
        atproto: { repo: { getRecord: async () => ({ data: { uri: 'x', cid: 'y', value: {} } }) } },
      },
    };
    await sweep({
      kind: 'bus',
      getName: () => null,
      agentGetter: async () => agent,
      now: Date.now(),
    });
    assert.equal(posts.length, 0, 'elevated score must not resolve');
    const row = history.getDb().prepare('SELECT clear_ticks FROM roundup_anchors').get();
    assert.equal(row.clear_ticks, 0, 'clear_ticks resets when score elevated');
  } finally {
    try {
      history.getDb().close();
    } catch (_e) {}
    delete require.cache[require.resolve('../../src/shared/history')];
    delete require.cache[require.resolve('../../bin/incident-roundup')];
    delete process.env.HISTORY_DB_PATH;
    Fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildResolutionText: train uses 🚇✅ + Line framing', () => {
  const text = buildResolutionText({ kind: 'train', line: 'red', name: null });
  assert.ok(text.startsWith('🚇✅'));
  assert.ok(text.includes('Red Line'));
  assert.ok(text.includes('back to normal'));
});
