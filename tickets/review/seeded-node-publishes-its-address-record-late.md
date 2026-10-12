description: A node added to a cadre by a seed (a rented provider node, or a machine added with `cadre enroll add`) took up to about seven and a half minutes to publish its own address record, so other members could not look up its address in that window. Every node now retries on its regular 15-second check, while connected, until its first publish lands.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-core/src/cadre-node.ts (publishFirstSelfRecord ~3277-3311, its call in reconcileControlCohort, publishSelfRecord ~3023-3100, NOTEs in scheduleSelfRegistration ~2960 and startRecordRefresh ~3355, lastSelfRecordPublishAt docstring ~938), packages/cadre-cli/src/commands/start-node.ts (claimConfigFor docstring), packages/integration-tests/src/scenarios/provider-drone-phone-requester.integration.ts, packages/integration-tests/src/scenarios/control-delete-while-alone-convergence.integration.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts (header), docs/architecture.md (Cadre Node item 4, Phone Adds Provider Drone, claim paragraph), docs/testing.md (provider bullet, new section "Stopping a node its own background writes are still running on"), tickets/blocked/forked-control-collection-sync-livelocks.md (new "Fifth trigger" section)
----
# A seeded node publishes its address record on its next connected reconcile pass

## What changed

**`CadreNode.publishFirstSelfRecord`** (was `publishSelfRecordOnceClaimed`) runs in every reconcile pass and calls `registerSelf()` until this session's first publish lands. It is no longer limited to nodes started with `config.claim`. It returns early when:

- `lastSelfRecordPublishAt !== null` — already published this session;
- `isAwaitingClaim()` — no row and no party yet;
- `removal !== null` — the node learned it was removed; nothing to publish;
- `getControlConnectionCount() === 0` — **not in the ticket; added during validation, see below.**

Log lines now read `reconcileControlCohort: first self-record publish: <outcome>`.

**`publishSelfRecord`** reads the node's `CadrePeer` row before collecting addresses, so a `skipped` publish (non-owner, row not here yet) costs one read and no `collectSelfAddrs`. The owner service is captured once (`ownerService`) and the insert branch narrows on it.

**Why connected-only.** Without it, `cadre-invite-any-member` failed 4 of 4 runs (`Timeout waiting for A lists P as an authorized member after syncing`; 27 of 27 green on record before). The test restarts owner A and runs a reconcile pass at once. The retry sits before the pass's dials, so A updated its own row while alone, forking the `CadrePeer` history, and never saw the device admitted while it was down. With the gate: 4 of 4 green, P listed about 1.56 s after reconnecting. The gate follows the reap and Revocation-marker steps in the same pass, and both reasons are in the docstring: a row written elsewhere arrives only over a connection, and an owner's write committed alone forks its history. The boot one-shot and the first-growth drain still cover the lone and first-connection moments, as before.

**Comments and docs.** Rewrote the NOTEs in `scheduleSelfRegistration` (a failed one-shot is retried on the next connected pass) and `startRecordRefresh` (why the reconcile pass is the trigger). Removed the `claimConfigFor` NOTE in `start-node.ts`, which no longer holds. Updated `node-claim-by-phone`'s header. `docs/architecture.md`: Cadre Node item 4 states the rule once, the claim paragraph links to it, and the Phone Adds Provider Drone bullet says the scenario now checks the drone's record. `docs/testing.md`: the provider bullet, plus a new short section on letting a node's own background writes land before stopping it.

## Tests

- **`provider-drone-phone-requester.integration.ts` step 5 (the reproduction):** `requester.resolvePeerAddrs(nodePeerId)` is non-empty with a `/ws` address within `OP_MS` (30 s). It failed on the unfixed core (`Timeout waiting for the node's signed record reaches the requester after 30000ms`) and passes with the fix. The debug log shows the publish coming from the reconcile pass about 10 s after the connection.
  - **Where the delay sits.** Step 4 waits for the node's `/status` uptime to reach 5 s past its value at `running` (recorded in step 2), **before `addDrone`**, not between `addDrone` and `applySeed` as the ticket suggested. With the wait after `addDrone`, the test passed on the unfixed core. The phone-shaped requester redials its retained target every 2 s, so it connected and replicated the node's row before the seed arrived. The seed then carries the node's own addresses, and merging them into the node's own peer store fires `self:peer:update`, which published the record. The constant's docstring explains this.
  - **Residual race.** If the requester's 2 s pass dials in the few milliseconds between `addDrone` and `applySeed`, the old core could still pass. The test passes on the fixed core either way.
