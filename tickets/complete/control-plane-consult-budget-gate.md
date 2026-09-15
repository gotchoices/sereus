description: The test suite now counts how often the control database asks the other machines about its data, and how many commits it makes, while a solo party is founded and then sits idle, so a change that doubles that network work fails a test instead of passing unnoticed.
files:
  - packages/cadre-core/test/cohort-consult-counter.ts (the counter)
  - packages/cadre-core/test/cohort-consult-counter.spec.ts (the counter's own unit spec, added in review)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (the budget spec)
  - packages/cadre-core/test/signed-sapp.ts (shared signed-sApp helper, added in review; replaces seven local copies)
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts (Companions paragraph)
  - docs/testing.md ("Where measurements live"), docs/architecture.md (solo strand paragraph)
  - ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`get` → `fetchBlockFromCluster`, `commit`: what is counted)
----
# Consult and commit budget over party founding and the hot membership reads

## What was built

A "consult" is one call of Optimystic's `CoordinatorRepo.fetchBlockFromCluster`: the coordinator asking a block's cohort (the machines responsible for it) for the latest revision. It happens on every read of a block the node does not hold, and on a held block at most once per 10 s read-repair window. On a solo node it is a local lookup; on a multi-machine party it is a round trip to every other member. Nothing below the storage cache sees it, so the two raw-storage budget specs could not catch a change that doubled it.

- **`cohort-consult-counter.ts`** wraps `fetchBlockFromCluster` and `commit` on `CoordinatorRepo.prototype`, tallying per repo instance and per block id. It throws at install if either method is gone upstream, and refuses an out-of-order restore. Repos are attributed by labelling every unlabelled repo at the end of the phase that created it.
- **`control-founding-consult-budget.spec.ts`** stands up one solo `CadreNode` and measures cold `start()`, genesis, `foundStrand` (control and strand repos separately), six back-to-back calls each of `queryRevokedStamps('CadrePeer')` and `queryCadrePeers()`, and one idle `reconcileControlCohort()`. Phase budgets are two-sided (a ceiling, plus a floor at half the measurement). Per-call reads are pinned exactly. Background work that `start()` leaves running is disarmed or awaited, not budgeted around. The measured figures and their provenance live in the spec's doc comments (dated 2026-09-15): cold 30/18 blocks/2 commits, genesis 14/3/4, founding 25+25 consults and 6+6 commits, `queryRevokedStamps` 2 per call, `queryCadrePeers` 4 per call, idle reconcile 8.

## Review findings

**Read first:** the implement diff (`a3d76c4`), then the upstream methods it patches, the `CadreNode`/`StrandWatcher` private members `settleStart` reaches, the vitest config, every doc that names the budget specs, and the downstream ticket `revocation-ledger-marker`, which plans to use the counter.

### Correctness — checked, nothing wrong
- The prototype patch really is on the path: `CoordinatorRepo.get` calls `this.fetchBlockFromCluster(...)` (coordinator-repo.ts:839), and both methods are ordinary prototype methods, so wrapping the prototype catches every instance.
- `settleStart`'s assumptions hold against `cadre-node.ts`. `_running` is set before `void this.refreshMembershipGate('start')`, which fills `membershipGateDrain` synchronously. `scheduleSelfRegistration()` runs before `start()` returns. The watcher's `initialPollTimer` nulls itself when it fires, which is what the fallback branch keys on. Disarming the self-registration timer also keeps the reconcile interval and heartbeat unarmed, because `startRecordRefresh` is only called from inside that timer.
- The claim "vitest runs each spec file in its own worker, so the patch cannot leak across files" holds: `vitest.config.ts` does not turn isolation off.
- Re-ran the spec: identical counts to the handoff, first poll `run-by-spec`.

