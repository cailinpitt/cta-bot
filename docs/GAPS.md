# Gap detection

How the bot finds long stretches of route with no vehicles in service — the rider experience of "the schedule says every 10 minutes, but I've been waiting 30."

> **Metra's analog of a gap is a delay.** Commuter rail runs a clockface timetable, not headways, so the rider-facing number isn't "X× the scheduled gap" — it's "my specific train is N minutes late." Metra binds each scheduled `trip_id` to a predicted arrival, so the bot computes `delay = predicted − scheduled` directly (Metra's feed delay field is always 0, so it's derived from predicted times). See `docs/METRA.md` (Phase 3 — delays); trains ≥ 15 min late surface in the hourly per-line rollup.

## What a "gap" means

The CTA publishes scheduled headways: how often vehicles should arrive on each route. A **gap** is when the actual distance between two consecutive vehicles is large enough — relative to that schedule — that riders in between are waiting much longer than promised.

Where bunching is "vehicles too close," gaps are the inverse: vehicles too far apart.

## The plain-English version

Every few minutes, the bot:

1. Pulls live positions of every bus/train.
2. Sorts vehicles by their position along the route.
3. For each pair of consecutive vehicles, estimates how long it would take a vehicle to cover the empty stretch. For buses this is **CTA's own scheduled run time** for that exact stretch (read off the trailing bus's GTFS trip curve); a flat typical-speed estimate is the fallback. Trains always use the flat estimate.
4. Compares that estimate to the scheduled headway.
5. If the gap is more than 2.5× scheduled — and at least 15 minutes for buses or 10 for trains — flags it.

A train post looks like this:

> 🕳️ Red Line — to Howard
>
> No trains between Lawrence and Bryn Mawr — a ~24 min gap, scheduled every 7 min
>
> Last seen: #711 · Next up: #718

The post **names the empty stretch as a range** between the two stations flanking it, rather than collapsing it onto a single midpoint stop — a long gap can span several stations, so "near Wilson" both under-states the hole and disagrees with the map. It also frames the number as a **gap between trains**, not "no train for ~24 min": the older phrasing read as "24 minutes since a train was here," but the span measures the distance between the two trains bracketing the stretch (at the midpoint, a rider has waited only about half that).

The map highlights the empty stretch, tags the two trains **L** (last seen, the one that just passed) and **N** (next up, the one riders are waiting on), and labels the same flanking stations the post names. The post spells the two roles out instead of `(last)`/`(next)` — "the last train" reads as the final train of the night, which is the opposite of what we mean.

On **bus** gaps, the two flanking buses also carry schedule adherence when we can compute it — often the gap itself is a late "next up" bus, so showing it makes the cause legible:

> Last seen: #1934 (on time) · Next up: #8021 (15 min late)

