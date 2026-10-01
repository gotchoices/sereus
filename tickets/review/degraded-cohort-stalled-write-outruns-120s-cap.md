description: Two tests that write to the control database while one party member silently stops answering were timing out, because a newer Optimystic makes such a write take about 63 s to fail, and twice that when it waits behind another failing write. The fix keeps that behaviour, derives the test limits from Optimystic's own deadlines, and documents how long a stalled member holds up the node's control writes.
prereq:
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/strand-formation-protocol.ts, docs/cadre-consistency.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, tickets/.pre-existing-known.md, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/db-p2p/src/rpc-deadline.ts
repro: verified
----
# Degraded-cohort stalled writes outran the 120 s test cap — review handoff

The code changes landed in commit `d88128c4` (the fix-stage commit carried them); this implement pass only re-verified them. Review that commit's diff.

## The finding

Against linked optimystic `249a26b8` (every network deadline derived from the declared 3.5 s link round trip), a control write with one silent cohort member fails after about 63 s, not the ~42 s it took before:
- One pend round (~21 s = 2 × the 10.5 s `ClusterClient` response deadline); the coordinator answers with the super-majority shortfall.
- Then the cancel discharge keeps starting rounds while `abortOrCancelTimeoutMs` = `max(5 s, dial)` = 38.5 s remains: two more rounds.
- The 154 s transaction budget is never what ends it; it only bounds a phase that keeps re-trying (e.g. re-picking an unanswering coordinator).
- A write queued under the control write lock behind one failing write settles after ~126 s.

Decision: accept the derived budgets (no upstream knob request). If the lock-hold proves too long, the budget to raise upstream is the cancel budget, not the transaction budget. Recorded in `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits".

## What changed

- **Scenario** (`control-write-degraded-cohort-member.integration.ts`): stalled bounds derived from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)` — `STALLED_ROUND_MS` 21 s, `CANCEL_BUDGET_MS` 38.5 s (restated from `collection-factory.ts`, which computes it inline), `STALLED_CANCEL_ROUNDS` 2, `STALLED_WRITE_FAILURE_MS` 63 s, `STALLED_SETTLE_MS` 126 s, `FAILURE_CEILING_MS` 147 s, `STALLED_WRITE_TIMEOUT_MS` 168 s; per-`it` timeouts +60 s / +120 s. Floor, error-text, anti-vacuity and no-second-attempt assertions unchanged. Delayed-member bounds deliberately left loose with a `NOTE:`.
- **`control-write-retry.ts`**: budget comment and NOTE corrected (cancel budget 38.5 s, so one full cancel discharge ends the retries on its own; costs nothing because it only runs that long after a silent-peer attempt).
- **`strand-formation-protocol.ts`**: late-commit NOTE names the coordinator re-pick path (up to 154 s).
- **Docs**: new paragraph on the two write budgets and the write-lock hold; formation provisioning row clarifies the commit allowance contains a successful commit and the cut-off ends a failing one.
- **Blocked ticket** `adopt-optimystic-address-dial-timeout`: its transaction-timeout sub-bullet answered; notes that a dial > 42 s means 3 cancel rounds (~84 s) and that the scenario's `LINK_DEADLINES` must get the same `rpcDeadlines` override once sereus passes one (matching `NOTE:` in the scenario).
- `tickets/.pre-existing-known.md`: this signature's entry removed.

No tests added: the scenario's existing cases are the reproduction; only their bounds changed.

## Validation

- Typecheck and eslint on changed files clean (fix stage).
- Full `yarn workspace @serfab/integration-tests test` (fix stage, 2026-10-01): 66 files passed / 3 skipped; 321 tests passed / 15 skipped / 0 failed.
- Implement-stage re-run of the scenario alone (2026-10-01): **7/7 passed**, 351 s. Stalled authorize 126.4 s (ceiling 147 s), read-while-stalled 126.4 s, stalled remove 63.3 s, delayed writes 8.2 s each, transient reset committed on attempt 3/3.

## Known gaps / things to check

- `CANCEL_BUDGET_MS` restates an upstream inline expression; if optimystic changes it the scenario's derivation silently drifts (the test would then fail on the ceiling or floor, which is the intended signal). Reviewer may want to judge whether the comment pointing at `collection-factory.ts` is enough.
- Headroom on the 147 s ceiling is one round (~21 s) above the measured 126.4 s; a much slower CI box could approach it.
- The ~63 s write-lock hold per failing write on a party of phones is accepted, not fixed.