- **`control-delete-while-alone-convergence.integration.ts`:** waits for B's first self-record publish (`registerSelf()` until not `skipped`) before the stops. Non-owner B's new background publish, made once its row replicates in, was being torn by the test's stop of A. The restarted A's `removePeer` then failed with the scenario's known `CoordinatorStaleLossError … stale conflict` fingerprint: 3 of 6 parallel runs, and 6 of 6 parallel with `DEBUG=sereus:cadre:node`. With the wait: 12 of 12 (6 parallel, 6 parallel with debug), plus 3 isolated.
- No new unit test. The ticket names the integration reproduction, and the stop conditions are one boolean guard. `control-founding-consult-budget.spec.ts` needed an edit while the gate was missing (its idle pass gained a self-publish) and is back to byte-identical with HEAD: a solo node now never reaches the publish.

## Validation

- `yarn lint`: clean. `@serfab/integration-tests` typecheck: clean.
- `@serfab/cadre-core` typecheck and unit tests: only the pre-existing failures (12 tests and 6 `TS2345` errors in `control-write-retry.spec.ts` and `strand-membership-reconciler.spec.ts`; see below).
- Integration, final build: all 71 files ran, in batches.
  - Green: the provider scenario, `node-claim-by-phone`, `cadre-invite-any-member`, every `bootPair` / `control-trio` / `topology` user (`control-cohort-edge-carries-data`, `control-cohort-three-node-isolation`, `control-db-two-node-convergence`, `control-divergent-repair-yardstick`, `control-write-while-alone-convergence`, `harness-topology`, the six `strand-*` users), and every other file, except the two below (three opt-in measurement files skipped by design).
  - `joiner-first-commit-over-slow-relay` takes close to 10 minutes on its own, so it ran in pieces: arms 1–3 green (arm 3 is the `it.fails` arm, 424 s here, about 4 minutes documented), arm 4 green twice (220 s and 152 s, about 85 s documented), arm 5 failed.
- Pre-existing failures, written to `tickets/.pre-existing-error.md` (none were in `.pre-existing-known.md`):
  1. The two cadre-core specs above construct `CoordinatorPartialCommitError` with an array. optimystic `963fec0a` changed that constructor to take a Map.
  2. `control-write-degraded-cohort-member`: 3 cases fail behind a ~137 s `revocation-ledger-open` background write. Reproduced identically on a core built from HEAD's `cadre-node.ts`. One run on the fixed build failed only "absorbs an injected transient stream reset" instead.
  3. `joiner-first-commit-over-slow-relay` arm 5 times out. The debug log shows zero `first self-record publish` lines in that arm.

## For the reviewer

- **New background write on non-owners.** A non-owner now makes its first `CadrePeer` UPDATE as soon as its row has replicated in and a pass runs (within 15 s of connecting, 2 s on phone-shaped test nodes), instead of at the 7.5-minute heartbeat. Scenarios that stop nodes within seconds of boot must let it land first; the new `docs/testing.md` section says so. Only `control-delete-while-alone-convergence` needed it in this suite.
- **Lone restarted owner.** With the gate, a lone restarted owner whose 1 s one-shot fails does not retry until it connects. That was the old behaviour too. The one-shot itself still writes alone when a restarted owner has not reconnected within 1 s; that is unchanged and recorded as the "Fifth trigger" in `tickets/blocked/forked-control-collection-sync-livelocks.md`, with both reproductions above.
- **Removed node that never saw its own row live.** Such a node does not learn it was removed, and pays one `CadrePeer` read on every connected pass. It is in the method's docstring.
- **Incidental trigger.** Applying a seed fires the node's `self:peer:update` republish, because the seed carries the node's own addresses. It is harmless and now written down in the provider scenario; it is not relied on.
- **Ticket's "normal parallel suite load".** The integration suite runs files sequentially (`fileParallelism: false`), so batches ran sequentially. Load was tested by 6-way parallel runs of `control-delete-while-alone-convergence`.
