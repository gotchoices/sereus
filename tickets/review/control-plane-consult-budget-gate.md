description: The test suite now counts how often the control database asks the other machines about its data, and how many commits it makes, while a solo party is founded and then sits idle, so a change that doubles that network work fails a test instead of passing unnoticed.
files:
  - packages/cadre-core/test/cohort-consult-counter.ts (new — the counter)
  - packages/cadre-core/test/control-founding-consult-budget.spec.ts (new — the budget spec)
  - packages/cadre-core/test/control-start-storage-op-budget.spec.ts (Companions paragraph points at the new spec)
  - docs/testing.md ("Where measurements live" lists the new budget)
  - packages/cadre-core/test/storage-op-counter.ts, packages/integration-tests/src/harness/key-network-patch.ts (patterns mirrored)
  - ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (`get` decides per block whether to consult; `fetchBlockFromCluster` and `commit` are what is counted)
----
# Review: consult and commit budget over party founding and the hot membership reads

## What was built

**`cohort-consult-counter.ts`.** `installConsultCounter()` wraps `CoordinatorRepo.prototype.fetchBlockFromCluster` (a "consult": Optimystic's coordinator asking a block's cohort for its latest revision) and `CoordinatorRepo.prototype.commit`. It records each call before delegating and keeps tallies per repo instance and per block id.
- `fetchBlockFromCluster` is TypeScript-private. It is reached through one `unknown` cast, and both methods are checked with `typeof … === 'function'` before wrapping, so an upstream rename throws at install.
- `snapshot(label?)`, `reset()` (labels survive a reset), `labelUnlabeled(label)`, `instanceCount(label)`, `restore()`. Restore is idempotent and throws while a later patch sits on top (last-in-first-out, as in `key-network-patch.ts`).
- Attribution works by labelling: at the end of the phase that creates a repo, every unlabelled repo gets a label (`control` after `start()`, `strand` after `foundStrand`). The spec asserts exactly one new repo in each of those phases, and none in any other.
- `formatConsultSnapshot` / `formatPerBlock` print greppable `[consult-budget] …` lines.

**`control-founding-consult-budget.spec.ts`.** One solo `CadreNode` (`profile: 'transaction'`, one `MemoryRawStorage` per storage id). Each phase is measured from a zeroed counter:

- cold `start()`
- genesis (`ensureOwnerKey` with the identity key)
- `foundStrand`, with the control and strand repos reported separately
- `queryRevokedStamps('CadrePeer')` ×6 and `queryCadrePeers()` ×6, pinned per call **exactly**
- one idle `reconcileControlCohort()`

Phase budgets are two-sided like the storage budgets: ceilings plus a floor at half the measured count, with the floor skipped where the measurement is 0. Every failure message carries the per-block breakdown and how far into the run the phase began. The spec's doc comments are the source of truth for the numbers and their provenance; they are not copied here.

**Background work is taken out of the phases** (`settleStart`):
- The self-registration timer is disarmed, following `control-write-lock.spec.ts`. That also keeps the reconcile interval and the heartbeat from ever being armed.
- The membership-gate refresh that `start()` launches without awaiting is awaited.
- The strand watcher's first poll (deferred 100 ms) is cancelled and run explicitly after that refresh.
- The watcher's poll interval and `reconcileMs` are set to one hour.

## Measured, 2026-09-15 (three consecutive runs, identical per phase and per block apart from the random ids of new tree blocks)

- Cold is **30** consults over 18 blocks, 2 commits. The ticket's trace said 24; the difference is intended. That trace snapshotted as soon as `start()` returned. This spec also charges the gate refresh (`CadrePeer` ×2, `Revocation` ×2) and the first watcher poll (`Strand` ×2) to cold, because every start pays for them, and awaiting them is what makes the phase boundary deterministic. 30 − 6 = 24 matches the trace.
- Genesis: 14 / 3 / 4, same as the trace.
- `foundStrand`: control 25 consults / 6 blocks / 6 commits; strand 25 / 15 / 6. Together that is 50 consults and 12 commits; the trace taken before upstream removed the absence memo recorded 47 and 12.
- `queryRevokedStamps` costs `[2, 2, 2, 2, 2, 2]`. The trace's first call cost 4, but it ran right after genesis, before founding.
- `queryCadrePeers` costs `[4, 4, 4, 4, 4, 4]`.
- Idle reconcile: 8 consults over 2 blocks (`CadrePeer` ×4, `Revocation` ×4), 0 on the strand.
- The whole run takes ~300 ms, far inside the 10 s read-repair window.

## Validation done

- `yarn vitest run test/control-founding-consult-budget.spec.ts --reporter=verbose` (from `packages/cadre-core`): 3 of 3 passing, identical counts.
- `control-start-storage-op-budget.spec.ts` and `strand-solo-write-budget.spec.ts`: both pass.
- `yarn typecheck` (cadre-core, which covers `test/`) and root `yarn lint`: exit 0.
- The full cadre-core suite was **not** run.

## Known gaps — treat as a starting point

- **The counter has no spec of its own.** The throw on out-of-order restore and the check before wrapping were never exercised by a test that hits them. Suggested checks: install two counters and restore the outer one first (expect the throw, then a clean restore after the inner one); delete the method from a copy of the prototype shape (expect the install to throw).
- **The fallback in `settleStart` never ran.** It covers the case where `start()` outlasts the watcher's 100 ms deferral, and it waits for 300 ms without consults, which is a heuristic. Every run printed `run-by-spec`. A `NOTE:` at `settleStart` says to suspect this wait first if a run that printed `fired-inside-start` shows a moved cold count.
- **Not observed under full-suite parallel load.** A run has ~30× headroom against the 10 s window, but only an idle machine was measured. A starved run that crossed the window would re-consult held blocks and fail. The messages say so, but the result would be a flake.
- **Per-call reads are pinned by exact equality**, so an improvement fails too. This is deliberate (the per-call pattern is the signal), but it is stricter than the phase budgets; check that it is the call you want.
- **Not covered:** `registerSelf` and the start-up reconcile pass (disarmed); `authorizePeer`, `removePeer`, `getOwnerKeys`, `queryRevocations` from the trace; any multi-machine party (a consult's real network cost there was never measured).
- `controlCohort.reconcileMs` in the spec config has no effect, because the self-registration timer that would arm the interval is disarmed. It is kept as a guard and commented as such.
- `signedSApp()` is now the seventh copy of the same helper across cadre-core specs, and no debt ticket tracks that duplication.

## Suggested adversarial checks

- Make `queryRevokedStamps` read twice. The per-call assertion should fail and name `default/Revocation×4` for each call.
- Point the counter at a method nothing calls (for example, wrap `get` under the consult name in a scratch copy). The floors should fire with the anti-vacuity message.
- Remove `settleStart`'s disarm of the self-registration timer and add a 1.5 s wait before genesis. Genesis should grow, and the per-block breakdown should show `CadrePeer`/`Revocation`.
- `revocation-ledger-marker` (prereq'd on this ticket) plans to use this counter to show its effect. Its marker is filed only while connected, so these solo numbers should not move when it lands.
