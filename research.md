# Ghost detection: code-flow audit and bug report

Scope: bus + train ghost detection (`bin/bus/ghosts.js`, `bin/train/ghosts.js`,
`src/bus/ghosts.js`, `src/train/ghosts.js`), the schedule inputs that drive
`expectedActive = duration / headway` (`scripts/fetch-gtfs.js`,
`src/shared/gtfs.js`), and the observation pipeline
(`src/shared/observations.js`, `src/bus/api.js`, `src/train/api.js`,
`src/bus/patterns.js`, `src/train/findStation.js`).

---

## 1. How the flow is supposed to work

### Observation pipeline
1. `scripts/observeGhosts.js` (cron) calls `getVehicles(ghostRoutes)` which
   calls the CTA BusTracker API in chunks of 10 and then
   `recordBusObservations(results)` writes every vehicle with the **same**
   `now = Date.now()` ts into `observations` (SQLite). Train equivalent:
   `getAllTrainPositions()` → `recordTrainObservations()`.
2. Each row stores `ts`, `kind`, `route` (or line), `direction` (bus: `pid`,
   train: `trDr`), `vehicle_id` (bus: `vid`, train: `rn`), `destination`.
3. `rolloffOldObservations()` deletes rows older than 3h.

### Detection
1. `bin/*/ghosts.js` runs hourly. `WINDOW_MS = 1h`. `sinceTs = now - 1h`.
2. Observations for the window are fetched per route/line.
3. Bus: observations are grouped by `pattern.direction` (the rider-facing
   label, e.g. "Northbound"). Train: grouped by `trDr`, except for loop lines
   (Brown/Orange/Pink/Purple/Yellow), which are aggregated line-wide.
4. For each group the code computes `expectedActive = duration / headway`
   (from the GTFS index) and `observedActive = median(distinct-vid count
   per snapshot)`. `missing = expectedActive − observedActive`.
5. Ghost fires if `missing ≥ 3` AND `missing / expectedActive ≥ 0.25` AND
   `perSnapshot.size ≥ 6`.

### Schedule (`scripts/fetch-gtfs.js` → `data/gtfs/index.json`)
1. Calendar filter keeps only `service_id`s whose `[start_date, end_date]`
   covers today and whose day-of-week bitmap matches one of
   weekday / saturday / sunday / weekend.
2. For each `(route, dir, dayType, hour)` the "dominant" service_id (most
   trips) wins; trips belonging to other service_ids that cover the same
   hour are dropped to handle overlapping seasonal duplicates vs. owl
   service.
3. Rail trips are further filtered to the single dominant *origin* per
   `(route, dir)` — discarding short-turns that share a `direction_id` with
   the full terminal-to-terminal run.
4. For each surviving trip, `hour = floor(first-departure / 3600) % 24`
   buckets produce `headways[dayType][hour] = median(consecutive
   first-departure gaps)` and
   `durations[dayType][hour] = median(last-arrival − first-departure)`.

### Runtime lookup (`src/shared/gtfs.js`)
- `hourlyLookup(byDayType, now)`: candidates are today + prior day, ordered
  by whether `hour < 4` (late-night prefers prior). Weekend aggregate is a
  fallback only when today/prior is sat/sun. **No nearest-hour interpolation**
  — missing hour → `null` → caller skips.
- Bus: pattern's last point is snapped to the closest indexed terminal to
  resolve `direction_id`.
- Train: destination lat/lon is snapped to the closest terminal among the
  (1 or 2) indexed directions.

---

## 2. Recent fix history (last week)

| Commit | Date | What it fixed |
|---|---|---|
| `273811a` | Apr 19 | Replaced nearest-hour fallback with prior-day lookup; moved service dominance per-hour so owl service isn't crushed by daytime. Fixed Route 82 at 1 AM reporting its 9-min daytime headway. |
| `775a151` | Apr 20 | Added calendar-date filter (was mashing together every seasonal duplicate regardless of effective date) and **removed** the per-hour dominant-origin filter for buses. Fixed Route 55 EB 2 AM collapsing to six trips → 1-minute headway. |
| `ea953a5` | Apr 21 | Re-introduced dominant-origin filter **for rail only**, so Blue Line short-turns from UIC-Halsted don't collapse the apparent headway. |
| `aa65f43` | Apr 21 | Appended a post-text disclaimer noting expected counts only reflect terminal-to-terminal runs. |
| `32e91b4` | Apr 18 | Loop-line aggregation across `trDr`s. |
| `00c79d4` | Apr 18 | Added routes 50 and 56 to ghosts list and bus emoji prefix. |

