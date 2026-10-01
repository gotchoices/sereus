description: A control write against a silently stalled cohort member now takes 63–141 s or more to fail. The linked optimystic derives the NetworkTransactor budget from the declared link: 154 s at sereus's 3.5 s, where it was a fixed 30 s. Two degraded-cohort cases hit their 120 s cap. Decide whether sereus accepts the longer failure (derive the test bounds and document the write-lock hold) or needs an upstream budget knob, then make the suite green.
prereq:
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts, packages/cadre-core/src/control-write-retry.ts, docs/cadre-consistency.md, tickets/blocked/adopt-optimystic-address-dial-timeout.md, ../optimystic/packages/db-p2p/src/rpc-deadline.ts, ../optimystic/packages/quereus-plugin-optimystic/src/optimystic-adapter/collection-factory.ts, ../optimystic/packages/db-core/src/transactor/network-transactor.ts
difficulty: medium
architecture: docs/testing.md, docs/cadre-consistency.md → "Deadlines Over Optimystic's Reads and Commits"
----
# Degraded-cohort stalled writes outrun the 120 s test cap

## Failing tests

From `packages/integration-tests`:

```
npx vitest run src/scenarios/control-write-degraded-cohort-member.integration.ts
```

Reproduced 2026-10-01 at sereus `a00dba8d` against linked optimystic `249a26b8`. The stale-build guard was green. Result: **2 failed / 5 passed**. The same two fail in the full `yarn workspace @serfab/integration-tests test` (2 failed / 319 passed / 15 skipped).

- "fails with a named super-majority error when a member stalls past the response deadline": `degraded-cohort control op authorizePeer(…) stalled timed out after 120000ms`
- "a control read answers locally while a write is stalled": `degraded-cohort control op stalled write settles timed out after 120000ms`

Settle times from the same run:

```
[abandoned-write A] [revocation-ledger-open] budget after 1/3 attempt(s) in 63143ms   (first stalled window)
[abandoned-write A] [peer-insert] budget after 1/3 attempt(s) in 141164ms            (cut short: the case's finally released the degradation at 120 s)
[abandoned-write A] [revocation-ledger-open] budget after 1/3 attempt(s) in 133235ms
[abandoned-write A] [peer-insert] budget after 1/3 attempt(s) in 120436ms            (read-while-stalled case, also released at 120 s)
[measured] remove with never-answering member: 63308ms                               (passes; 3 pend rounds of ~21 s)
[measured] authorize with 2000ms-delayed member: 8161ms                              (was ~55 s; passes)
```

The 141 s and 120 s figures are **not** natural settle times. The test released C's handler when its cap fired, which aborted the held streams. Without that release, nobody knows how long a stalled authorize takes now.

## Root cause (confirmed in source)

optimystic `7da08dc2` (`the-rpc-dial-deadline-cannot-be-set-per-node`) derives every deadline from `linkRoundTripMs` (`packages/db-p2p/src/rpc-deadline.ts`, `resolveLinkDeadlines`). Cadre-core always declares `DECLARED_LINK_ROUND_TRIP_MS` = 3500 (`cadre-node.ts`, `linkRoundTripMs: resolveLinkRoundTripMs(...)`):

| deadline | before | now at 3.5 s |
| --- | --- | --- |
| RPC dial (`dialTimeoutMs`, 11 RTT) | 3 s | 38.5 s |
| NetworkTransactor `timeoutMs` (4 × dial) | 30 s fixed | **154 s** |
| `abortOrCancelTimeoutMs` (max(5 s, dial)) | 5 s | 38.5 s |
| ClusterClient response (3 RTT) | 10.5 s | 10.5 s |

`quereus-plugin-optimystic`'s `collection-factory.ts` builds every control collection's NetworkTransactor with `timeoutMs: transactionTimeoutMs`. Its own NOTE accepts the cost: "a write against an unreachable cohort takes that long to fail."

Why the failure got longer: in `network-transactor.ts`, `processBatches` keeps re-trying failed batches while `Date.now() < expiration`. A silent member costs about 21 s per round (two 10.5 s response deadlines).
- Under a 30 s budget, a phase ran one or two rounds, which is where the old 42 s and 84 s settles came from.
- Under 154 s it can run up to about 7 rounds.

The budget is also not one per write:
- `pend`, the one-round commit (`commitInOneRound`), the tail-then-rest fallback and `commitBlocks` each stamp their own `Date.now() + timeoutMs`.
- The failed attempt then pays a cancel discharge of up to 38.5 s.

