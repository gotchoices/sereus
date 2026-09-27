description: A machine re-opening a shared strand after being away, over a slow relayed link, could take longer to get its data back than the wait allowed, and was then told, wrongly, that no other member was reachable. The default wait is now five minutes, the error text no longer blames reachability, and the docs describe the re-attach case.
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files:
  - packages/cadre-core/src/strand-first-sync-gate.ts (DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS = 300_000 and its doc comment; StrandAwaitingFirstSyncError text; module doc; StrandFirstSyncGate.open doc + log line)
  - packages/cadre-core/test/strand-first-sync-gate.spec.ts (message regex; one comment)
  - packages/integration-tests/src/scenarios/strand-chat-participants-converge.integration.ts (message regex)
  - packages/integration-tests/src/scenarios/strand-reattach-first-sync-measure.integration.ts (opt-in measurement; gained REATTACH_COHORT_READ_MS)
  - packages/cadre-core/src/types.ts (CadreNodeConfig.strandFirstSync doc)
  - packages/cadre-core/src/link-budget.ts (DECLARED_LINK_ROUND_TRIP_MS doc)
  - packages/quereus-plugin-sereus/src/cluster-size.ts (COHORT_READ_DEADLINE_MS doc)
  - packages/reference-app-rn/src/chat-strand.ts (joinClosedChatStrand doc)
  - docs/strands.md, docs/testing.md, docs/reference-app-rn.md, docs/architecture.md
  - tickets/backlog/debt-cadre-deadlines-sized-against-old-optimystic-bounds.md (table row)
  - .release-notes.pending.md
----

# Size the first-sync wait for a re-attach, and stop the error blaming reachability — review handoff

## What changed

A machine that has never received a strand's data must not write to it, so `CadreNode.addStrand` holds the strand database back until the data arrives from another member. That wait is the "first-sync gate" in `strand-first-sync-gate.ts`, and `addStrand` rejects with the retryable `StrandAwaitingFirstSyncError` when its budget runs out. The budget was 120 s, sized from fresh joins only. A re-attach over a slow relayed link (optimystic #22, about 150 s) and a real phone's fresh join through the public relay (178 s) both exceeded it.

- **`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` is now `300_000`.** Its doc comment now holds the only copy of every figure: the direct-link case, the fresh-join bands at both cohort read deadlines (the band in force widened to 35-57 s by the scenario's 56.9 s run), the re-attach arms (empty store 38.7-56.8 s; kept store bimodal, 3 of 8 ungated, 5 of 8 gated at 64.1-78.7 s; row written while away readable only at 140-162 s), the two outside samples, why 300 s and not 240 s, and the history (30 s, then 120 s). The accepted-tradeoff `NOTE:` is updated in place, not duplicated: a strand with no reachable member now takes five minutes to report. The revisit condition is unchanged.
- **Error text.** It now reads "this machine has not yet received the strand's data from another member (waited N ms). Either no other member is reachable, or the link to one is slow and the sync is still in progress…", and names `addStrand`, `whenStrandWritable(strandId)` and the `'strand:writable'` event as the ways to keep waiting. Both tests now match `/has not yet received the strand's data from another member/`, a phrase that is true both with no peer and with a slow sync. The class doc and `StrandFirstSyncConfig.timeoutMs` doc made the same "reached no other member" claim and are reworded to match.
- **The "never gated" claim.** The module doc and `docs/strands.md` now say that whether a machine "has synced before" is decided by what its local store holds. They say a machine that left soon after its first sync can come back without the Header collection and be gated like a joiner, and that gating it is correct. `types.ts` now says "a machine whose store already holds the Header".
- **`StrandFirstSyncGate.open`.** The log line now reads "database published by the caller; first-sync gate not needed or force-opened". The doc now says `open()` runs on every publish that bypasses the loop. While checking this I found the module doc's "Owned by" paragraph was also wrong: the gate is built for every launch and armed only when the first probe fails, not "created for a non-founder launch whose first probe finds no Header". Corrected.
- **Other statements of the number** now point at the constant instead of restating it: `link-budget.ts`, `types.ts`, `cluster-size.ts` (two places, including a stale "about 2.6x" margin in its NOTE), `docs/strands.md`, `docs/reference-app-rn.md`, `docs/architecture.md`. `reference-app-rn/src/chat-strand.ts` also said "if no host is reachable" and is reworded. Its budget is stated nowhere else.
- **`docs/testing.md`.** The "shape to build" recipe is replaced with a paragraph under "Where measurements live". It points at the committed scenario, says what the scenario prints, how to compare cohort read deadlines, and why it is a separate file rather than a configuration of `relay-round-trip-measure`. No numbers are copied. The cohort-deadline paragraph's lead now says "no gating test" instead of "no committed scenario".
- **The scenario (fresh-eyes pass).** It reads correctly. The one thing I checked hardest was retiming open sockets with `restore()` followed by a second `installWsLatency`. `ws-latency.ts` documents that sockets read the live delay, so this does apply the delay to connections that are already open. Added: `REATTACH_COHORT_READ_MS`, which sets both parties' `network.cohortQueryTimeoutMs` so the testing.md pointer can honestly say how to compare deadlines; a `cohortRead=` field in the RESULT line; and a mention of the optimystic coordinator trace in the doc comment.
- **Release note** added: the new 300 s default, why, its cost, and `whenStrandWritable` / `strand:writable`.
- **Backlog ticket** `debt-cadre-deadlines-sized-against-old-optimystic-bounds`: its row now says 300 000 ms, noting the value was 120 000 when that ticket was filed.

## Validation

- `yarn lint`: clean. `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/integration-tests typecheck`: clean. `yarn workspace @serfab/cadre-core build` and `yarn workspace @serfab/quereus-plugin-sereus build` both run after the last source edit, so the stale-build guard stays quiet.
- `yarn workspace @serfab/cadre-core test`: 140 files, 2282 passed, 1 skipped.
- `yarn workspace @serfab/integration-tests exec vitest run strand-chat-participants-converge -t "host is unreachable"`: passed (the no-peer case against the new message).
- `REATTACH_SYNC_MEASURE=1 REATTACH_ARMS=fresh REATTACH_COHORT_READ_MS=5000 … strand-reattach-first-sync-measure`: passed. Connected at 11.0 s, writable at 38.7 s, row readable at 56.9 s, all inside the recorded fresh band. This shows the override is accepted and the scenario still runs. Because 5000 is the default, it does NOT show that a different value changes behaviour.

## Tests

No new tests. The change is a constant, message text and documentation; the two existing message assertions were updated. The constant's value is not asserted anywhere, deliberately: a duration test would gate on machine speed, which is why the measurement scenario asserts nothing.

## Known gaps / for the reviewer

- The kept-store and empty-store arms were not re-run in this pass. The numbers come from the fix pass's logs, which I checked line by line against the RESULT lines in `tickets/.logs/reattach-*.log`.
- The measurement date is recorded as 2026-09-26, the local date on the logs. The implement ticket said 2026-09-27, which appears to be UTC.
- `whenStrandWritable` also defaults to this budget, so a caller who uses it "to keep waiting" without its own `timeoutMs` gets another 300 s. That is intended, but the message does not say so.
- The underlying slowness (syncing over a partial replica, and suspected periodic-timer stalls) is in optimystic and is carried by `tickets/blocked/report-reattach-over-partial-replica-to-optimystic`. Nothing here depends on it.
- The accepted-tradeoff revisit condition (report "no peer at all" at once if the gate can tell) is more valuable at five minutes. It is still only a `NOTE:`, not a ticket, by design.
