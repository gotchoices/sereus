description: When a phone leaves a shared strand soon after joining and later comes back, the database library we depend on can leave it holding only part of the data it had already read, and catching up from that partial copy takes about twice as long as starting from nothing. Somebody needs to decide whether to report this to the library's maintainers, and then report it.
files:
  - packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts (the opt-in reproduction)
  - tickets/implement/strand-first-sync-wait-sized-for-reattach.md (the measurement table this report draws on)
  - packages/integration-tests/src/harness/block-store-probe.ts (its header documents that a read served by a remote coordinator need not be stored locally)
repro: verified
----

# Human action: report "a short attach leaves a partial replica, and syncing from it is slow" to optimystic

**Blocked because the cause is in `@optimystic/db-p2p`, a sibling repository this repo must not edit (`tickets/rules/sibling-repos.md`), and because opening an issue on its tracker posts publicly under a person's name.** What unblocks it: a decision to send the report below (optimystic's tracker, or as a follow-up on optimystic #22 where the re-attach shape was reported), and somebody to send it. Sereus's own half, lengthening the first-sync wait so the slow case is not refused, is `implement/strand-first-sync-wait-sized-for-reattach` and does not depend on this.

If nothing is done: re-attaches over a slow relayed link keep working, but in the slow mode a phone waits over a minute to become writable and more than two minutes to see what its partner wrote while it was away, and sereus's first-sync wait has to stay long enough to cover that.

## Proposed report text

> **A peer that detaches soon after its first sync keeps only part of what it read; re-attaching over that partial store is about 2x slower than re-attaching over an empty one**
>
> Sereus 1.5.0 / optimystic 1.6.0, `cohortQueryTimeoutMs` 5000. Two relay-only nodes (A, B) on one loopback relay, a two-member cohort, 900 ms one-way latency injected per WebSocket frame (latency only, bandwidth unlimited). B attaches to a strand, reads a row, and detaches after a few seconds. A writes one row. B re-attaches over the same `IRawStorage` it used before.
>
> 1. **B's store is often missing collections it read.** In 5 of 8 runs B's launch-time read of `default/strand/Header` was served locally as absent (`cluster-fetch:solo-self-skip`, no read-repair), although B had read that table during its first attach. In one run the read threw `Missing block` instead: the collection's header block was there, a block it references was not. In the other 3 runs everything was there and B was usable at once. B is in the cohort for these blocks (`proximity:checked … inCluster: true`), so we would expect it to hold them. Our guess is that replication to B had not finished when it detached, and that reads B made through A as coordinator were not stored on B.
> 2. **Catching up from the partial store is slower than from an empty one.** Time from re-attach to "every table readable": 64-79 s over 5 runs from the partial store, against 39-57 s over 7 runs from an empty store (fresh joins and empty-store re-attaches, which behave the same). The row A wrote while B was away became readable on B at 140-162 s from the partial store, against 57-90 s from an empty one. In the trace, each block B reads goes to A as coordinator, and A consults B's stale copy (`sync-service` request to B, then `cluster-fetch:certified-selected … claimants: 1`, `local-current`) before answering: two link round trips per block.
> 3. **Completion times repeat across separate runs to within about 50 ms**: 38.7 s three times, 56.9 s twice, 74.9 s twice, 78.6 s twice, out of 12 runs, and the first three values are about 18 s apart. Separate runs of a latency-bound transfer should not agree that closely, so this looks like a periodic timer deciding when a stalled read or sync moves on.
>
> Questions: should a cohort member that served or read a block keep it? Is there a way for a detaching peer to finish (or a re-attaching peer to detect and repair) an incomplete replica before its reads start answering "absent"? What timer produces the ~18 s steps?
>
> Reproduction (sereus repo): `REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=reattach-kept REATTACH_RUNS=3 DEBUG='optimystic:db-p2p:coordinator-repo*,optimystic:db-p2p:sync-service*' yarn workspace @serfab/integration-tests exec vitest run strand-reattach-first-sync-measure`.

## Before sending

- Point 1's guess (replication unfinished at detach) is inferred, not shown: the scenario detaches B a few seconds after its first sync and never inspects B's raw store before the stop. Adding a `captureRawStorage(...).forStrand(strandId)` check just before `stopStrand` would confirm it; worth doing if the maintainers ask.
- Point 3 is a pattern across 12 runs (the other 4 took 42.3, 49.5, 64.1 s and did not repeat), not a traced timer. Say so, as the text does.

## Sent (2026-09-27)

The maintainer asked that upstream findings go to optimystic's tending agent. Sent to optimystic-tend as a message, not a public post. **Unblock when** optimystic says what it filed; then move this ticket to complete with that reference.

## Filed upstream (2026-09-27)

optimystic main `bd111c86`: `tickets/fix/reattach-over-a-partial-replica-reads-absent.md` (findings 1 and 3a) and `tickets/fix/catch-up-from-a-stale-replica-is-slower-than-from-empty.md` (finding 2 and the ~18 s steps; depends on the first). optimystic-tend thinks kjeib's phone report (every read `solo-self-skip`) is the same shape; send it the GitHub issue number when kjeib files it.
