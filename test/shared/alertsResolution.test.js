const test = require('node:test');
const assert = require('node:assert/strict');
const Path = require('node:path');
const Fs = require('node:fs');
const Os = require('node:os');

function freshDbPath() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'ctabot-alerts-'));
  return Path.join(dir, 'history.sqlite');
}

function loadHistoryWithDb(dbPath) {
  const stateDir = Path.dirname(dbPath);
  Fs.mkdirSync(stateDir, { recursive: true });
  const repoState = Path.join(__dirname, '..', '..', 'state');
  const real = Path.join(repoState, 'history.sqlite');
  const realWal = `${real}-wal`;
  const realShm = `${real}-shm`;
  const backup = Fs.existsSync(real) ? Fs.readFileSync(real) : null;
  const backupWal = Fs.existsSync(realWal) ? Fs.readFileSync(realWal) : null;
  const backupShm = Fs.existsSync(realShm) ? Fs.readFileSync(realShm) : null;
  if (Fs.existsSync(real)) Fs.unlinkSync(real);
  if (Fs.existsSync(realWal)) Fs.unlinkSync(realWal);
  if (Fs.existsSync(realShm)) Fs.unlinkSync(realShm);

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
      if (Fs.existsSync(real)) Fs.unlinkSync(real);
      if (Fs.existsSync(realWal)) Fs.unlinkSync(realWal);
      if (Fs.existsSync(realShm)) Fs.unlinkSync(realShm);
      if (backup) Fs.writeFileSync(real, backup);
      if (backupWal) Fs.writeFileSync(realWal, backupWal);
      if (backupShm) Fs.writeFileSync(realShm, backupShm);
    },
  };
}

test('clear_ticks column exists after init', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const cols = history
      .getDb()
      .prepare('PRAGMA table_info(alert_posts)')
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes('clear_ticks'));
  } finally {
    cleanup();
  }
});

test('incrementAlertClearTicks returns the new value', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    assert.equal(history.incrementAlertClearTicks('a1'), 1);
    assert.equal(history.incrementAlertClearTicks('a1'), 2);
  } finally {
    cleanup();
  }
});

test('resetAlertClearTicks zeroes the counter', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    history.incrementAlertClearTicks('a1');
    history.incrementAlertClearTicks('a1');
    history.resetAlertClearTicks('a1');
    const row = history.getAlertPost('a1');
    assert.equal(row.clear_ticks, 0);
  } finally {
    cleanup();
  }
});

test('recordAlertSeen on existing row refreshes headline and routes', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'old',
      postUri: null,
    });
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red,blue',
      headline: 'new',
      postUri: 'at://x/y/z',
    });
    const row = history.getAlertPost('a1');
    assert.equal(row.headline, 'new');
    assert.equal(row.routes, 'red,blue');
    assert.equal(row.post_uri, 'at://x/y/z');
  } finally {
    cleanup();
  }
});

test('recordAlertSeen claim then update preserves first_seen_ts and fills post_uri', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    const t0 = 1_700_000_000_000;
    history.recordAlertSeen(
      { alertId: 'a1', kind: 'train', routes: 'red', headline: 'h', postUri: null },
      t0,
    );
    let row = history.getAlertPost('a1');
    assert.equal(row.post_uri, null);
    assert.equal(row.first_seen_ts, t0);

    history.recordAlertSeen(
      { alertId: 'a1', kind: 'train', routes: 'red', headline: 'h', postUri: 'at://x/y/z' },
      t0 + 1000,
    );
    row = history.getAlertPost('a1');
    assert.equal(row.post_uri, 'at://x/y/z');
    assert.equal(row.first_seen_ts, t0);
    assert.equal(row.last_seen_ts, t0 + 1000);
  } finally {
    cleanup();
  }
});

test('listUnresolvedAlerts excludes resolved rows', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    history.recordAlertSeen({
      alertId: 'a2',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z2',
    });
    history.recordAlertResolved({ alertId: 'a2', replyUri: null });
    const rows = history.listUnresolvedAlerts('train');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].alert_id, 'a1');
  } finally {
    cleanup();
  }
});

test('two-tick resolution gating: increment then post when threshold met', () => {
  const { history, cleanup } = loadHistoryWithDb(freshDbPath());
  try {
    history.recordAlertSeen({
      alertId: 'a1',
      kind: 'train',
      routes: 'red',
      headline: 'h',
      postUri: 'at://x/y/z',
    });
    const first = history.incrementAlertClearTicks('a1');
    assert.ok(first < history.ALERT_CLEAR_TICKS, 'first miss should not be enough');
    const second = history.incrementAlertClearTicks('a1');
    assert.ok(second >= history.ALERT_CLEAR_TICKS, 'second miss should reach the threshold');
  } finally {
    cleanup();
  }
});
