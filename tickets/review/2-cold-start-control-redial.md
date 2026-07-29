---
description: A machine joining a group for the first time used to give up forever if its very first connection attempt was refused; it now keeps retrying until it gets in, and that behaviour has been tested end to end.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/control-stream-authorization.spec.ts, packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts, docs/architecture.md
difficulty: medium
---

# Review: cold-start bootstrap retry

## The bug this fixes

A node joining an existing party applies a **seed** — a signed bundle naming the party's
owner machines and their network addresses. Applying a seed dials those owners **exactly
once**, best-effort: if the dial throws, the failure is logged and swallowed, and the seed
still reports success.

Nothing ever dialed again. The periodic "control-cohort reconcile" pass — the thing that
keeps a node connected to its peers — enumerates its peers from the **replicated**
`CadrePeer` table. At cold start that table is empty, precisely because no connection was
ever established. So the pass returned at its "no siblings" check every time. Filling the
table needs a connection; getting a connection needed the table. A node whose one dial lost
the race was stranded **permanently** — a transient owner outage became a permanent
enrollment failure.

## What changed

**`packages/cadre-core/src/cadre-node.ts`** (the substance)

- New field `controlBootstrapPeers: Map<string, string[]>` — peerId → the multiaddr strings
  a seed listed for that peer. Holds only the **owner-flagged** peers of seeds this node
  accepted.
- `recordSeedBootstrapPeers(seed)` fills it, from **both** seed-intake paths: the
  `CadreNode.applySeed` wrapper (via `noteAppliedSeed`) and the inbound
  `/sereus/seed/1.0.0` protocol handler (via the `onSeedApplied` callback).
- `runReconcileControlCohort` no longer returns at `siblings.length === 0`. It calls
  `dialColdStartBootstrap()`, which skips already-connected peers and dials the rest
  best-effort, logging a distinct `cold-start pass complete (bootstrap=…, connected=…,
  dialed=…)` line.

**`packages/cadre-core/src/types.ts`** — `ApplySeedResult` gains two **required** fields,
`ownerDialsAttempted` and `ownerDialsFailed`. `success` keeps its old meaning ("the seed was
accepted"); the counters are what separate "seeded and connected" from "seeded and
stranded".

**`packages/cadre-core/src/seed-bootstrap.ts`** — the owner-dial loop counts
attempts/failures; a `seedRejected(error)` helper builds the pre-dial rejection results;
`SeedEventCallbacks.onSeedApplied` gained a third argument (the applied seed) so a node can
read a wire-delivered seed's contents.

**`packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`**
— new regression scenario (walkthrough below).

**`docs/architecture.md`** — new "Cold-start bootstrap retries" bullet in the Control
Network status list.

All of the above landed in commit `eb9376c`. This ticket's run added **no code changes** —
everything below is validation. `git diff` is empty against that commit.

## Two decisions to challenge

Both were made by the implementing run and are called out here because they are judgement
calls, not forced moves.

### 1. Bootstrap addresses come from a node-local map, not the libp2p peer store

The peer store already holds addresses `applySeed` wrote, and reading it would have avoided
a new field. It was rejected because the peer store accumulates **everything libp2p
discovers** — so "dial every entry" would drift over time into dialing arbitrary peers the
node happened to learn about. `controlBootstrapPeers` is exactly the set a
signature-checked, trust-anchored seed nominated, and nothing else. The rationale is written
into the field's doc comment.

Worth noting for the reviewer: the map is **in-memory only**. A node that applies a seed,
fails to connect, and then **restarts** loses its bootstrap targets and is stranded again.
The steady-state reconcile path has the same property (it re-reads from the replicated
table, which is also empty), so this is not a regression — but it is a real hole in the
"never give up" claim, and whether seed addresses should be persisted is a fair question to
raise.

Also note `isOwner` is the seed's own claim about its peers. That is sound for the same
reason `SeedBootstrapService.applySeed` already relies on it: the whole seed is
signature-checked against a trust anchor before this runs, and the flag only *selects a dial
target* — a dial grants no authority.

### 2. Retries are unbounded, with no backoff

The branch is gated by "the control database still has no siblings", so it stops the moment
the node is genuinely in the party, and a stranded node **must** keep trying — a give-up
rule turns a transient outage into a permanent one. Steady cost is one dial per bootstrap
peer per reconcile pass (seeds nominate one or a few owners), each failing fast against an
unreachable address.

A tripwire `NOTE:` sits on `dialColdStartBootstrap`: add per-peer backoff **if** seeds ever
carry many owner peers, or **if** the reconcile cadence drops well below its 15 s default.

## How the regression test forces the failure

`control-cohort-cold-start-retry.integration.ts`, no test doubles, using the production gate
that causes this in the field:

1. **A** starts as its own owner (storage profile, relay enabled) and self-registers a
   `CadrePeer` row with a dialable address.
2. **A vouches a decoy peer** — a real Ed25519 peer id that is never started, a pure row
   subject. This is load-bearing: `admitInboundControlConnection` admits *everyone* while A
   knows of no authorized member at all, so without the decoy A's gate would never refuse B.
3. **B** starts with `listenAddrs: []` (the client-only profile a phone/RN node uses) and a
   2 s reconcile cadence. Because B listens on nothing, **A cannot dial B** — any connection
   that later exists must be one B dialed.
4. **B applies A's seed while still unvouched.** The seed is accepted (signature + pinned
   owner key), but its one owner dial cannot survive A's gate.
