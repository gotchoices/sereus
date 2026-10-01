description: Two tests that write to the control database while one party member silently stops answering were timing out, because a newer Optimystic makes such a write take about 63 s to fail, and twice that when it waits behind another failing write. The fix keeps that behaviour, derives the test limits from Optimystic's own deadlines, and documents how long a stalled member holds up the node's control writes.
prereq:
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, packages/cadre-core/src/strand-formation-protocol.ts, docs/cadre-consistency.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, tickets/.pre-existing-known.md, ../optimystic/packages/db-core/src/transactor/network-transactor.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/db-p2p/src/rpc-deadline.ts
difficulty: easy
repro: verified
----
# Degraded-cohort stalled writes outran the 120 s test cap

## What was failing

`packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts`: two cases hit their labelled 120 s cap.
- "fails with a named super-majority error when a member stalls past the response deadline"
- "a control read answers locally while a write is stalled"

Both ran against linked optimystic `249a26b8`, which derives every network deadline from the declared link round trip (3.5 s in sereus).

## What measurement showed (2026-10-01, caps temporarily raised to 600 s, `DEBUG=optimystic:db-core:network-transactor`)

The fix ticket's hypothesis was that the 154 s NetworkTransactor budget let the pend re-try for up to about 7 rounds. **The measurement disproves it.** The pend never re-tries.

| write | natural settle |
| --- | --- |
| stalled remove | 63.3 s |
| background `revocation-ledger-open` | 63.1 s |
| stalled authorize | 126.3 s: queued behind that background write, then its own 63 s |
| read-while-stalled authorize | 126.4 s, same shape |

Transactor log for one failing write (the remove):
- The pend starts at t=0. At about 21 s the coordinator answers with the shortfall ("Failed to get super-majority: 2/3"), and `pend:cancel` follows.
- `dischargeCancel` then runs: round 0 lasts 21 s and logs `cancel:retry round=0`; round 1 lasts another 21 s and logs "cancel … did not discharge". That makes about 63 s in total.

The mechanism:
- Each consensus round against the silent member costs 2 × the `ClusterClient` response deadline (2 × 10.5 s).
- The cancel discharge keeps starting rounds while `abortOrCancelTimeoutMs` has not run out. That budget is `max(5 s, dial)` in `collection-factory.ts`, now 38.5 s where it was 5 s. So two cancel rounds run instead of one.
- That is why a failing write went from about 42 s to about 63 s.
- The 154 s transaction budget never applies here. It bounds only a phase that keeps re-trying, such as re-picking a coordinator that does not answer.

## Decision: option 1, accept the derived budgets

**Recommendation: do not ask upstream for a separate transaction-budget knob.** It would not change this case, because the transaction budget is not what the time is spent on.

What a stalled member costs:
- The control write lock is held about 63 s per failing write, where it was about 42 s.
- A write queued behind one failing write settles after about 126 s.
- This is recorded as current behaviour in `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits".

If that lock-hold ever proves too long for a party of phones, the setting to raise upstream is the **cancel** budget, which is derived from the dial deadline. The transaction budget is the wrong target.

## What changed

**Scenario file.** The stalled bounds are now derived from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)` (`LINK_DEADLINES`):

| constant | formula | value at the default link |
| --- | --- | --- |
| `STALLED_ROUND_MS` | 2 × response deadline | 21 s |
| `CANCEL_BUDGET_MS` | `max(5 s, dial)`, restated from `collection-factory.ts` (it is computed inline there and not exported) | 38.5 s |
| `STALLED_CANCEL_ROUNDS` | `ceil(cancel budget / round)` | 2 |
| `STALLED_WRITE_FAILURE_MS` | (1 + cancel rounds) × round | 63 s |
| `STALLED_SETTLE_MS` | 2 × failing write: queued behind one failing background write | 126 s |
| `FAILURE_CEILING_MS` | settle + one round | 147 s |
| `STALLED_WRITE_TIMEOUT_MS` | ceiling + one round | 168 s |

