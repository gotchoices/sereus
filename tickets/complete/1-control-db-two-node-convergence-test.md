description: Reviewed the work that set out to prove a party's shared membership database syncs between two nodes — and that instead proved it currently does NOT (the database is memory-only), documenting the gap, adding a tripwire test, and spawning the production fix.
prereq:
files: packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (tripwire + skipped target; tripwire hardened in review), packages/integration-tests/src/harness/test-network.ts (waitForCrossNodeControlSync + waitForCadrePeerConverged), docs/architecture.md (~167 "Convergence prerequisites and current status"), packages/cadre-core/src/control-database.ts (UNCHANGED — the root cause), tickets/fix/1-control-db-network-backed.md (spawned), tickets/implement/2-push-wake-replication-backed-authorization.md (prereq updated), tickets/plan/control-network-cohort-discovery.md (prereq + premise corrected in review)
difficulty: medium
----

## Summary

The implement stage set out to write a test **proving** that a `CadrePeer` row written on node A becomes readable on node B over the live control network. Building it surfaced that the claim is **false in the current wiring**: the `CadreControl` tables fall back to Quereus's in-memory vtab (not the Optimystic network transactor), so control data never replicates between nodes. The honest deliverable was therefore a reusable harness helper, a **running tripwire** test documenting the gap (and designed to fail loudly the day it's fixed), a **skipped target** test holding the proven positive recipe, a corrected docs note, and a spawned fix ticket (`control-db-network-backed`). **No production code shipped** — a spike fix to `control-database.ts` was proven to work, found to break 9 cadre-core consent tests, and reverted.

This review verified the discovery, the test, the docs, the spawned ticket, and the revert integrity; hardened the tripwire; and corrected one downstream plan ticket that repeated the now-disproven premise.

## Review findings

### Verified correct (checked, no change needed)

- **Root-cause claim is accurate.** Confirmed `ControlDatabase.initialize()` (`control-database.ts:156-211`) registers the optimystic plugin with `default_transactor: 'network'` but never calls `setDefaultVtabName('optimystic')` / `setDefaultVtabArgs(...)` / `hydrate`, while `connectToStrand` (`compose-strand.ts:228-242`) does exactly that before applying its schema. No `using optimystic` appears on any control-schema table. The in-memory-fallback explanation holds.
- **Revert integrity.** `git diff packages/cadre-core/src/control-database.ts` is empty; the 3 named consent specs re-run green (`control-formation-invite`, `strand-formation-consent`, `control-authorization-binding` → **43 passed**).
- **API seams used by the test all exist** — `getControlNode`, `getControlDatabase`, `authorizePeer`, `isMember`, `initializeSeedBootstrap`, `insertAuthorityKey` (cadre-node.ts), `queryCadrePeers`, `insertAuthorityKey` (control-database.ts), `authorityKeyFromLibp2p` exported. Harness helpers are re-exported via `harness/index.ts` (`export * from './test-network.js'`).
- **Docs note** (`architecture.md` ~167) is honest, scoped, and does not delete the design-intent language — it adds a "current status" correction alongside it.
- **Type safety / lint / typecheck.** `yarn typecheck` clean; `eslint` clean on both changed files.

### Minor — fixed inline this pass

- **Tripwire masking risk (hardened).** `waitUntil` (`wait-utils.ts:45-48`) swallows predicate exceptions and waits to timeout, so the tripwire's `rejects.toThrow(/Timeout/)` would also "pass" if B's reader DB were *broken* (every poll throws) rather than merely non-converged — a false green. The final `isMember(X) === false` only partially guards this. Added a direct pre-assertion that B's read seam works and is simply empty of X (`queryCadrePeers().some(...) === false`) immediately before the timeout assertion, so the timeout is provably genuine non-convergence. Re-ran: tripwire still passes (12.6s), lint clean.
- **Downstream plan ticket repeated the disproven premise (corrected).** `tickets/plan/control-network-cohort-discovery.md` (line 9) called control convergence "settled" and assumed only cohort discovery was missing — the same wrong premise the implement work disproved. A future agent would have designed cohort discovery and still gotten zero convergence (in-memory tables). Added `control-db-network-backed` to its `prereq:` and a "Correction" note; this parallels the prereq update already applied to ticket #2 by the implementer.

### Major — filed as new ticket (not fixable in this pass)

- **The primary goal (a passing test that PROVES control replication) is not met and cannot be** until the control DB is network-backed — a substantial production change that must also reconcile the deferred-`CHECK` / `committed.*` snapshot / multi-statement-transaction semantics the consent path (`redeemInvitation`, `FormationUsage.Monotonic`) relies on. Correctly scoped and handed off as `tickets/fix/1-control-db-network-backed.md` (difficulty: hard). The skipped target test is the proof-in-waiting; un-skip it and delete the tripwire when that lands.

### Sequencing confirmed

- `control-db-network-backed` (fix/, seq 1) is a prereq of `2-push-wake-replication-backed-authorization` (implement/, seq 2 — `1 ≤ 2` ✓) and of `control-network-cohort-discovery` (plan/, unnumbered — a numbered prereq before an unnumbered dependent is valid). The runner's cross-stage gating enforces the order.

### Not done (deliberately, with reason)

- **No broader docs sweep.** `docs/cadre-consistency.md` describes the *intended* replication model (Quereus Sync layer), not a false "control tables replicate today" claim, so it needs no correction; `cadre-host.md` / `reference-app-rn.md` mention control data at the design level only. The `architecture.md` "current status" note is the correct surgical correction; widening it would be scope creep.
- **Tripwire kept as a running test (~12.6s asserting non-convergence).** Intentional: the window must exceed real convergence time (~2s in the spike) to be a valid tripwire. Acceptable for the suite; if it ever becomes a drag, `it.skip` it — but that loses the gap-closes signal.

## Validation performed

- `yarn vitest run src/scenarios/control-db-two-node-convergence.integration.ts` → **1 passed, 1 skipped** (tripwire 12.6s, after hardening).
- `yarn workspace @serfab/cadre-core test --run` on the 3 consent specs → **43 passed** (revert integrity).
- `yarn typecheck` (integration-tests) → clean. `eslint` on both changed files → clean.
