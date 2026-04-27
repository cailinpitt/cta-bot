const test = require('node:test');
const assert = require('node:assert');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function loadHistoryWithDb() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-bus-pulse-state-'));
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

test('bus_pulse_state schema has expected columns', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(bus_pulse_state)')
      .all()
      .map((c) => c.name);
    for (const name of [
      'route',
      'started_ts',
      'last_seen_ts',
      'consecutive_ticks',
      'clear_ticks',
      'posted_cooldown_key',
      'active_post_uri',
      'active_post_ts',
    ]) {
      assert.ok(cols.includes(name), `missing column: ${name}`);
    }
  } finally {
    cleanup();
  }
});

test('getBusPulseState returns null when row does not exist', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    assert.equal(history.getBusPulseState('66'), null);
  } finally {
    cleanup();
  }
});

test('upsertBusPulseState inserts then updates a row by route', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertBusPulseState({
      route: '66',
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
      activePostUri: null,
      activePostTs: null,
    });
    let row = history.getBusPulseState('66');
    assert.equal(row.route, '66');
    assert.equal(row.consecutive_ticks, 1);
    assert.equal(row.active_post_uri, null);

    history.upsertBusPulseState({
      route: '66',
      startedTs: now,
      lastSeenTs: now + 5_000,
      consecutiveTicks: 2,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
      activePostUri: 'at://post-1',
      activePostTs: now + 5_000,
    });
    row = history.getBusPulseState('66');
    assert.equal(row.consecutive_ticks, 2);
    assert.equal(row.active_post_uri, 'at://post-1');
    assert.equal(row.active_post_ts, now + 5_000);
  } finally {
    cleanup();
  }
});

test('clearBusPulseState removes the row', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertBusPulseState({
      route: '79',
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_79',
    });
    assert.ok(history.getBusPulseState('79'));
    history.clearBusPulseState('79');
    assert.equal(history.getBusPulseState('79'), null);
  } finally {
    cleanup();
  }
});

test('bus_pulse_state route is a string-typed primary key (numeric route coerces)', () => {
  const { history, cleanup } = loadHistoryWithDb();
  try {
    const now = Date.now();
    history.upsertBusPulseState({
      route: 66,
      startedTs: now,
      lastSeenTs: now,
      consecutiveTicks: 1,
      clearTicks: 0,
      postedCooldownKey: 'bus_pulse_66',
    });
    assert.ok(history.getBusPulseState('66'));
    assert.ok(history.getBusPulseState(66));
  } finally {
    cleanup();
  }
});
