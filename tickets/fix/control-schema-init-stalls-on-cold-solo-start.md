description: Starting a cadre device for the first time usually takes about a second and a half, but every so often it randomly takes fifteen seconds to a minute instead, with nothing to show for the wait. On a busy machine this makes startup tests fail at random, and on a real phone it would look like the app had frozen on launch.
prereq:
files: packages/cadre-core/src/control-database.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/test/control-database-solo-warm-start.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-key-network.ts
difficulty: hard

# Cold `ControlDatabase.loadSchema()` intermittently stalls 15–62 s

## The failing test

From `packages/cadre-core`:

```
yarn vitest run
```

`test/control-database-solo-warm-start.spec.ts` — which case fails varies run to run, because
the stall lands on whichever `start()` happens to draw it:

```
FAIL  test/control-database-solo-warm-start.spec.ts > ... > start() then addStrand() with VANISHED prior-cohort peers on disk
FAIL  test/control-database-solo-warm-start.spec.ts > ... > start() then addStrand() with REVOKED prior-cohort peers on disk
Error: solo-warm-start control op first.start() timed out after 30000ms
 ❯ Timeout._onTimeout src/control-stream.ts:67:14
```

## Reproducing it

The spec alone is green, and so is the full suite on an idle machine (3/3 green here). The
failure needs the full 93-file suite *plus* extra CPU pressure:

```
# 12 background busy-loops on a 24-core box, then:
yarn vitest run
```

That reproduced it first try: 2 failed / 1502 passed, both failures `first.start() timed out
after 30000ms`.

## This is NOT a timeout that needs widening

The obvious reading — "15 s/30 s budgets tuned on an unloaded machine, suite contention blows
them" — is wrong, and it is worth stating because it is the conclusion the originating report
reached. Three measurements rule it out:

1. **Uniform slowdown does not do it.** Spec alone under 32 busy-loops ran 8× slower
   (239.8 s vs 30.4 s of test time) and **all 6 cases passed**. No budget breached.
2. **The stall is not shared with its neighbours.** With the budgets temporarily raised to
   240 s, under load, cases 1–2 took **225.8 s and 275.5 s and passed**, while cases 3–6 in the
   *same run* took **5.9 / 6.3 / 3.9 / 3.9 s** — faster than the isolated baseline. Contention
   cannot inflate one case 34× while its neighbours run at full speed.
3. **It happens with no load at all.** In an isolated, unloaded run, two of twelve cold
   `loadSchema` calls took **15.2 s and 19.3 s** against a 1.4–1.7 s norm. They stayed under
   the 30 s budget, so the run was green — but the defect was present.

Isolated per-case baseline is flat (6.6 / 7.7 / 6.6 / 7.2 / 4.0 / 4.6 s) — there is no warm-up
gradient to blame either. The distribution is **bimodal**, which is the signature of a
retry/deadline path being entered, not of resource contention.

## Where the time goes

`DEBUG='sereus:cadre:timing'` attributes it precisely. Every other step of `CadreNode.start()`
is fast even under full load:

| probe | observed |
|---|---|
| `[start] createControlNode` | 7–230 ms |
| `[controlDb] cryptoPlugin` / `optimysticPlugin` / `registerLibp2pNode` | 0–1 ms |
| `[controlDb] hydrate` | 1–8 ms cold, ~170 ms warm |
| `[controlDb] loadSchema` | **1.4–1.7 s normal cold, 15.2 / 19.3 / 25.8 / 62.3 s outliers** |
| `[start] total` | tracks `loadSchema` exactly |

The stall is entirely inside `loadSchema`, and only on a **cold** start — every outlier logged
`hydrate: …ms (tables=0, indexes=0)`. Warm starts (`tables=8`) load the schema in ~200 ms and
never stall. Worst single observation: `controlDatabase.initialize: 62252ms`.

Under full-suite load many workers cluster tightly around **~10.5 s**, which is suspiciously
close to a fixed deadline rather than a smooth distribution.

## Root-cause hypothesis

Cold `loadSchema` executes `CONTROL_SCHEMA`'s DDL as a **distributed write**: `initialize()`
routes the default vtab to optimystic with `transactor: 'network'`
(`control-database.ts:445-450`), so every `create table` goes through the cluster path even on a
node that is solo, has no listen address and has never had a peer. That write is wrapped in
`SCHEMA_INIT_RETRY_POLICY` (`control-database.ts:509-537`).

The numbers line up with that path's own documented costs:

