description: Review the work that set out to prove a party's shared membership database syncs between two nodes — and that instead discovered the database is currently memory-only and never syncs, documenting the gap and the fix needed.
prereq:
files: packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (new — tripwire + skipped target), packages/integration-tests/src/harness/test-network.ts (new waitForCrossNodeControlSync + waitForCadrePeerConverged), docs/architecture.md (~167 "Convergence prerequisites and current status"), packages/cadre-core/src/control-database.ts (UNCHANGED — reverted; the root cause), tickets/fix/1-control-db-network-backed.md (spawned), tickets/implement/2-push-wake-replication-backed-authorization.md (prereq updated)
difficulty: medium
----

## TL;DR for the reviewer

The ticket asked for a test **proving** a `CadrePeer` row written on node A becomes readable on node B over the live control network. Building it surfaced that **the claim is false in the current wiring**: the `CadreControl` tables are backed by Quereus's in-memory vtab, not the Optimystic network transactor, so control data **never replicates** between nodes. The honest deliverable is therefore: the reusable harness helper, a **running tripwire** test that documents the gap (and fails loudly the day it's fixed), a **skipped target** test holding the proven positive recipe, a corrected docs note, and a spawned fix ticket (`control-db-network-backed`) for the substantial production change.

**No production code was shipped.** A spike fix to `control-database.ts` was written, proven to work, found to break 9 cadre-core tests, and **reverted** — `git diff packages/cadre-core/src/control-database.ts` is empty.

## What was built (all in `@serfab/integration-tests`, plus a docs note)

1. **Harness helper** — `waitForCrossNodeControlSync(readerDb, predicate, opts)` and the convenience `waitForCadrePeerConverged(readerDb, peerId, opts)` in `test-network.ts`. Broader scope than the existing `waitForControlSync` (which is pinned to one party's authority DB): these poll *any* node's `ControlDatabase`, the seam a real cross-node convergence assertion needs. Ready for the fixed future.
2. **`control-db-two-node-convergence.integration.ts`** — two tests:
   - **Tripwire (runs, passes today)**: boots A (authority, storage) + B (plain reader, transaction), forms a direct control-network connection (manual `dial()` over the public `getControlNode()` seam + both-sides wait — the same stand-in the strand scenarios use), A authority-writes a `CadrePeer` row for a third peer X, and asserts B does **NOT** observe X within 12s (and `B.isMember(X) === false`). The 12s window is comfortably longer than the ≈2s convergence the spike achieved, so when `control-db-network-backed` lands this test goes RED — the signal to delete it and un-skip the target.
   - **Target (`it.skip`)**: the proven positive assertion (connect → write X → `waitForCadrePeerConverged` → `B.isMember(X) === true`). Verified to pass (≈2.0s) in the spike. Un-skip + delete the tripwire when the control DB is network-backed.
3. **`docs/architecture.md`** — added a "Convergence prerequisites and current status" note next to the `CadrePeer` "replicated" language. It does not delete the design-intent claims but corrects the record: control tables are in-memory today, network-backing is required (and tracked), and that is distinct from cohort discovery.

## The discovery, with evidence (the heart of the review)

- **Root cause**: `ControlDatabase.initialize()` registers the optimystic plugin with `default_transactor: 'network'` but never calls `db.setDefaultVtabName('optimystic')` / `setDefaultVtabArgs(...)`. The `CadreControl` tables (no per-table `using optimystic`) fall back to the in-memory vtab. `connectToStrand` (the strand path) *does* set the default vtab + args + hydrate, which is why strands converge and control does not.
- **Proof**: `DEBUG=optimystic:*` on a control write → **0** optimystic lines; the analogous strand write → **thousands**. The strand single-writer replication baseline (`strand-formation-e2e` test 4) converges in **1.47s**; the unmodified control test times out at 30s.
- **Spike**: adding the missing default-vtab + hydrate wiring made the control pair converge in **≈2.0s** (and the local-only write healed via pull-on-read). **But** it broke 9 cadre-core consent tests with `CHECK constraint failed: Monotonic` — the network transactor's deferred-`CHECK` / `committed.*` snapshot / multi-statement-transaction semantics differ from the in-memory vtab that `redeemInvitation` / `FormationUsage.Monotonic` rely on. That makes network-backing a substantial change (likely touching `../optimystic` / `../quereus`), so it was reverted and handed off as `tickets/fix/1-control-db-network-backed.md`.

## Validation performed

- New test file: `yarn vitest run src/scenarios/control-db-two-node-convergence.integration.ts` → **1 passed, 1 skipped** (tripwire 13s).
- Revert integrity: `git diff packages/cadre-core/src/control-database.ts` → empty; the 3 previously-broken specs re-run green: `yarn workspace @serfab/cadre-core test --run test/control-formation-invite.spec.ts test/strand-formation-consent.spec.ts test/control-authorization-binding.spec.ts` → **43 passed**.
- `cd packages/integration-tests && yarn typecheck` → clean. `npx eslint` on the two changed files → clean. `yarn workspace @serfab/cadre-core build` → clean.
- Strand baseline (unchanged behaviour) still converges (1.47s).

## Known gaps / honest flags for the reviewer

- **The ticket's primary goal is NOT met** (and cannot be without `control-db-network-backed`): there is no passing test that *proves* control replication, because control replication does not exist yet. The skipped target is the proof-in-waiting.
- **The source ticket's premise was wrong** ("the design question is settled: YES the control DB replicates P2P"). The same wrong premise is repeated verbatim in `tickets/plan/control-network-cohort-discovery.md` (line 9) and underlies `2-push-wake-replication-backed-authorization`. A reviewer may want to annotate the cohort-discovery plan ticket similarly (left untouched here to avoid editing another stage's ticket beyond the one prereq update below).
- **Ticket #2 dependency**: `2-push-wake-replication-backed-authorization` cannot be replication-backed until network-backing lands; its `prereq:` was updated to add `control-db-network-backed`. Confirm that's the right sequencing.
- **Optimystic internal debug is silent** in this harness (`optimystic:*` yields nothing during a control run, but the same namespaces flood during a strand run) — so cross-node diagnosis relied on the strand-vs-control comparison and the spike, not on control-side optimystic logs. If the reviewer wants deeper logs they'll need to chase why control writes never reach the transactor (which is the whole point: they don't).
- **Tripwire cost**: the tripwire spends ~12s asserting non-convergence. Intentional (the window must exceed real convergence time to be a valid tripwire). If that's too slow for the suite, an `it.skip` on the tripwire is acceptable — but then the gap-closes signal is lost.

## Suggested reviewer actions

- Sanity-check the root-cause claim by diffing `ControlDatabase.initialize()` against `connectToStrand` (compose-strand.ts ~227-245) — the missing `setDefaultVtabName`/`setDefaultVtabArgs`/`hydrate` is the whole story.
- Decide whether the tripwire stays as a running test or becomes `it.skip` alongside the target.
- Confirm `control-db-network-backed` is scoped correctly (it is the real unblock for both cohort-discovery and push-wake #2).