These fixes each closed a concrete false-positive case, but several
interactions between them (and a handful of issues untouched by any of them)
still produce bogus ghost calls. The remaining bugs are listed below in
rough order of how likely they are to explain "heavy ghosting reported today
on several bus routes."

---

## 3. Bugs found

### Bug A — Route 50 is polled but has no schedule; it can never produce an event, and if it ever did match, the math would be wrong

**Severity: low false-negative for Route 50; foot-gun for future additions.**

- `src/bus/routes.js` has `'50'` in `ghosts` (added in `00c79d4`).
- `scripts/fetch-gtfs.js:20` does
  `const { bunching: BUS_ROUTES } = require('../src/bus/routes')` — i.e.
  the GTFS indexer is driven by the `bunching` list, **not** the `ghosts`
  list. `bunching` does not include `'50'`.
- Verified: `data/gtfs/index.json` contains no entry under `routes['50']`.
  `busLookup('50', ...)` returns `null`, so `detectBusGhosts` silently skips
  the route.

The bigger risk: any time someone adds a route to `ghosts` (or `gaps`)
without also adding it to `bunching`, the same silent drop happens — and for
the gap detector it's more dangerous because `expectedHeadwayMin` returning
null causes the gap job to just say "no schedule." There is no guard for
`ghosts ⊄ bunching`. Fix: either index the union of all polled route lists,
or add an assertion in `fetch-gtfs.js`.

[cailin] this is a really good fine. we should use a union of ghosts and bunching to address this in my opinion. Do you think that is the best approach? I want buses in ghosts to work even if they aren't in bunching.

---

### Bug B — If pattern fetch fails for a pid, those observations are silently dropped while the expected count still counts the trips that served that pattern → **spurious ghost**

**Severity: high. Likely cause of today's false positives.**

In `src/bus/ghosts.js:53-59`:

```js
for (const o of obs) {
  const pattern = patternByPid.get(o.direction);
  if (!pattern) continue;                 // <— silent drop
  const label = pattern.direction;
  if (!label) continue;
  if (!byDir.has(label)) byDir.set(label, { obs: [], pattern });
  byDir.get(label).obs.push(o);
}
```

`patternByPid` is populated from `loadPattern(pid)`. `loadPattern` reads a
24h on-disk cache and otherwise calls CTA's `getpatterns`. Failure paths:

1. The CTA call throws — the outer `try/catch` in
   `src/bus/ghosts.js:40-46` logs `pattern fetch failed for pid …` and the
   pid gets no entry in `patternByPid`.
2. CTA returns a pattern with `direction == null` or an empty `rtdir` —
   `pattern.direction` is falsy, so `if (!label) continue` also silently
   drops.

In both cases **all observations for that pid are discarded from
`observedActive`**, but `expectedActive` was computed from GTFS trips
(route+dir), which includes the trips that served that pattern. Net effect:
observed is understated, missing is overstated, ghost fires.

This is plausibly what caused today's "several bus routes reported heavy
ghosting." A transient CTA getpatterns hiccup, or a newly-minted `pid` that
isn't yet in CTA's pattern service (new reroute picks up before getpatterns
catches up), will knock a sizable chunk off observed and trigger the alert.
The dry-run console log would show a realistic observed count but compared
to an overstated expected.

Suggested fix: if any pid in a route has no resolvable pattern, either skip
the route (safest) or count those observations into an "unknown direction"
bucket that is subtracted from expected before the ghost test. At minimum,
log-and-skip the *route* on pattern failure rather than dropping individual
observations.

[cailin] Good catch. For this, I would rather log and skip and stay on the safe side than reporting this.

---

### Bug C — Bus headway index is biased low for routes with mixed garage / terminal / short-turn origins, inflating `expectedActive` and firing ghosts

**Severity: medium-high. Likely contributor to "heavy ghosting".**

Commit `775a151` **removed** the per-hour dominant-origin filter for buses.
The justification was that for Route 55 EB at 2 AM, a too-aggressive filter
left only two trips and produced a 1-min median headway. The replacement
(calendar-date filter + per-hour service dominance) fixes the
seasonal-duplicate root cause — but the origin-mixing root cause is
still live for buses.