- `CONTROL_WRITE_RETRY_BUDGET_MS = 10_000` — matches the ~10.5 s cluster.
- `SCHEMA_INIT_ATTEMPTS = 5`, delays `[250, 500, 1000, 2000]` — ~4.6 s of backoff on top.
- `control-write-retry.ts` notes a silent cohort member fails at ~20 s ("two 10 s `ClusterClient`
  response-deadline attempts") — matches the 15–25 s band.
- 62 s needs several such attempts stacked, each itself slowed by load.

So the leading hypothesis is that a solo, peerless node's schema DDL is intermittently taking a
coordinator-election / cluster-response path that costs a full deadline instead of committing
locally — and then retrying it. The same file documents the guard that is *supposed* to prevent
this: a node that has NEVER connected is "waved through as a bootstrap node (network high-water
mark of 1)", so this retry "only ever delays a node that HAS seen peers". These devices have
never connected, so either that wave-through is not firing reliably, or a different deadline is
being hit.

**The one measurement still missing** is whether the retry loop is entered at all. The
`sereus:cadre:control-db` namespace logs `Control write%s committed on attempt %d/%d`
(`control-write-retry.ts:429`) — capture that during an outlier and it settles it in one shot:

- attempt ≥ 2 ⇒ the defect is the retry policy / classifier in this repo → fix here.
- attempt 1/5, stalled internally ⇒ the defect is in optimystic's coordinator election or
  cluster response deadline → likely `blocked/`, upstream.

I could not capture it: the outlier is intermittent (0 hits in 3 clean runs, 2 hits in another),
and a concurrent agent working in `../quereus` kept invalidating the sibling build between
attempts. **Start here** rather than re-deriving the above.

## Suspect sites

- `packages/cadre-core/src/control-database.ts` — `initialize()` (~390), the default-vtab routing
  (445-450), `loadSchema()` (~473) and its retry rationale (509-537).
- `packages/cadre-core/src/control-write-retry.ts` — `SCHEMA_INIT_RETRY_POLICY`,
  `SCHEMA_INIT_ATTEMPTS`, `SCHEMA_INIT_RETRY_DELAYS_MS`, `CONTROL_WRITE_RETRY_BUDGET_MS`.
- `../optimystic/packages/db-p2p/src/libp2p-key-network.ts` — `findCoordinator` /
  `shouldAllowSelfCoordination` (3 attempts 500 ms apart; 30 s grace period that no caller in
  either repo configures).

## Design constraints

- **Do not widen the spec's budgets.** They are hang detectors, and §"This is NOT a timeout"
  shows the stall is real. Widening hides a 60 s app-launch freeze.
- **Do not make control DDL non-distributed as a shortcut.** The comment at
  `control-database.ts:438-444` is explicit: without optimystic-backed control tables the cadre
  never converges. A fast path for the provably-solo case must not change what a node that
  *does* have peers writes.
- **Keep the retry classifier fail-closed.** `control-write-retry.ts` deliberately never retries
  a decisive rejection or an indeterminate commit; a fix that widens matching must preserve both.
- **This is a real product defect, not just a test problem.** A phone app's first launch can
  currently block for up to a minute inside `start()`. Whatever the fix, the acceptance bar is
  cold `loadSchema` staying in its ~1.5 s norm, not merely fitting under 30 s.

## Cross-cutting obligations

- No determinism edition bump, byte-format vector, golden fixture, or migration is triggered by
  the diagnosis as it stands.
- If the fix changes *how or when* control schema DDL commits, re-check the embedded-schema
  drift specs against `schemas/control.qsql`, and
  `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`,
  which pins the retry classifier against a real transactor aggregate and is the tripwire for
  upstream error-format changes.
- If the cause turns out to be upstream in optimystic, this becomes a `blocked/` ticket naming
  that dependency — see the decision rule above.

## TODO

- [ ] Reproduce with `DEBUG='sereus:cadre:control-db,sereus:cadre:timing'` and capture the
      `committed on attempt N/M` line for a `loadSchema` outlier. Full suite + background CPU
      load is the reliable trigger; rebuild `../quereus` first so the stale-build guard passes.
- [ ] Decide in-repo vs upstream from that line.
- [ ] Fix so cold `loadSchema` on a solo, never-connected node commits without waiting on a
      cluster deadline.
- [ ] Add a regression assertion on cold `start()` duration, so the bimodal tail cannot come
      back green.
- [ ] Re-run the full `cadre-core` suite under background CPU load — that is the only
      configuration that reproduces the original red.
