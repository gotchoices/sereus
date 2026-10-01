description: Two tests that write to the control database while one party member silently stops answering were timing out, because a newer Optimystic makes such a write take about 63 s to fail, and twice that when it waits behind another failing write. The fix keeps that behaviour, derives the test limits from Optimystic's own deadlines, and documents how long a stalled member holds up the node's control writes.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/strand-formation-protocol.ts, docs/cadre-consistency.md, docs/architecture.md, docs/testing.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, tickets/.pre-existing-known.md
repro: verified
----
# Degraded-cohort stalled writes outran the 120 s test cap — complete

Code landed in `ticket(fix): degraded-cohort-stalled-write-outruns-120s-cap`; `ticket(implement): degraded-cohort-stalled-write-outruns-120s-cap` only re-verified it.

## What was decided and done

Against linked optimystic `249a26b8`, which derives every network deadline from the declared 3.5 s link round trip, a control write with one silent cohort member fails after about 63 s. That is one pend round (~21 s, two 10.5 s `ClusterClient` response deadlines), then the cancel discharge, which keeps starting ~21 s rounds while its 38.5 s budget (`abortOrCancelTimeoutMs` = max(5 s, dial deadline)) has time left: two rounds. The 154 s transaction budget is never what ends it. A write queued under the control write lock behind one such failure settles after ~126 s.

The derived budgets were accepted; no upstream knob was requested. The scenario's stalled bounds are now derived from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)` instead of fixed numbers. `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits" records the two write budgets and the write-lock hold. The retry-budget and formation late-commit comments were corrected, the blocked dial-timeout ticket had its transaction-timeout question answered, and the pre-existing-failure entry was removed.

## Review findings

Read the fix-stage diff first, then checked each timing claim against upstream source (`network-transactor.ts` `dischargeCancel`, `collection-factory.ts`, `rpc-deadline.ts`).

- **Correctness of the derivation:** confirmed. `dischargeCancel` sets its deadline once, starts a round whenever time remains, and a round against the silent member runs its full ~21 s, so rounds = ceil(38.5 / 21) = 2, matching the measured 63.3 s (an honoured per-round cut-off would have given ~59.5 s). Transaction budget is `max(30 s, 4 × dial)` and applied per phase, as the doc says. `resolveLinkDeadlines` and `DECLARED_LINK_ROUND_TRIP_MS` are exported where the test imports them, and cadre-core passes the same declared round trip to the node.
- **Upstream round cap left out of the derivation (tripwire):** `STALLED_CANCEL_ROUNDS` ignores upstream's private `MAX_CANCEL_ROUNDS` = 6. Matters only once the dial deadline exceeds 126 s. Parked as a `NOTE:` on `STALLED_CANCEL_ROUNDS` in the scenario.
- **Restated cancel-budget expression** (`CANCEL_BUDGET_MS`): upstream computes it inline and exports nothing, so restating it with a pointer is the available option. Downward drift would be absorbed by the loose floor; upward drift fails the ceiling, which is the intended signal. No change.
- **Per-`it` timeouts:** summed each stalled case's labelled deadlines (failure case 183 s vs 228 s; read-while-stalled ≤ 258 s vs 288 s; failed DELETE 228 s vs 288 s). All above, so a hang reports the labelled error, as the file's convention requires.
- **Stale docs (fixed):** `docs/architecture.md` "Whole-party breadth makes one connected-but-degraded member decisive" still gave ~55 s for the delayed write and ~21 s / ~42 s for the silent-member failure; updated to ~8 s and ~63 s, with a link to the cadre-consistency derivation. The retry paragraph's "~21 s a silent member takes to fail" now says what the 10 s budget is really compared against (the first round). `docs/testing.md`'s topology map listed this three-node scenario under "Two-machine party"; moved to the three-machine line.
- **Tests:** no tests added or cut. The scenario's existing cases are the reproduction; only bounds and comments changed. The delayed-write bounds stay loose under an existing `NOTE:` explaining why.
- **Error handling, resource cleanup, types:** no new runtime code, so nothing new here. Teardown comment updated to the new cancel budget; `finally` blocks still release the degradation and drain the stalled write.
- **Headroom (accepted):** the 147 s ceiling sits one round (~21 s) above the measured 126.4 s. A much slower CI box could approach it; that is the documented reason for the one-round margin.
- **Write-lock hold (accepted, documented):** ~63 s per failing write blocks every other control write on the node. Recorded in `docs/cadre-consistency.md`; if it proves too long, the budget to raise upstream is the cancel budget.

Validation (review pass, 2026-10-01): eslint on the three changed source files clean; `yarn workspace @serfab/integration-tests typecheck` clean; scenario run alone **7/7 passed**. Stalled authorize 126.4 s, read-while-stalled 126.4 s, stalled remove 63.3 s, delayed writes 8.2 s each, transient reset committed in 1.55 s.