### Tests
- **Fixed — the counter had no spec of its own.** Added `cohort-consult-counter.spec.ts` (7 tests, no node). It stubs both prototype methods and covers: delegation with the same receiver, arguments and result; per-block counting and the busiest-first/id tie-break ordering; label narrowing, labels surviving `reset`, and only unlabelled repos being picked up; restore reinstating the methods, a second restore doing nothing, refusing to restore while a later patch sits on top (and succeeding once it is gone); and install refusing, without patching anything, when either method is missing.
- **Checked — full-suite parallel load**, which the handoff had not observed: full `packages/cadre-core` run, 126 files, 2061 passed / 1 skipped, the budget spec green inside it. One run, not a series.
- **Checked, kept as designed:** the exact per-call pin. Its doc comment justifies it (a ceiling on the total cannot tell six calls of 2 from one call of 12), and `revocation-ledger-marker` depends on seeing the per-call shape drop to 0.
- Not done: the handoff's source-mutation checks (for example, making `queryRevokedStamps` read twice). The unit spec now proves the counter's mechanics, and the per-call assertion message already embeds the per-block breakdown. Mutating `control-database.ts` on a shared tree to prove an assertion message was not worth the risk.

### DRY / source hygiene
- **Fixed — `instanceCount(label)` was dead API**: exported on `ConsultCounter`, never called by the spec, not mentioned by the downstream ticket. Removed.
- **Fixed — `signedSApp()` had seven near-identical copies** across cadre-core specs (this ticket added the seventh). They are now one helper, `test/signed-sapp.ts`, with `signedSApp({ latencyHint: 'realtime' })` for the two budget specs that must keep hibernation off. The six older specs dropped their local `SCHEMA`/`VERSION` constants and the crypto and `signSchema` imports that existed only for the helper. `scripts/lib/published-smoke-scenario.mjs` keeps its own copy on purpose: it is a plain-node port run against a registry install and cannot import a TypeScript test helper.
- File sizes: the budget spec is ~520 lines, mostly doc comments carrying provenance; its functions are short and single-purpose. Accepted as is.

### Docs
- **Fixed — `docs/architecture.md`** (the "every strand runs on the network transactor" paragraph) said a cohort of one commits "with no peer round trips and no cohort consult". The new spec measures 25 consults on the strand repo alone during a solo founding. Reworded: no peer round trips; consults still happen but are local lookups; their count is pinned by the new spec.
- `docs/testing.md` — checked, accurate.
- The architecture paragraph on the storage cache (it names the two storage budget specs) — checked. It is about raw-storage cost only, so it correctly does not name the consult spec.

### Error handling / resource cleanup
- The counter is restored in a `finally`, and the node is stopped in a `finally` inside `measureFounding`. The unit spec's `afterEach` puts back the real prototype methods even when a test fails midway. Nothing further found.
- `settleStart` awaits `membershipGateDrain` without a `within(...)` hang label. The drain never rejects, and the test's 180 s timeout bounds it. Left as is.

### Type safety
- One `unknown` cast in the counter (`fetchBlockFromCluster` is TypeScript-private), and one for the `CadreNode`/`StrandWatcher` internals, following `control-write-lock.spec.ts`'s precedent. No `any`. `yarn typecheck` (cadre-core, covers `test/`) and root `yarn lint`: exit 0.

### Performance / timing
- The spec depends on the whole run staying inside Optimystic's 10 s read-repair window. `readRepairWindowMs` is not configurable from cadre-core (grep of `packages/cadre-core/src`: no match), so the spec cannot pin the window. The implementer already documents this dependence in the spec's "Timing" paragraph and in every failure message. Measured run ~300 ms. No new tripwire.

### Tripwires
- None added. The existing `NOTE:` at `settleStart` (the fallback's quiet-wait heuristic has never run) stands.

### Tickets filed
- None. Every finding was minor and fixed in this pass. The remaining uncovered paths the handoff lists (`registerSelf`, `authorizePeer`, multi-machine consult cost) are measurement scope. `revocation-ledger-marker` already plans to measure `authorizePeer` through this counter, so they are not defects to file.

### Validation run in review
- `yarn vitest run` on the 9 touched and companion specs: 9 files, 70 tests passed.
- Full `packages/cadre-core` `yarn vitest run`: 126 files, 2061 passed, 1 skipped (log: `tickets/.logs/control-plane-consult-budget-gate.review.test.log`).
- `yarn typecheck` (cadre-core) and root `yarn lint`: exit 0.