- **Per-`it` timeouts:** `STALLED_WRITE_TIMEOUT_MS + 60 s` for the authorize case, and `+ 120 s` for the read-while-stalled and remove cases. Each is above the sum of that case's labelled deadlines.
- **Unchanged:** `FAILURE_FLOOR_MS` (15 s), the error-text assertions, the anti-vacuity assertions and the "no second attempt" retry-log assertions. Only the figure inside two assertion messages changed, from ~20 s to ~63 s.
- **Comments:** the header and "Deadlines" comments were rewritten to describe the mechanism and the 2026-10-01 measurements.

**Delayed-member case.** It now takes ~8 s instead of ~55 s. That case was never failing, so its bounds (`DELAYED_WRITE_TIMEOUT_MS` 120 s, `DELAYED_COMMIT_CEILING_MS` 100 s) were left loose deliberately and annotated with a `NOTE:`. Its `error === null` assertion is what catches an escalation into the failure path.

**`packages/cadre-core/src/control-write-retry.ts`.** The `CONTROL_WRITE_RETRY_BUDGET_MS` comment and NOTE were corrected:
- The cancel budget is 38.5 s at the default link, not 5 s.
- So one full cancel discharge ends the retries on its own.
- That costs nothing: a cancel only runs that long after a silent-peer attempt, which has already exceeded the 10 s budget.
- A transient fault's cancel finishes in about a second.

**`packages/cadre-core/src/strand-formation-protocol.ts`.** The late-commit NOTE in `settleWithinGrace` now names a third cause: a commit phase that re-picks a coordinator that does not answer, up to the 154 s transaction budget.

**`docs/cadre-consistency.md` → "Deadlines …".**
- A new paragraph covers Optimystic's two write budgets (transaction 154 s, cancel 38.5 s; both "contain"), the ~63 s silent-member cost, and the write-lock hold.
- The formation provisioning row now states that its 70 s per-commit allowance contains a successful commit, and that the cut-off ends the wait on a failing one. This was confirmed against `StrandFormationResponder.provision` / `settleWithinGrace`: a failing commit leaves the invite unspent and the joiner is told "timed out", which it can retry.

**`tickets/blocked/adopt-optimystic-address-dial-timeout.md`.** Its "does the transaction timeout fit" sub-bullet now points here. It also records two things:
- A dial above 42 s makes 3 cancel rounds, so a failing write takes ~84 s.
- The scenario's `LINK_DEADLINES` must be given the same `rpcDeadlines` override once sereus passes one. There is a matching `NOTE:` in the scenario.

## Validation so far

- `yarn workspace @serfab/integration-tests typecheck`: clean. `npx eslint` on the three changed source files: clean.
- `yarn workspace @serfab/cadre-core build` was rebuilt, because the comment edits made its dist stale for the guard.
- Scenario run on its own with the derived bounds: **7 passed / 7**. Stalled authorize 126.4 s (ceiling 147 s), read-while-stalled 126.4 s, stalled remove 63.3 s, delayed writes 8.2 s each.
- Full `yarn workspace @serfab/integration-tests test` (2026-10-01, linked optimystic `249a26b8`): **66 files passed / 3 skipped; 321 tests passed / 15 skipped / 0 failed**, 1011 s (log: `tickets/.logs/degraded-cohort-full.log`).

## TODO

- [x] Measure natural settles (above).
- [x] Pick option 1 and record the tradeoff (above).
- [x] Derive `STALLED_WRITE_TIMEOUT_MS`, `FAILURE_CEILING_MS` and the per-`it` timeouts; update header and "Deadlines" comments.
- [x] Docs and NOTE updates (cadre-consistency, control-write-retry, strand-formation-protocol, the blocked ticket).
- [x] Scenario green on its own.
- [x] Full `yarn workspace @serfab/integration-tests test` green (above).
- [x] Removed this signature's entry from `tickets/.pre-existing-known.md`; its "Open" section is now empty.
- [ ] Implement pass: read the diff against the TODOs above, and re-run the scenario on its own once to confirm the stalled authorize still settles near 126 s, under the 147 s ceiling. Nothing else is outstanding.