5. The scenario **polls until B has zero connections to A**, rather than asserting on the
   dial's return value — A's deny lands *after* the dialer's upgrade completes, so `dial()`
   can resolve and the connection die moments later.
6. **A vouches B afterwards.** Nothing dials on B's behalf: B is unreachable, and B's one
   seed dial is spent.
7. **The regression assertion**: B must end up with a connection to A whose
   `direction === 'outbound'`. B's `CadrePeer` table is still empty, so the steady-state
   sibling path has nothing to enumerate — only the cold-start branch can produce this.
8. **Recovery is real, not just a socket**: A then vouches a third peer X (row-only, never
   started, never known to B locally) and B must observe the X row by pull-on-read.

## Validation actually run

Everything below was executed on this ticket; nothing is claimed on inspection alone.

| Check | Result |
| --- | --- |
| `yarn vitest run src/scenarios/control-cohort-cold-start-retry.integration.ts` (in `packages/integration-tests`) | **pass**, 3.9 s |
| Same scenario, repeated ×3 back-to-back | **3/3 pass**, 4.0 / 4.2 / 4.1 s |
| **Negative control** — cold-start dial removed, `cadre-core` rebuilt, scenario re-run | **fails exactly at step 7**: `Timeout waiting for B re-dials A from its retained seed addresses after 45000ms` (test 46.9 s). Change reverted; `git diff` empty; `cadre-core` rebuilt from the restored source. |
| `yarn workspace @serfab/cadre-core test` | **829 passed, 1 skipped** (59 files). The skip is `key-store.spec.ts:231`, an `it.skipIf(platform === 'win32')` POSIX-permissions test — pre-existing, unrelated. |
| Full integration suite (`packages/integration-tests`) | **29 files / 118 tests, all pass**, 225 s |
| `yarn lint` | **clean** |
| `yarn typecheck` (all workspaces) | **clean** |

Notes on the results:

- The negative control is the important one. Without it the scenario would be
  indistinguishable from libp2p's own connection-manager auto-dial reconnecting B; the 45 s
  timeout proves auto-dial does **not** recover this state and the new branch is what does.
- The two entries in `tickets/.pre-existing-known.md` (`bug-strand-three-party-replication`,
  `bug-control-db-stale-revision-not-retryable`) did **not** reproduce in the full-suite run.
  Both are recorded as intermittent / whole-file-run-dependent. Nothing new was written to
  `tickets/.pre-existing-error.md`.
- The `ApplySeedResult` field additions are **required**, so every construction site had to
  be updated. Only `seed-bootstrap.ts` constructs one; `reference-app-ns/src/cadre-phone.ts`
  and `reference-app-rn/src/cadre-phone.ts` merely pass the type through as a return
  annotation. The all-workspace typecheck covers this.

## Known gaps — treat the tests above as a floor

- **Timing margins are generous but untested under load.** B recovers in ~4 s against a 45 s
  wait, on a developer machine, with the scenario running alone and with `fileParallelism:
  false`. Nothing has been run on slow/contended CI.
- **`dialColdStartBootstrap` has no unit test.** Its behaviour is proven only through the
  end-to-end scenario. Specifically unproven in isolation: the already-connected skip, the
  `_running`/`controlNode` mid-loop shutdown re-guards, and the unparsable-address path.
- **The inbound `/sereus/seed/1.0.0` intake path is not covered end to end.** The
  `onSeedApplied` third argument is exercised only by
  `packages/cadre-core/test/control-stream-authorization.spec.ts:268`, which invokes the
  callback directly. No test delivers a seed over the wire and then asserts that its owner
  peers became cold-start dial targets.
- **`ownerDialsAttempted` / `ownerDialsFailed` are never asserted by any test.** They are
  currently log-and-diagnostic only. Note the documented caveat that zero failures is *not*
  proof of a live connection, because the receiver's membership gate denies after the
  dialer's upgrade completes — a reviewer should decide whether a field with that caveat is
  safe to expose as a public API surface.
- **Restart loses the bootstrap map** (see decision 1 above) — no test covers it because no
  code addresses it.
- **A seed carrying many owner peers is untested.** The scenario's seed nominates exactly
  one owner, so the unbounded-retry cost argument rests on that assumption holding in the
  field.

## Review findings

_(to be filled in by the review stage)_
