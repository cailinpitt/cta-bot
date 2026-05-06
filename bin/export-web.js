#!/usr/bin/env node
// Exports historical alert data from the SQLite DB to JSON for the public web
// dashboard. Reads the DB in readonly mode — safe to run alongside cron jobs.
//
// Usage:
//   node bin/export-web.js [output-path]
//
// If output-path is omitted, JSON is written to stdout. The typical cron
// wrapper clones the GitHub Pages repo, runs this script pointing at
// data/alerts.json inside that clone, then commits + pushes only if the
// file changed.

require('../src/shared/env');

const Path = require('node:path');
const Fs = require('node:fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.HISTORY_DB_PATH || Path.join(__dirname, '..', 'state', 'history.sqlite');

// Convert an AT Protocol post URI to a bsky.app URL, or null if the URI is
// missing / malformed.
function atUriToUrl(uri) {
  if (!uri) return null;
  // at://did:plc:xxx/app.bsky.feed.post/rkey
  const parts = uri.split('/');
  if (parts.length < 5) return null;
  const did = parts[2];
  const rkey = parts[4];
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const alerts = db
    .prepare(
      `SELECT
        alert_id, kind, routes, headline,
        first_seen_ts, last_seen_ts, resolved_ts,
        post_uri, resolved_reply_uri,
        affected_from_station, affected_to_station, affected_direction
       FROM alert_posts
       ORDER BY first_seen_ts DESC`,
    )
    .all();

  // Bot-detected disruptions (pulse observations). Each 'observed' row is
  // paired with the earliest matching 'observed-clear' on the same
  // line/direction/from/to after it, if one exists.
  const observations = db
    .prepare(
      `SELECT
        d.id, d.kind, d.line, d.direction, d.from_station, d.to_station,
        d.ts, d.post_uri,
        (
          SELECT MIN(c.ts)
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear' AND c.posted = 1
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
        ) AS resolved_ts,
        (
          SELECT c.post_uri
          FROM disruption_events c
          WHERE c.kind = d.kind AND c.source = 'observed-clear' AND c.posted = 1
            AND c.ts >= d.ts
            AND IFNULL(c.line, '')          = IFNULL(d.line, '')
            AND IFNULL(c.direction, '')     = IFNULL(d.direction, '')
            AND IFNULL(c.from_station, '')  = IFNULL(d.from_station, '')
            AND IFNULL(c.to_station, '')    = IFNULL(d.to_station, '')
          ORDER BY c.ts ASC LIMIT 1
        ) AS resolved_post_uri
       FROM disruption_events d
       WHERE d.source = 'observed' AND d.posted = 1 AND d.post_uri IS NOT NULL
       ORDER BY d.ts DESC`,
    )
    .all();

  db.close();

  const out = {
    generated_at: Date.now(),
    alerts: alerts.map((row) => ({
      alert_id: row.alert_id,
      kind: row.kind,
      routes: row.routes ? row.routes.split(',').filter(Boolean) : [],
      headline: row.headline,
      first_seen_ts: row.first_seen_ts,
      last_seen_ts: row.last_seen_ts,
      resolved_ts: row.resolved_ts ?? null,
      duration_ms: row.resolved_ts != null ? row.resolved_ts - row.first_seen_ts : null,
      active: row.resolved_ts == null,
      post_url: atUriToUrl(row.post_uri),
      resolved_reply_url: atUriToUrl(row.resolved_reply_uri),
      affected_from_station: row.affected_from_station ?? null,
      affected_to_station: row.affected_to_station ?? null,
      affected_direction: row.affected_direction ?? null,
    })),
    observations: observations.map((row) => ({
      id: row.id,
      kind: row.kind,
      line: row.line,
      direction: row.direction ?? null,
      from_station: row.from_station ?? null,
      to_station: row.to_station ?? null,
      ts: row.ts,
      resolved_ts: row.resolved_ts ?? null,
      duration_ms: row.resolved_ts != null ? row.resolved_ts - row.ts : null,
      active: row.resolved_ts == null,
      post_url: atUriToUrl(row.post_uri),
      resolved_post_url: atUriToUrl(row.resolved_post_uri),
    })),
  };

  const outputPath = process.argv[2];

  if (outputPath) {
    // Only write if the data actually changed — generated_at updates every run
    // so we compare only alerts + observations to avoid spurious git commits.
    const dataOnly = JSON.stringify({ alerts: out.alerts, observations: out.observations });
    let existingDataOnly = null;
    if (Fs.existsSync(outputPath)) {
      try {
        const existing = JSON.parse(Fs.readFileSync(outputPath, 'utf8'));
        existingDataOnly = JSON.stringify({ alerts: existing.alerts, observations: existing.observations });
      } catch (_) {}
    }
    if (dataOnly === existingDataOnly) {
      console.error('export-web: no data changes, skipping write');
      return;
    }
    Fs.writeFileSync(outputPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.error(
      `export-web: wrote ${out.alerts.length} alerts, ${out.observations.length} observations to ${outputPath}`,
    );
  } else {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
}

main();
