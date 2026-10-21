description: When one of three machines answers the first step of a shared-database write and then goes silent, the writing machine used to stay stuck refusing later writes to that table; the database library fixed that in its 1.14.0 release. Sereus has no test that would notice if it came back, so add one to the degraded-machine scenario.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts (the handler swap and `abortPreSwapStreams`, the bound derivations around `STALLED_CANCEL_ROUNDS`, the header paragraph ~90-94 naming this ticket), docs/cadre-consistency.md (~52, already states the 1.14.0 behaviour), ../optimystic/packages/db-core/src/transactor/owed-cancels.ts (read only), ../optimystic/packages/db-p2p/test/failed-cancel-does-not-strand-the-writers-pend.spec.ts (upstream's reproduction, read only), packages/quereus-plugin-sereus/src/compose-strand.ts (`releaseOptimysticPlugin`)
----
# The degraded-cohort scenario covers a member that goes silent after answering the pend

Formerly `blocked/optimystic-failed-cancel-strands-the-writers-pend-record`. On a three-member cohort a member that answered a write's pend and then went silent sank the commit, and every round of the cancel too, because the promise bar is all three. The writer forgot the failed cancel, and when the member came back every member holding the pending record voted `held` on every later write to that block. Optimystic fixed it in 1.14.0 (`4.6-a-cancel-that-misses-the-bar-strands-the-writers-pending-record`, `ed98ef15`): a cancel that misses the bar stays owed by the writer's `NetworkTransactor` and is re-sent before its next pend of those blocks and on an unref'd timer (1 s doubling to 30 s), until it lands. Sereus adopted 1.14.0 in `3b5bec00` and now requires ^1.17.0.

Nothing in Sereus exercises the path. `control-write-degraded-cohort-member` aborts every cluster stream opened to C before it swaps C's handler, so each degraded write fails in its pend, and the case that found the defect is gone (see the scenario header).

## What to build

- A case in `control-write-degraded-cohort-member.integration.ts` where C answers a write's pend and goes silent before the commit. One way: hold only the cluster streams to C whose first message is a commit, so C's promise vote still goes out.
- Assert that the write fails with the named super-majority shortfall, in about 137 s at the default declaration (the pend, the one-round commit and the tail commit, then three cancel rounds; `docs/cadre-consistency.md` → "Deadlines Over Optimystic's Reads and Commits"). Derive the bound from the file's existing budget constants rather than adding a fresh number.
- Restore C and assert that the next write to the same table commits. Its pend re-sends the owed cancel first, so it should not need the timer.
- Remove the header paragraph that says this path is not covered.

## Constraints carried from the blocked ticket

- Do not call `NetworkTransactor.stop()` on the `dispose()` path of `releaseOptimysticPlugin` (an injected node kept across a database rebuild): the old transactor's owed cancel is what clears a stuck record on live members. Today that path calls only `collectionFactory.dispose()`; keep `shutdown()` on the created-node path.
- If a cancel that never lands keeps an old transactor alive while the node runs, report it to Optimystic (hand the owed set to the next transactor, or give up after a deadline) rather than adding a `stop()` call here.
- A writer that exits before its owed cancel lands still leaves its record on the other members. That is `../optimystic/tickets/backlog/debt-unpromotable-pending-records-need-a-sweep`, not this ticket.

## TODO

- Add the case and its assertions; run the whole file in isolation (about 6 minutes today, about 9 with the new case) and confirm the `afterEach` abandoned-write check labels the case's loss as inside a degraded window.
- Remove the header paragraph.
- Update the 2026-10-12 delta in `tickets/.pre-existing-known.md` if the new case changes what a recurrence of that fingerprint means.
