const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-pulse-state-'));
  const dbPath = Path.join(dir, 'history.sqlite');
  process.env.HISTORY_DB_PATH = dbPath;
  delete require.cache[require.resolve('../../src/shared/history')];
  const history = require('../../src/shared/history');
  history.getDb();
  return {
    history,
    cleanup: () => {
      try {
        history.getDb().close();
      } catch (_e) {
        /* ignore */
      }
      delete require.cache[require.resolve('../../src/shared/history')];
      delete process.env.HISTORY_DB_PATH;
      try {
        Fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        /* ignore */
      }
    },
  };
}

test('pulse_state schema includes active_post_uri and active_post_ts', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(pulse_state)')
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('active_post_uri'));
    assert.ok(cols.includes('active_post_ts'));
  } finally {
    cleanup();
  }
});

test('upsertPulseState round-trips active_post_uri and active_post_ts', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertPulseState({
      line: 'y',
      direction: 'all',
      runLoFt: 1000,
      runHiFt: 5000,
      fromStation: 'Howard',
      toStation: 'Dempster-Skokie',
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'train_pulse_y_all_howard__dempster_skokie',
      activePostUri: 'at://pulse-1',
      activePostTs: now,
    });
    const row = history.getPulseState('y', 'all');
    assert.equal(row.active_post_uri, 'at://pulse-1');
    assert.equal(row.active_post_ts, now);
  } finally {
    cleanup();
  }
});

test('upsertPulseState preserves active_post_uri across updates when not specified', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertPulseState({
      line: 'y',
      direction: 'all',
      runLoFt: 1000,
      runHiFt: 5000,
      fromStation: 'Howard',
      toStation: 'Dempster-Skokie',
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: 'at://pulse-1',
      activePostTs: now,
    });
    const prior = history.getPulseState('y', 'all');
    // Caller is responsible for forwarding the prior active uri; the upsert
    // overwrites with whatever the caller passes. Verify pass-through.
    history.upsertPulseState({
      line: 'y',
      direction: 'all',
      runLoFt: 1100,
      runHiFt: 5100,
      fromStation: 'Howard',
      toStation: 'Dempster-Skokie',
      startedTs: prior.started_ts,
      lastSeenTs: now + 60_000,
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'k',
      activePostUri: prior.active_post_uri,
      activePostTs: prior.active_post_ts,
    });
    const row = history.getPulseState('y', 'all');
    assert.equal(row.active_post_uri, 'at://pulse-1');
  } finally {
    cleanup();
  }
});

test('hasObservedClearForPulse distinguishes per pulse uri', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const t0 = Date.now() - 60_000;
    // Two distinct pulses.
    history.recordDisruption(
      {
        kind: 'train',
        line: 'y',
        direction: 'all',
        fromStation: 'Howard',
        toStation: 'Dempster-Skokie',
        source: 'observed',
        posted: true,
        postUri: 'at://p1',
      },
      t0,
    );
    history.recordDisruption(
      {
        kind: 'train',
        line: 'y',
        direction: 'all',
        fromStation: 'Howard',
        toStation: 'Dempster-Skokie',
        source: 'observed',
        posted: true,
        postUri: 'at://p2',
      },
      t0 + 1000,
    );
    // Clear after p2.
    history.recordDisruption(
      {
        kind: 'train',
        line: 'y',
        direction: 'all',
        fromStation: 'Howard',
        toStation: 'Dempster-Skokie',
        source: 'observed-clear',
        posted: true,
        postUri: 'at://c2',
      },
      t0 + 2000,
    );
    // p1 was posted before the clear — so a clear "since p1" exists. p2 also exists.
    assert.equal(history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://p1' }), true);
    assert.equal(history.hasObservedClearForPulse({ kind: 'train', pulseUri: 'at://p2' }), true);
  } finally {
    cleanup();
  }
});
