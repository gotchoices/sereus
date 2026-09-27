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

# Size the first-sync wait for a re-attach, and stop the error blaming reachability

## What landed

A machine that has never received a strand's data must not write to it, so `CadreNode.addStrand` holds the strand database back until that data arrives from another member (the "first-sync gate", `strand-first-sync-gate.ts`). When the wait runs out, `addStrand` rejects with the retryable `StrandAwaitingFirstSyncError`.

- `DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS` went from 120 s to 300 s. The earlier value was sized from fresh joins only. A re-attach over a store that kept only part of the strand took 64-79 s in the harness, one outside report took about 150 s, and a real phone's fresh join through the public relay took 178 s. The constant's doc comment is the single home for the figures, the reasons for 300 s over 240 s, and the history. The accepted-tradeoff `NOTE:` was updated in place: a strand with no reachable member now takes five minutes to report.
- The error text no longer says "no member has been reachable". It says the data has not arrived yet, gives both possible causes (no member reachable, or a slow link still syncing), and names `addStrand`, `whenStrandWritable(strandId)` and `strand:writable` as ways to keep waiting.
- The module doc, `docs/strands.md` and `types.ts` now say that "has synced before" is decided by what the local store holds, so a machine that comes back without the Header collection is gated like a joiner. The "Owned by" paragraph now matches the code: the gate is built for every launch and armed only when the first probe fails.
- Every other statement of the number now points at the constant (`link-budget.ts`, `types.ts`, `cluster-size.ts`, `docs/strands.md`, `docs/reference-app-rn.md`, `docs/architecture.md`).
- `docs/testing.md` points at the committed opt-in scenario `strand-reattach-first-sync-measure.integration.ts`, which gained `REATTACH_COHORT_READ_MS` and a `cohortRead=` field on its RESULT line.
- Release note added.

## Review findings

- **Recorded figures vs. logs.** I compared every number in the constant's doc comment with the RESULT lines in `tickets/.logs/reattach-*.log`. They all match: fresh 38.7/38.7/56.9 s; empty-store 38.7-56.8 s over 4 runs, including the 20-missed-writes run; kept-store 3 of 8 ungated at about 5.6 s and 5 of 8 gated at 64.1-78.7 s; row readable 140.5-162.5 s; connected at about 11 s in every arm. The ratio arithmetic is also correct (300/79 ≈ 3.8, 300/150 = 2, 300/178 ≈ 1.7, 240/178 ≈ 1.35). The release note's "about 80 s" also matches.
- **Code claims in the new docs.** I checked each one against `strand-instance-manager.ts`. The gate is constructed for every launch (around line 764) and started only when the probe fails and the launch is not a founder (around line 783). `publishDatabase` calls `gate.open()` on every publish, including ungated launches and `ensureFounderBootstrap`. That confirms the rewritten "Owned by" paragraph, the `open()` doc and the new log line. The `ws-latency.ts` claim is also correct: sockets read the live delay per frame (line 109, line 301), so `restore()` followed by a reinstall does retime the connections already open.
- **Stale 120 s / reachability wording.** I grepped `packages/*/src`, `docs/` and open tickets for `120 s`, `120_000`, "two minutes", "no member … reachable" and "no host is reachable". The only remaining uses of 120 are unrelated vitest timeouts and libp2p upgrade timeouts. The rest of the 120 s mentions are deliberate history in the constant's doc comment and in the backlog ticket's table row. Every consumer of `strandFirstSync` / `StrandAwaitingFirstSyncError` (the harness fixture, the RN chat helper, the relay and e2e scenarios) either points at the constant or sets its own budget.
- **Effect on harness tests.** I checked whether any integration scenario relied on the 120 s default and would now hit a vitest timeout before the named rejection. None does. The three scenarios that set `strandFirstSync` set their own `timeoutMs`, and the others attach with `awaitFirstSync: false` or run on direct links. Nothing to change.
- **Scenario code.** `withCohortReadDeadline` applies the override to both parties, and `integerEnv` rejects bad input and ignores env when not measuring. `WRITABLE_WAIT_MS` (600 s) is above the new default, so the measurement is not capped by it. No defects found.
- **Tests.** No tests were added, and I cut none. The two updated message regexes pin the retryable-rejection wording on the no-peer path, which is contract, not restatement. Leaving the constant's value unasserted is correct: a duration test would gate on machine speed.
- **Source hygiene.** `strand-first-sync-gate.ts` is 352 lines (`wc -l`). The constant's doc comment is long, but it is the file's single home for the measurements and was designated as such. No comments narrate code.
- **Implementer's open gap: `whenStrandWritable` also defaults to 300 s.** This is intended, and the default is stated in the `whenStrandWritable` doc (`cadre-node.ts` around line 4686). The error message stays silent on it, and that is acceptable. No action.
- **Accepted tradeoff.** The `NOTE:` on the constant (slow report when no peer is reachable at all) was updated in place, and its revisit condition is unchanged. The decision was not re-litigated.
- **Minor / major / tripwire findings.** None. Nothing required an inline fix, a ticket or a new `NOTE:`. The underlying slowness sits in optimystic and is already carried by `tickets/blocked/report-reattach-over-partial-replica-to-optimystic`.
- **Validation (this pass).** `yarn lint`: clean. `yarn workspace @serfab/cadre-core test`: 140 files, 2282 passed, 1 skipped. `yarn workspace @serfab/integration-tests typecheck`: clean. `strand-chat-participants-converge -t "host is unreachable"`: passed against the new message. I did not re-run the kept-store and empty-store measurement arms; they take minutes each and assert nothing, and their recorded figures were checked against the logs above.