Concretely, many bus routes have trips starting at multiple origins for the
same `direction_id` — revenue trips from the rider-facing terminal, plus
garage pullouts from a depot stop in the middle of the route. In `fetch-gtfs.js:316-323`
the headway is

```js
const gaps = [];
for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i] - sorted[i - 1]) / 60);
const medMin = median(gaps);
```

When terminal and garage departures stagger (say a 10-min terminal cadence
interleaved with a 30-min garage pullout cadence), consecutive-difference
gaps look like `5, 5, 10, 5, 5, 10, …` and the median collapses to the
inter-leaved gap rather than the rider-facing headway. The corresponding
`durations` bucket meanwhile is the median trip duration, which is roughly
unchanged because garage pullouts are still full-length trips. Result:
`expectedActive = duration / headway` is **inflated**, sometimes by 50% or
more. On a route where real service is ~6 buses, the schedule says 10 → the
observed 6 looks like 4 missing (40%) → ghost posts.

`ea953a5` re-introduced the origin filter for rail but left buses unfixed;
the commit message explicitly scopes the rail fix. The right fix is the
rail approach applied to buses at the `(route, dir)` level (not per-hour,
to avoid the Route 55 2 AM regression) — keep only trips whose origin is
the dominant origin across the day, not per-hour.

This is probably the single most-impactful bug for recurring ghost false
positives during normal hours.

---

### Bug D — `observedActive = median` silently counts CTA API coverage gaps as "missing vehicles"

**Severity: medium. Chronic low-level inflator.**

`perSnapshot` is keyed by the exact `ts` of each `getVehicles` call. If the
CTA API drops a vehicle from a single poll (it happens — stale positions
expire, vehicles between blocks, etc.), that vehicle is absent from the
snapshot. With `MIN_SNAPSHOTS = 6` and 12-ish snapshots per hour, a handful
of coverage-gap snapshots pull the median down.

Separately, different crons writing observations nearly simultaneously
produce **different ts values** because each cron calls `Date.now()`
independently. Route vehicles fetched by `observeGhosts.js` at
`t=00:00:00.150` and by `bunching.js` at `t=00:00:00.310` create two
distinct `perSnapshot` entries for what is effectively one sampling moment.
This isn't a bug per se — more snapshots is good for MIN_SNAPSHOTS — but
any vehicle that was present in one call and absent from the other now
contributes two rows with different vid-sets, splitting information that
should have been one snapshot. Small bias downward on median.

---

### Bug E — `hourlyLookup`'s prior-day rule is applied unconditionally, even when there is no DST / late-night reason to consult the prior day

**Severity: low–medium. Can surface weird expected values on weekend
morning transitions.**

`src/shared/gtfs.js:50-64`:

```js
const candidates = hour < LATE_NIGHT_CUTOFF_HOUR ? [priorDt, todayDt] : [todayDt, priorDt];
```

After 4 AM: if today's dayType has no value at this hour, we fall back to
**yesterday's** dayType. On a Monday at 5 AM, that means if the weekday
index has no entry at hour 5 but Sunday does, we use Sunday's headway. A
route with truly no 5 AM service on Monday but a 5 AM owl slot on Sunday
will silently pick up the Sunday number. This is the nearest-hour fallback
in disguise — it just fell back on dayType instead of hour.

In practice it mostly hides corner cases rather than invents false
positives, but it can inflate `expectedActive` early Monday morning if
Sunday's overnight span differs from weekday's.

---

### Bug F — `calendar_dates.txt` is never consulted, so holiday service isn't recognized

**Severity: medium, ~1 day/month.**