**Consequence beyond the test.** Control writes run one at a time under `ControlDatabase.withWriteLock`. While one cohort member silently stalls, each control write on the node holds that lock for minutes instead of under a minute, and every other control write queues behind it: self-record updates, authorizations, revocation-ledger writes.
- That queueing is why the stalled authorize took 84.3 s before: it waited behind a failing `revocation-ledger-open`.
- The same queueing now makes the authorize case's own settle at least two failing writes long.

Ruled out: making sereus's `rpcDeadlines.dialTimeoutMs` smaller to shrink the budget. The dial has to contain a cold relayed open at the supported link plus the admission decisions. The open is about 10 RTT, 35 s at 3.5 s, and `adopt-optimystic-address-dial-timeout` plans to *raise* the dial to that plus 2 × `ADMISSION_DECISION_TIMEOUT_MS`. That would move the transaction budget to about 170 s, not lower it.

## Decision this fix has to make

1. **Accept the derived budget (recommended unless step 1 of the TODO shows settles beyond about two budgets).**
   - Derive the scenario's hang caps from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)` (precedent: `relayed-dial-cost-by-latency.integration.ts` imports both).
   - Record the write-lock hold as current behaviour in `docs/cadre-consistency.md`.
   - Upstream chose this tradeoff explicitly, and sereus cannot change it on its own side.
2. **Ask upstream for a transaction-budget override**, separate from the dial deadline, so sereus can bound how long a failing control write holds the lock without shortening its dials. Choose this if the measured settle or the lock-hold time is unacceptable for a party of phones. This route goes to `blocked/` as an upstream dependency, and the test stays red until the release lands. Do not skip it.

## Design constraints

- The caps must be **derived**, not re-hard-coded. Upstream moved this number once; the next move has to carry the caps with it.
  - Each cap has to be longer than the work it waits for: the queued write plus the write's own attempt, each attempt being phases × `transactionTimeoutMs` plus `abortOrCancelTimeoutMs`.
  - Size it from the measured phase count, not from the theoretical maximum, and give the reasoning in the constant's comment.
- `FAILURE_FLOOR_MS` (15 s) stays. It is what proves the response-deadline path was exercised.
- `FAILURE_CEILING_MS` keeps its meaning, "the transaction budget held": it sits above the derived settle bound and below the hang cap.
- The per-`it` timeouts must stay above the sum of the labelled deadlines in each case, so the labelled error wins over vitest's anonymous timeout.
- The retry-log assertions ("no second attempt") remain valid, since an attempt of 21 s or more always exceeds `CONTROL_WRITE_RETRY_BUDGET_MS`. Keep them.
- Forbidden: `it.skip`, loosening the error-text or anti-vacuity assertions, or dropping a stalled case to save wall-clock time.

### Cross-cutting obligations

- `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits": add the NetworkTransactor budget (154 s at the default declaration, "contains"). State that a stalled member holds the control write lock for it.
  - The formation provisioning row budgets each commit at `COMMIT_ROUND_TRIPS` (70 s). A *failing* commit now runs past that to the transaction budget, and the row's designed cut-off is what catches it. Confirm the row still says that.
- `packages/cadre-core/src/control-write-retry.ts`: the NOTE on `CONTROL_WRITE_RETRY_BUDGET_MS` says every collection sets `abortOrCancelTimeoutMs` to 5 s. That is now 38.5 s at the default declaration, so two full cancel discharges no longer fit the 10 s budget even once. Correct the figure and re-check the reasoning in the NOTE.
- `tickets/blocked/adopt-optimystic-address-dial-timeout.md`: its TODO "check that the derived transaction timeout still fits inside sereus's write and cohort budgets" is answered by this ticket. Point it here.
- No determinism edition, byte-format vector, golden fixture or migration is involved.

## TODO

- [ ] Measure natural settles. Re-run the two failing cases once with the caps temporarily raised to about 600 s, locally only and not committed, and record the authorize, remove and background-write settle times and the number of pend rounds.
- [ ] Pick option 1 or 2 above and record the tradeoff in this ticket's implement handoff.
- [ ] Option 1: derive `STALLED_WRITE_TIMEOUT_MS`, `FAILURE_CEILING_MS` and the affected per-`it` timeouts from `resolveLinkDeadlines(DECLARED_LINK_ROUND_TRIP_MS)`. Update the header and "Deadlines" comments, which still describe a 30 s budget, ~55 s delayed commits and an 84.3 s slowest settle.
- [ ] Docs and NOTE updates listed under "Cross-cutting obligations".
- [ ] Run the scenario on its own until it is green, then run the full `yarn workspace @serfab/integration-tests test`.
- [ ] Remove this signature's entry from `tickets/.pre-existing-known.md` once it is green.
