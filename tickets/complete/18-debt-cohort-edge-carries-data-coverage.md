----
description: Added and reviewed an integration test proving that when a device automatically opens a connection to another member of its party, real data actually travels over that new connection.
prereq:
files: packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts, packages/integration-tests/src/harness/control-trio.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/index.ts, docs/architecture.md, tickets/fix/control-read-over-fresh-edge-stream-resets.md, tickets/plan/10-integration-test-harness-helper-consolidation-remaining-files.md, tickets/.pre-existing-known.md
----

# Complete: control-cohort edge carries data

## What shipped

- `packages/integration-tests/src/scenarios/control-cohort-edge-carries-data.integration.ts`
  — one scenario (~360 lines, file header is the design doc) proving by ORDERING
  that a `CadrePeer` revision authored on C while B is provably isolated reaches
  B only across the B→C connection `CadreNode.reconcileControlCohort` formed:
  boot A/B/C (B listens on nothing) → baseline → sever B↔A (test connection
  gater + `hangUp`, both sides drained) → 16-checkpoint negative window → C
  authors R1 under a write pin to C → unpinned `B.reconcileControlCohort()`
  forms B→C → carry pin to C, B observes R1 while every open connection B holds
  is to C and the link-time connection id is still open → closing asserts (C
  seated in B's cohort, both pins consulted).
- Shared harness: `harness/control-trio.ts` (`bootControlTrio` /
  `stopControlTrio`, ported from the isolation scenario's private `bootTrio`,
  plus a `gaterB` option), `connectionsTo` / `hasOutboundTo` /
  `peerStoreAddrsFor` in `harness/node-fixtures.ts`, and `controlNodeConfig`
  options `pinnedOwnerKeys` + `connectionGater`.
- `docs/architecture.md` "The cohort auto-connects" bullet now records what the
  new scenario proves and where the older isolation scenario stops.

Isolation scenario untouched. Carriage is proven in the READ direction only;
the write direction is implied by cohort seating, documented in the header.

## Review findings

**Ran:** `yarn lint` (clean), `yarn typecheck` (clean), and the scenario six
times across the review. Result: 2 green (18.6 s pre-fix, 33.9 s post-fix), 3
failures on the already-tracked boot gate, 1 failure on a NEW third class found
here (below). No test was skipped, loosened, or disabled.

**Fixed inline (minor):**

1. **Negative-window read was not tolerant of an isolated node's own
   self-coordination block — a real flake the handoff believed resolved.** The
   window asserted `B.resolvePeerAddrs(cPeerId)` non-empty on all 16
   checkpoints. Optimystic's `Libp2pKeyPeerNetwork.shouldAllowSelfCoordination`
   refuses self-coordination for a node that has just lost the network
   (`partition-detected`, or `grace-period-not-elapsed` until 30 s —
   `selfCoordinationConfig.gracePeriodMs` — since its last connection), so that
   read throws `Self-coordination blocked: …` for the whole window on some runs.
   Reproduced once here; the implement handoff had called this the design's "one
   empirical unknown" and reported it resolved favorably on a single green run.
   The window now counts a self-coordination block as tolerated and still fails
   on any other error, on an empty successful read, and on every unconditional
   per-checkpoint claim (B's connection count, A's, B's empty peerStore for C).
   The ordering argument is unaffected: B knew C's address before the sever
   (asserted in the bracket) and dials C successfully in step 6, so "B had
   nothing to dial" is ruled out from both sides regardless.
2. **Two 60 s polls threw away their cause.** `waitUntil` logs a throwing
   condition and treats it as "not yet", so the R1-write poll and the
   reconcile-pass poll could burn a minute and report a bare timeout — the same
   unattributable-failure problem the implementer fixed for the carry loop only.
   Added a local `waitUntilOrExplain` that quotes the condition's last error and
   the `A=… B=… C=…` peer-id map into the timeout; the peer map is now built
   once and shared by all three failure paths.
3. **Docs were stale.** `docs/architecture.md` claimed the reconcile dial is the
   sole connector, citing the isolation scenario, with no mention that the same
   scenario cannot show the edge carries anything. Bullet updated to name the
   new scenario and what it adds. No other doc asserts anything this change
   contradicts (`docs/STATUS.md` does not enumerate either scenario).

**Filed as an arm on an existing ticket (major, site already claimed):** the
isolation scenario's private `bootTrio` is now duplicated by the shared
`harness/control-trio.ts` — two copies of the same ~150-line ordering proof,
which will drift. `tickets/plan/10-integration-test-harness-helper-consolidation-remaining-files.md`
already lists that file, so the arm was appended there rather than filed fresh;
it also records that two of that ticket's open "needs a decision" items
(`trustedOwners`, and now `connectionGater`) are settled by this work.

**Recorded as a tripwire, not a ticket:** the post-carry assert requires the
link-time connection id to still be open, which fails if libp2p ever recycles
the edge mid-carry even though carriage worked. No recycle observed; parked as a
`NOTE:` at the assert naming the weaker claim to fall back to.

**Checked, nothing found:**

- *Ordering argument.* Pin scoping is correct and load-bearing as documented —
  the write pin is restored in an inner `finally` before the reconcile pass, so
  the chicken-and-egg the header describes cannot occur, and the two pins never
  overlap (so `key-network-patch.ts`'s reverse-order-restore rule is satisfied
  on every failure path, including the outer `finally`'s idempotent re-restore).
- *Gater coverage.* `denyDialPeer` / `denyDialMultiaddr` (last p2p component) /
  `denyOutboundConnection` cover every outbound path; A cannot re-form the link
  from its side (B has no listen addresses — asserted). `createMembershipConnectionGater`
  spreads the base gater, so all three hooks survive composition — verified in
  `packages/cadre-core/src/membership-connection-gater.ts`.
- *Vacuity.* `expect(passes).toBeGreaterThan(0)` rules out an edge that already
  existed; both pins' `callCount()` rules out a silently no-opped patch (note
  the count covers the `findCoordinator` read seam — the write-steering
  `findCluster` reorder is uncounted, but a write that committed at all while B
  was unreachable is itself the evidence there).
- *Resource cleanup.* `stopControlTrio` stops newest-first and logs rather than
  throws, so one failed `stop()` cannot leak the other two nodes' listeners or
  mask the failure that sent the test into `finally`.
- *Source hygiene.* Scenario ~360 lines and harness 239 — both single-purpose,
  comments explain why rather than what. No duplicate export names across the
  harness barrel.

**Known failures NOT re-triaged** (both already in `tickets/.pre-existing-known.md`):
the boot gate "B resolves C's signed CadrePeer address record" →
`transactor-key-network-ignores-network-scoping` (blocked), and the carry-step
stream reset → `fix/control-read-over-fresh-edge-stream-resets`. The boot gate
ate 3 of 6 runs this session, matching its recorded rate.

**Not done:** the multi-run soak the handoff deferred still waits on optimystic
settling — it is recorded in the fix ticket, which owns the re-measurement.