This reuses `scheduleDeviationMin` (see [BUNCHING.md](./BUNCHING.md#schedule-adherence--scheduledeviationmin-bus-only) for how the late/early minutes are derived from each bus's self-reported scheduled start). Either bus may be unplaceable, in which case it shows the bare id. Trains have no per-vehicle schedule anchor, so train gap posts stay id-only.

#### When adherence looks like it contradicts the gap

A wide gap with two near-on-time flanking buses isn't a contradiction or a bug. Schedule adherence (each bus vs *its own* trip) and the gap (empty road *between* two buses) measure different things. When both visible buses are close to schedule, they're just bookends running trips scheduled far apart — and the trips that should run *between* them (cancelled / short-turned / never dispatched) aren't on the street. Roughly, `gap ≈ (trailing.stst − leading.stst) − adherence diff` = the sum of the missing headways.

To keep that from reading as self-contradictory, the post appends a one-line explanation **only in that regime** — gap ≥ 2× the scheduled headway *and* the next-up bus within ~6 min of schedule (so a late bus genuinely can't account for the hole):

> Both buses here are near schedule — the gap is from trips missing between them.

When the next-up bus *is* the cause (e.g. 22 min late), the adherence line already explains the wait, so the note is suppressed. This is a deliberately factual line about what the data shows, not a verdict on the missing trips' cause — we don't assert "cancelled" or "ghost" since they could also be bunched or short-turned elsewhere.

## The technical version

### The core comparison

We don't have ride times for empty stretches — no vehicle is there to measure. Two ways to estimate them:

**Buses — CTA's scheduled run time.** The GTFS schedule (`schedule.sqlite`, also the substrate for schedule adherence) carries a position→time curve for every trip. We project the two flanking buses onto the *trailing* bus's own scheduled trip curve and difference the scheduled times — that's how long CTA's timetable says a bus takes to cover exactly that stretch (`scheduledTraverseMin` in `src/shared/gtfs.js`). When several trips share the `(route, start_sec)` anchor their traverse times are combined by median.

**Fallback — a flat typical speed** (used for trains always, and for buses when the schedule curve is unavailable or a bus lacks its `stst` anchor):

- Buses: **880 ft/min** (~10 mph, including stops and signals).
- Trains: **2,200 ft/min** (~25 mph cruise + dwell).

```
gapMin = scheduledTraverseMin(trailing → leading)   // or gapFt / TYPICAL_SPEED_FT_PER_MIN
ratio  = gapMin / expectedHeadwayMin
```

The schedule number is trusted only when it lands in a sane band around the flat estimate (up to 4× faster, up to 2× slower) — outside that is a misprojection and we keep the flat number.

**Why the schedule curve, not just the constant:** a flat 10 mph badly overstates gaps on routes that run long express segments on DuSable Lake Shore Drive (147, 6, 26, 146, X-express variants), which CTA schedules at highway speed. A real 6.8-mi hole on the 147 that riders wait ~25 min through was posting as "~50 min" — the constant applied to the whole stretch plus a prediction-refinement tail that also used the constant. The scheduled run time for that stretch is ~26 min.

The number is still approximate. It's used as a *ratio* against the scheduled headway, not as a literal ETA. A 2.5× ratio is the threshold: a gap that's two and a half times the schedule is worth posting.

`expectedHeadwayMin` is **per pattern**, not per direction. The GTFS index stores a headway for each origin→dest terminal pair, and the live vehicle's pattern is matched to the right group by its endpoint coordinates (`matchPattern` in `src/shared/gtfs.js`). This matters because a direction often runs several patterns at once — a through route plus owl short-turns or branches — and lumping them together corrupts the scheduled headway: the 66's overnight eastbound through service is every ~30 min, but mixing in the Austin→Pulaski owl short-turns made the old per-direction median read ~6 min, firing false gaps on a normal overnight wait. When a live pattern matches no indexed group, the lookup falls back to the direction-level headway (computed over every kept pattern's departures merged).

Each per-hour headway is the spacing a random rider actually faces — twice the mean wait to the next scheduled departure, integrated over the hour — not a median of trip-start gaps. A median under-reads a schedule that fires a burst of departures then goes quiet (7 buses in 20 min after a 25-min hole reads ~5 min; a rider mid-hole waits ~19).

### Buses — `src/bus/gaps.js`

For each pattern (`pid`), we already have `pdist` directly from the API, so:

1. Filter to fresh observations (< 3 min).
2. Sort by `pdist`.
3. For each adjacent pair: skip if either bus is inside the start/end terminal zone (a route-length-scaled buffer — buses there are doing layovers, not running headways).
4. Compute `gapMin` — CTA's scheduled run time for the stretch between the two buses (`scheduledTraverseMin`), falling back to `gapFt / 880` when there's no usable schedule curve or the schedule diverges wildly from the flat estimate — and `ratio`. Reject if `gapMin < 15` (absolute floor — protects 30-min-headway routes from spamming on a 31-min drift) or `ratio < 2.5`. `gapMinDist` (the flat estimate) and `schedBased` ride along for logging.
5. For each surviving gap, find the stops **flanking** it — the named stop just outside each bus (`flankBefore` behind the trailing bus, `flankAfter` ahead of the leading bus, with their lat/lon) — to name the stretch as a range ("between A and B") in the post and label both ends on the map. The post falls back to the single anchor stop ("near X") when a flank is missing.
6. Sort surviving gaps by `ratio` desc — biggest deviations first.

**Prediction refinement** (`bin/bus/gaps.js`): BusTime predictions cap at ~30 min, so a deep gap never has a direct prediction at the leading bus's stop. If BusTime reports the trailing bus running *later* than its position implies (it's stuck), the bin anchors on its farthest on-pattern predicted stop and adds the scheduled run time from there to the leading stop. It only ever **raises** `gapMin` — BusTime optimism shouldn't shrink a schedule-honest gap. (Before this was symmetric and used the flat constant for the tail, which is how a 40-min estimate became a posted "~50".)

Both gap maps share the same look: a warm-amber strip over the empty stretch and a pinned, named stop at each flank. They run on different renderers — the train map (`src/map/train/gaps.js`) reuses the bunching frame with Mapbox `pin-s` station pins; the bus map (`src/map/bus/gaps.js`) composites its own bus-stop sign markers — so the marker glyph differs by mode, but the strip color, the flank labeling, and the L/N vehicle chips match.

### Trains — `src/train/gaps.js`

Same idea, but track distance comes from snapping lat/lon onto a polyline (same projection as bunching and speedmap). After snapping:

1. Group by `(line, trDr)`, sort by track distance.
2. Look up the scheduled headway for that line + destination via the GTFS index.
3. Skip pairs in the terminal zone.
4. Apply the same ratio + floor gates (10-min floor for trains, since rail headways are tighter).
5. For each surviving gap, find the stations **flanking** it — the nearest stop just outside each train — to name the stretch as a range ("between A and B") in the post and on the map. A **midpoint** station is still computed as a fallback (used as "near X" when one flank is missing, e.g. a gap reaching toward a terminal) and as the timelapse's wait stop.

### Why a ratio, not a literal ETA

Gap times are still approximate. The flat-speed fallback in particular will be wrong in absolute terms — a real bus on Western at PM peak averages slower than 10 mph, and the same constant on a Lake Shore Drive express segment is 2–3× too slow. The schedule headway has the same kind of error baked in (also derived from a smooth model), so taking their ratio cancels much of it: a true 3× deviation looks like 3× regardless of the constant. Reading the bus traverse straight off CTA's timetable (`scheduledTraverseMin`) tightens the numerator further — it knows the express segment is scheduled fast — so the posted minutes track the real rider wait, not just the ratio.

This is why the post says "~24 min" with a tilde — it's deliberately approximate.

## Why this approach

The signal we want is "the schedule said one thing, reality is much worse" — and the only ground truth we have is the live spacing of in-service vehicles. By comparing a model-estimated gap to a model-derived headway and gating with a ratio, we catch big deviations without needing a perfect ETA.

The terminal-zone exclusion and the absolute-minute floor are the two filters that keep the false-positive rate low: gaps near terminals look big but mean nothing for riders mid-route, and one bus being 31 minutes apart on a 30-minute schedule isn't a story.

## Timelapse reply

After the still gap post goes out, the bot captures a ~10-minute timelapse and threads it as a reply — but framed around the rider's real question, *"is my train coming?"*, not the inter-vehicle span a bunching clip reports.

The clip **follows only the trailing ("Next up") vehicle approaching the wait stop** — which is the **gap midpoint**, not the leading-end stop the post names. The leading vehicle is dropped entirely: it already left, and on bad gaps it sits near a terminal, which would force the bbox miles wide and shrink the markers to specks. Anchoring at the midpoint also halves the distance the next vehicle must cover, so it's actually reachable in a 10-minute clip (a full 15+ min gap never is). By framing `[trailing vehicle path → midpoint stop]`, the camera holds still while the next vehicle advances across it, and the motion *is* the story.

**Wording leads with the full gap, not just the ETA, and names the midpoint stop.** Because the wait stop is the midpoint, the ticking ETA is only the time to cover the *remaining* (back) half — it drops the time the rider already waited since the last vehicle passed. So the HUD leads with the total gap and labels the ETA's destination, and the reply flags the stop as "the middle of the gap" so a reader understands why the train still has ground to cover:

- A live **HUD readout** top-left: `~24-min gap · next train ~5 min to Wilson` (the gap is fixed; the ETA ticks down). It tracks the train through the stop across three states keyed on the signed distance to the midpoint: `~N min to Wilson` while approaching → `reaching Wilson` within the arrival window → `has left Wilson` once it passes (clips sometimes run on past the midpoint). Naming the stop matches the amber label on the map.
- An **amber target ring + amber label** on the midpoint wait stop (same amber as the gap strip) so the eye lands on where the vehicle is heading.
- The trailing vehicle's **N** chip + comet trail, the direction arrow, and the clip clock.

The reply leads with the gap, then reports the concrete progress against the midpoint stop, tying in the "Next up" run number: *"~24 min Red Line gap. 4 minutes later, the next train (#718) had closed to within ~0.87 mi of Wilson — the middle of the gap."* — or, on arrival, *"The next train (#718) reached Wilson — the middle of the gap — 4 minutes later."*

**Deep gaps fall back to the still map** (no reply). Two guards enforce this: skip before capturing if the trailing vehicle's distance to the *midpoint* is too far to close in 10 minutes (>5 mi train / >3 mi bus — the readable-frame ceiling), and skip after capturing if it never meaningfully closed (<0.25 mi train / <0.125 mi bus) and didn't arrive. The worst gaps stay newsworthy as a still.

## Files

- `src/bus/gaps.js` — bus gap detection.
- `src/shared/gtfs.js` — `scheduledTraverseMin` (CTA-timetabled run time for the empty stretch) + `scheduleDeviationMin`, both off `schedule.sqlite`.
- `src/bus/gapPost.js` — bus post + timelapse reply text.
- `src/bus/gapVideo.js` — bus gap timelapse capture + clip assembly.
- `src/train/gaps.js` — train gap detection with along-track snapping and station labeling.
- `src/train/gapPost.js` — train post + timelapse reply text.
- `src/train/gapVideo.js` — train gap timelapse capture + clip assembly.
- `src/map/bus/gaps.js`, `src/map/train/gaps.js` — still gap maps + timelapse framing views.
- `src/shared/geo.js` — terminal zone helpers (`terminalZoneFt`).
- `bin/bus/gaps.js`, `bin/train/gaps.js` — cron entry points (`--video` dry-run flag renders the clip locally).

## Train gap cap

Train gaps cap at 2 posted events per **rush period** per line — AM (05–10), midday (10–15), PM (15–20), evening (20–05) — instead of per Chicago day. Each rush gets its own budget so two morning Red posts don't suppress an actual evening incident.

When the rush-period cap is hit, the post is bypassed if either correlated signal fires:

- A pulse on the same line within the last 30 min.
- A ghost-detector near-miss (recorded to `meta_signals`) within the last 90 min.

Otherwise the suppressed gap still gets a `meta_signals` row at severity proportional to its ratio, so `bin/incident-roundup.js` can incorporate it into the cross-detector roundup score.