`scripts/fetch-gtfs.js` reads only `calendar.txt`. GTFS's canonical rule is
`active(service_id, date) = calendar.day-of-week ⊕ calendar_dates.exception`.
On holidays (New Year's Day, July 4, Thanksgiving, Christmas, etc.) CTA
enumerates a holiday service_id via `calendar_dates.txt` that *adds* for
that date and *removes* the regular weekday service. Today (April 22 —
Wednesday) this doesn't matter, but on any holiday the bot is comparing
observed positions against the *regular* schedule → mass ghost posts. Grep
confirms no reference to `calendar_dates.txt` anywhere in the repo.

---

### Bug G — Bus `resolveDirection` may classify a short-turn pattern to the wrong `direction_id`

**Severity: medium for routes with mid-route terminals (X9 at 63rd, 55 at
Midway, 8 at Clybourn/79th, etc.).**

`src/shared/gtfs.js:73-96` picks the pattern's `direction_id` by nearest
GTFS terminal to the pattern's last point. If the pattern ends at a mid-
route stop (a common occurrence: garages, intermediate termini, reroutes),
the pattern's last point is between the two GTFS terminals and goes to
whichever is closer — which may not match the pattern's actual operational
direction. Vehicles on that pattern get looked up against the wrong
direction's `headway`/`duration`, and `expectedActive` may not match
`observedActive` for that pattern. Since direction labels are typically
still correct from CTA's `rtdir`, the grouping stays correct, but the
headway/duration for the grouping is pulled from the wrong
`direction_id` bucket.

Fix: resolve direction using the pattern's *first* point (origin terminal)
rather than last, or compare both and pick the direction that minimizes the
origin+terminal distance jointly.

---

### Bug H — Train ghost detection uses an arbitrary destination as a direction proxy, which picks the wrong headway for runs that ran as short-turns during the window

**Severity: low–medium.**

`src/train/ghosts.js:87`:

```js
const sampleDest = group.find((o) => o.destination)?.destination;
```

`group.find` returns the **first** observation's destination. If the first
observation happens to be a short-turn (e.g., "UIC-Halsted" rather than
"Forest Park" on Blue), `findStationByDestination` returns the mid-line
station, `pickTrainDirInfo` snaps to whichever terminal is closest to that
mid-line point, and `expectedHeadway`/`expectedDuration` come from a
direction bucket that was already origin-filtered to the full run (fine)
but the value being read might be from the other direction than intended
when the mid-line station is roughly equidistant.

The intent looks like "any destination on this `trDr` resolves to the same
terminal-direction" which is true when destinations are all real terminals,
but fails when they're a mix of short-turn and full-run destinations. A
more defensive version would pick the destination whose lat/lon is **farthest**
from the line's midpoint, which biases toward true terminals.

---

### Bug I — `findStationByDestination` uses loose `startsWith`/`includes` matching; can cross-match

**Severity: low.**

`src/train/findStation.js:15`:

```js
if (baseName === norm || baseName.startsWith(norm) || norm.startsWith(baseName)) return s;
```

`startsWith`/`includes` both-ways means "Loop" would match any station whose
name starts with "Loop," and any station whose base name is short would
match a long destination that happens to start with it. In practice most
CTA station names aren't prefixes of each other, but e.g. "Midway" vs.
"Midway Transfer" could trip this. Tighter matching (exact after stripping
parenthetical) plus a known-aliases map would be safer.

---

### Bug J — Post formatter divides by `observedActive`; if observed is small (e.g., 1) the reported "effective headway" becomes absurdly large

**Severity: low — display only, but misleading to readers.**

`bin/bus/ghosts.js:32` and `bin/train/ghosts.js:25`:

```js
const effectiveHeadway = Math.round(event.headway * (event.expectedActive / event.observedActive));
```

For events where observed is 1 (they're allowed — `perSnapshot.size ≥ 6` is
the only floor, not vid-count), the post will say "every ~X min" where X
is many multiples of the scheduled headway. This is technically the
algebraic definition, but riders reading the post see "every ~62 min
instead of ~9" and distrust the bot. Worth clamping or reformatting when
observed ≤ 1.

Secondary concern: `observedActive` is a median of integers, so it's often
an integer. When it isn't (half-integer from an even snapshot count),
`Math.round(expected/observed)` and `Math.round(expected)` can disagree
even when the ratio is close to 1.

---

### Bug K — No lower bound on `snapshots` meaningfulness when cron is misfired

**Severity: low, rare.**

`MIN_SNAPSHOTS = 6`. If the ghost-observer cron is briefly broken for most
of the hour and the bunching cron happens to have run 6× instead, the
ghost job still fires on whatever was incidentally recorded. Observed data
from the bunching path doesn't cover all ghost routes, so this can yield
highly biased observed counts for the unobserved subset. A sanity check on
"number of distinct bus vids seen total" vs. `expectedActive * snapshots`
(or even a cadence check on `ts` spacing) would catch this.

---

### Bug L — Train loop-line duration is full round trip, but `observedActive` can undercount when the same physical train cycles through the Loop in one window

**Severity: low (loop lines).**

For loop lines (Brown, etc.), one physical run is Kimball → Loop → Kimball.
The `rn` (run number) stays the same throughout, so `distinct rn per
snapshot` counts that train once — correct. But when a train *ends* its
run in the middle of the window and the next run gets a *new* `rn`, they
don't overlap in a single snapshot, so they don't inflate the count.
That's also fine.

The concern is the opposite: `duration` comes from GTFS's full round-trip
time, but CTA's live feed drops trains when they layover at the terminal
(usually a few minutes). That layover time *is* part of the GTFS duration
but *isn't* part of the live-feed active set, so `observedActive` is
slightly lower than the mathematical ceiling of `duration/headway`.
Currently papered over by the 25% + 3-absolute threshold, but the
disclaimer added in `aa65f43` hints at this exact mismatch. A small
layover-correction (`duration_adjusted = duration − mean_layover`) would
tighten the gate.

---

### Bug M — Rail origin dominance is computed route-wide, not per-dayType/hour, so a weekend-only short-turn pattern can still leak in if it's the dominant *origin* for that route+dir

**Severity: low.**

`scripts/fetch-gtfs.js:243-261` computes `railDominantOrigin` as a
`(route, dir)` map using trip counts across all `dayType`s and hours. This
is almost always correct (Forest Park and O'Hare dominate by a wide margin
for Blue), but in principle a small-hours-only short-turn origin with
enough trips could edge out the weekday-daytime terminal if the weekday
terminal trips are under-represented for any reason (service reductions,
construction). It also means: when CTA reroutes Blue Line west of UIC
during construction and the rider-facing "terminal" temporarily becomes
UIC-Halsted, the index still locks to the pre-construction terminal and
filters out all live-schedule trips. **The indexer would need re-running
after any major reroute.** Worth a guard that logs dominant-origin counts
so drift is visible.

---

## 4. Recommended order of fixes

Ranked by likelihood of explaining "several bus routes reporting heavy
ghosting today":

1. **Bug B** (pattern-fetch failure silently drops observations): fix first.
   Fail-closed on any pattern resolution failure (skip the route), or account
   for unresolved observations in `expectedActive`. A single flaky getpatterns
   call can ghost an entire route.
2. **Bug C** (multi-origin bus headway bias): re-introduce an origin filter
   for buses at the `(route, dir)` level (not per-hour, to avoid the Route 55
   2 AM regression that motivated `775a151`). Route 55 EB stays healthy
   because the filter wouldn't kick in at the day level unless one origin is
   clearly dominant.
3. **Bug A** (route 50 silently unindexed): either guard against
   `ghosts ⊄ bunching` at start-up or index the union in `fetch-gtfs.js`.
4. **Bug F** (no `calendar_dates.txt`): add holiday service recognition.
5. **Bug G** (pattern direction resolution on short-turns): compare both
   endpoints, not just the last.
6. **Bug J** (effective-headway display): clamp or reformat for low
   observed counts.
7. Bugs D / E / H / I / K / L / M: lower-priority polish.

## 5. What I did NOT find

- No off-by-one in the `missing ≥ 3 && pct ≥ 25%` gate — the arithmetic is
  correct and tested.
- No double-counting of observations between `observeGhosts.js` and other
  crons: writes insert separate rows with different `ts` each call; each
  call is one independent snapshot. Median behaves correctly.
- No TZ bug in `parseBusTime` or `chicagoHour` — both anchor to
  America/Chicago via `Intl.DateTimeFormat` regardless of host TZ (fixed in
  `55cded4`).
- The loop-line aggregation (`32e91b4`) and the per-hour service dominance
  (`273811a`) are both sound in the code as it stands.

## Notes from Cailin
* The bots run on a seperate machine, cailin@cailin-server: /home/cailin/Development/cta-bot
* The fetch gtfs script likely hasn't been run on this machine for a bit so the data is out of date, most likely

Below are the crontab entries for all the bots. I commented out the ghosting scripts because of the bugs:

```
# === CTA bot bus bunching (every 10 min) ===
*/10 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) ===\n" >> cron/bus-bunching-cron.log && /usr/bin/node bin/bus/bunching.js >> cron/bus-bunching-cron.log 2>&1

# === CTA bot bus speedmap (every 2h) ===
0 */2 * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) speedmap ===\n" >> cron/bus-speedmap-cron.log && /usr/bin/node bin/bus/speedmap.js >> cron/bus-speedmap-cron.log 2>&1

# === CTA bot train bunching (every 10 min) ===
*/10 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) train-bunching ===\n" >> cron/train-bunching-cron.log && /usr/bin/node bin/train/bunching.js >> cron/train-bunching-cron.log 2>&1

# === CTA bot L system snapshot (4x daily) ===
0 7,12,17,21 * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) snapshot ===\n" >> cron/train-snapshot-cron.log && /usr/bin/node bin/train/snapshot.js >> cron/train-snapshot-cron.log 2>&1

# === CTA bot train speedmap (every 2h) ===
0 */2 * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) train-speedmap ===\n" >> cron/train-speedmap-cron.log && /usr/bin/node bin/train/speedmap.js >> cron/train-speedmap-cron.log 2>&1

# === CTA bot bus gaps (every 10 min) ===                                                                                                   
5-59/10 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) gaps ===\n" >> cron/bus-gaps-cron.log && /usr/bin/node bin/bus/gaps.js >> cron/bus-gaps-cron.log 2>&1
   
# === CTA bot GTFS refresh (weekly, Sun 4am) ===                                                                                            
0 4 * * 0 cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) fetch-gtfs ===\n" >> cron/fetch-gtfs-cron.log && /usr/bin/node scripts/fetch-gtfs.js >> cron/fetch-gtfs-cron.log 2>&1

# === CTA bot train gaps (every 10 min) ===
5-59/10 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) train-gaps ===\n" >> cron/train-gaps-cron.log && /usr/bin/node bin/train/gaps.js >> cron/train-gaps-cron.log 2>&1

# === CTA bot traffic signals refresh (monthly, 1st at 4am) ===
0 4 1 * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) fetch-signals ===\n" >> cron/fetch-signals-cron.log && /usr/bin/node scripts/fetch-signals.js >> cron/fetch-signals-cron.log 2>&1

# === CTA bot ghost observer (every 5 min) ===
*/5 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) observe-ghosts ===\n" >> cron/observe-ghosts-cron.log && /usr/bin/node scripts/observeGhosts.js >> cron/observe-ghosts-cron.log 2>&1

# === CTA bot bus ghosts (hourly) ===
# 7 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) ghosts ===\n" >> cron/bus-ghosts-cron.log && /usr/bin/node bin/bus/ghosts.js >> cron/bus-ghosts-cron.log 2>&1

# === CTA bot train ghosts (hourly) ===
# 8 * * * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) train-ghosts ===\n" >> cron/train-ghosts-cron.log && /usr/bin/node bin/train/ghosts.js >> cron/train-ghosts-cron.log 2>&1

# === CTA bot heatmap weekly (Sun 10:20 bus, 10:25 train) ===
20 10 * * 0 cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) heatmap-bus-week ===\n" >> cron/bus-heatmap-cron.log && /usr/bin/node bin/bus/heatmap.js --window=week >> cron/bus-heatmap-cron.log 2>&1
25 10 * * 0 cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) heatmap-train-week ===\n" >> cron/train-heatmap-cron.log && /usr/bin/node bin/train/heatmap.js --window=week >> cron/train-heatmap-cron.log 2>&1

# === CTA bot heatmap monthly (1st at 10:30 bus, 10:35 train) ===
30 10 1 * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) heatmap-bus-month ===\n" >> cron/bus-heatmap-cron.log && /usr/bin/node bin/bus/heatmap.js --window=month >> cron/bus-heatmap-cron.log 2>&1
35 10 1 * * cd /home/cailin/Development/cta-bot && printf "\n\n=== $(date) heatmap-train-month ===\n" >> cron/train-heatmap-cron.log && /usr/bin/node bin/train/heatmap.js --window=month >> cron/train-heatmap-cron.log 2>&1
```

* This is the bus ghost post made today that really concerned me about data quality, at 7:07 AM: `🚌 Route 147 (Outer DuSable Lake Shore Exp.) SB · 20 of 27 missing (74%) · every ~8 min instead of ~2
🚌 Route 77 (Belmont) EB · 17 of 27 missing (63%) · every ~7 min instead of ~3
🚌 Route 79 (79th) EB · 14 of 26 missing (54%) · every ~4 min instead of ~2
…and 17 more routes`