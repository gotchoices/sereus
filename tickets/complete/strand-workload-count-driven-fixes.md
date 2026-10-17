description: Read the phone-link test's numbers (GitHub #48) and filed the fixes they call for: a proposal that network time limits stretch to measured response time, a proposal that Optimystic wait before re-sending, measured counts added to the FRET and ping-handler proposals, and a check that explains why the two sides ended with different data.
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (doc comment: corrected counts and the computed quantities; `DEADLINE_EVENTS` commit-retry pattern), tickets/blocked/decide-link-deadlines-from-measured-response-time.md (new), tickets/blocked/optimystic-retries-do-not-back-off.md (new), tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md (measured section appended, "What this does not fix" repointed), tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md (measured paragraph appended), docs/cadre-consistency.md (read-repair window row in "Deadlines Below Cadre")
----

# Phone-link counts read, and the fixes they call for filed

GitHub gotchoices/sereus#48. The prereq's measurement (phone arm run 2, 2026-10-17, sereus 1.16.0, Optimystic 1.15.0 `28e6e044`, p2p-fret 1.1.0 `6c04166`) was present, so no new phone run was made. Everything below was computed from the scenario's printed counts plus the timestamped debug log `tickets/.logs/strand-workload-on-a-phone-link-scenario.phone-2.debug.log` (pruned after 14 days). The scenario's doc comment is now the authoritative copy of both the counts and the quantities.

## The computed quantities

- **T_clean** (loopback busiest socket, frames a round ÷ 50): 472 and 476 → **9.4 and 9.5 s**.
- **T_phone** (phone busiest socket, 2 586 frames ÷ the 3 rounds that crossed the link, ÷ 50): **17.2 s**.
- **Excess share:** (17.2 − 9.5) / 17.2 = **45%**. FRET and libp2p upkeep are inside this frame figure. The request attribution below separates them.
- **Attribution, in requests beyond the clean workload over the 3 crossing rounds** (a consult = 1, a retried write = 3). Shares are given with FRET's and libp2p's own pings excluded (as the plan directs) and then included:
  - read-repair consults: 50 (43% / 26%). Of the 53 sent, 31 were re-asks after a silent consult and 16 fell inside an 81 s window.
  - commit retries: 24 (21% / 12%)
  - read retries: 0
  - circuit-relay hop streams (redials): 28 (24% / 14%)
  - block-transfer beyond loopback's rate: 13 (11% / 7%)
  - libp2p pings: 12 (excluded / 6%)
  - FRET pings that failed against a strand node: 67 (excluded / 35%)

## The row the table selected, and what was filed

The phone arm failed (3 failed writes, not converged), and T_clean 9.5 s ≥ 3.5 s, so the third row applies: the measured-deadline proposal, plus each traffic proposal whose share reaches a quarter.

- **Filed** `blocked/decide-link-deadlines-from-measured-response-time`: the principle text for `docs/architecture.md` ("The declared value"), with alternatives, numbers and how to confirm.
- **Filed** `blocked/optimystic-retries-do-not-back-off`, with three arms: `processBatches`, the `NetworkTransactor.get` retry round, and the read-repair consult after a silent one. Combined share 48% / 28%.
- **Extended** `blocked/fret-maintenance-deadlines-below-the-declared-link`: strikes by target, dead markings with times, why `revived` stayed 0, and the note that every strike resets FRET's stabilization interval to its base. Its "What this does not fix" section now points at the measured-deadline proposal.
- **Extended** `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`: 9 aborts, each a reset or EOF and none a timeout, and the redials they cost.
- **Not filed:** the read-repair window proposal (`decide-strand-read-staleness-bound`). See the deviation below.

## Where this departs from the plan, and why (check these first)

- **Read-repair window proposal not filed, consult re-asks moved into the retry proposal.** Planning assumed the window governs how often consults run. It does not on this link. A consult that finds the peer silent does not stamp the block (Optimystic `coordinator-repo.ts` ~1657, deliberately), so the next read consults again: during the rounds 53 consults were sent and all 53 were silent, and in the 180 s after, 224 of 224 were re-asks, about every 8.2 s per block. A window as long as the commit broadcast's retry span would have skipped at most 16 of the 53 (14% / 8%), below the quarter bar. The re-asks (31 of 53) share the retry arms' cause, so they became the retry ticket's third arm.
  If a human still wants the staleness bound on its own merits, the planned text was: a strand member serving a read from its held copy may lag a commit it missed by at most one strand read-repair window, derived from the declared link as the full span of Optimystic's commit-broadcast retry, `7 × responseTimeoutMs + 7 750 ms`, which is 81 250 ms at the default declaration (`responseTimeoutMs = max(10 000, 3 × linkRoundTripMs)`; the first broadcast asks twice, then 5 scheduled attempts with waits of 250, 500, 1 000, 2 000 and 4 000 ms). Once accepted, the implementation would set `readRepairWindowMs` in `STRAND_CLUSTER_POLICY` and through `link-budget.ts`, plus a row in the ladder table.
- **Attribution basis.** The plan said to compare the counts "against the outbound streams opened". That cannot work here: the stream counter records only opens that succeed, and most consults and every FRET ping never opened in time (85 consult triggers against 10 sync streams). So shares are computed over requests attempted: log events for requests that never opened, the counter for those that did. The sync, cluster, repo and block-transfer streams that did open (36) match the frame-counted loopback runs' rate for the same protocols over 3 rounds (35). Which denominator is used decides whether consults and retries clear the bar, so both are stated everywhere.
- **Counts corrected from the raw table.** Of the 85 strand consult triggers, 32 found a cohort of only the node itself and sent nothing, so 53 were requests. The control nodes' 224 consults were all `solo-self-skip` and cost no link traffic. `commit retried` 16 was 12 retries plus 4 `retry:setup-failed` lines. The pattern now matches `retry peer=` only, verified against the existing debug log (12 matches), not by a fresh phone run.
- **Docs row edited.** The plan said the "Deadlines Below Cadre" table would not change. I changed one row's description, not its value: the read-repair window row now says a silent consult does not count as a check. That fact is what misled planning, so I treated it as a correction.

## Known gaps

- **One measured phone run.** Run 1 was a setup failure. Every share comes from run 2 alone.
- **×3 per commit retry is an upper bound.** Retries coordinated by a node whose ring had marked the peer `dead` commit alone and send nothing.
- **Request shares ignore what each request costs in frames.** A failed open costs a few frames and a full request costs dozens; frames per request were not measured.
- **T values use the nominal 20 ms a frame.** With the event loop 70% busy, the shim releases fewer than 50 frames a second, so both T values understate. The row decision holds for any cost per frame above about 7.4 ms.
- **The control nodes' read source was not traced.** The control nodes' 224 consults put nothing on the link, so what drives those reads was left alone.
- **Repeated reads of strand membership blocks were not traced.** On B's strand node, strand membership blocks (`default/strand/Member`, `MemberPeer`) were consulted every 30 s during the rounds by something other than the workload's statements. These are part of the 53 consults.

## The diverged end state

It was reproduced, and the prereq's time match holds. FRET marked A's strand node `dead` at 10:39:53.8 and B's at 10:39:55.5. Rounds 4-8, from 10:39:57.0, each committed alone (3 on B, 2 on A), and those are exactly the 5 differing rows. Two mechanisms kept them from converging, and blocked tickets cover both:

- **Optimystic records no owed copy for a solo write** (`blocked/optimystic-write-made-alone-owes-no-one`). cadre-core's `peer-join-backfill.ts` marks a peer caught up once per runtime, so it does not push again on reconnect. Delivering a write made alone while running depends on Optimystic's record of owed copies.
- **Read repair could not heal them.** After the strand nodes reconnected at 10:40:04, every consult went silent (the deadline problem the measured-deadline proposal addresses).

No follow-up was filed.

## Validation

- `yarn eslint` on the scenario: clean. `yarn workspace @serfab/integration-tests typecheck`: clean.
- Loopback arm (`yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`): passed, 8 rounds, converged.
- The phone arm was not re-run. It takes about 15 minutes, and nothing here changes behaviour. The only code change is the counting regex.

## Tests

None added: no behaviour changed. The phone arm is the check each filed proposal names.

## Review findings

Read `ticket(implement): strand-workload-count-driven-fixes` first, then re-derived the numbers from `tickets/.logs/strand-workload-on-a-phone-link-scenario.phone-2.debug.log` (window: round 1's printed start 10:36:48.509 to round 8's end), and re-read every Optimystic and FRET site the new tickets cite at Optimystic `28e6e044` and FRET `6c04166`.

- **Fixed: one consult counted outside the rounds' window.** The derived table said 54 consults were sent, but the scenario's own event table gives 45 + 40 = 85 strand triggers, minus 32 that sent nothing, which is 53. Pairing each trigger with its outcome in the log confirms 53 sent, all silent. The extra one was a trigger 3 ms before round 1's start. The other 3 `cohort silent` lines in the 56 close consults started before round 1; the doc comment now says so. Shares that moved: consults 44% → 43% (pings excluded), retries combined 47% → 48%, FRET strikes 34% → 35%. Corrected in the scenario doc comment, both new blocked tickets and this ticket. None of these crosses the quarter bar, so the row the table selects and the filing decisions are unchanged.
- **Fixed: unlike protocol sets compared.** The loopback figure (38) beside the phone figure (36) included dcutr, FRET and identify streams that the phone figure did not. Like for like, it is 35. The phone run's own loopback arm opened only 17 of those streams, so the doc comment now gives both and makes no stronger claim than that.
- **Clarified: what counts as a re-ask.** The 31 re-asks reproduce only when a consult that sent nothing (a cohort of one, while the peer was marked `dead`) is skipped when finding the block's previous consult. With strictly the previous consult, it is 27. The wording in the scenario and the retry ticket now says "whose last consult to send a request went silent". It changes no share used for filing.
- **Verified, unchanged:** T_clean / T_phone / excess share arithmetic; `batch-coordinator retry peer=` matches 12 during the rounds (old pattern 16, the 4 extra being `retry:setup-failed` lines that follow a `retry peer=` line); all 12 sit on the write path (after `pend-error` or failed repo / block-transfer dials); `get:retry` fired once in the whole log, outside the rounds. Optimystic's commit-broadcast span `7 × responseTimeoutMs + 7 750 ms` (the first broadcast uses `commitBroadcastImmediateRetries` 1, so two requests; scheduled attempts deliver with 0 immediate retries; waits 250-4 000 ms over 5 attempts). The arming exit at `coordinator-repo.ts` ~1657 arms only for `cohort-too-small`, as both tickets say. `processBatches` ~111 / `get:retry` ~280 / `readRepairBlock` 939 / `startHeldBlockConsult` 1423 are where the tickets put them. FRET strikes by target (37 / 30 / 7), 47 `contact run cleared` and the 9 ping-failure aborts all reproduce. Doc anchors cited by the new tickets exist.
- **Deviation accepted: read-repair window proposal not filed.** The log bears it out. Every consult during the rounds was silent, and a silent consult leaves the block unchecked, so a longer window would have spaced only the 16 of 53 that fell inside it, below the quarter bar. The planned staleness-bound text is kept below in case a human wants it on its own merits.
- **Docs:** the `docs/cadre-consistency.md` row edit is a correct statement of current Optimystic behaviour (verified at the arming exit). `docs/architecture.md` correctly unchanged: its proposal is unaccepted.
- **Code / tests:** the only code change is the counting regex plus a comment explaining why; lint and typecheck clean. No test added or cut: nothing has behaviour to pin, and the phone arm stays the check each proposal names.
- **Tripwires:** none new.
- **Major findings / new tickets:** none. The off-by-one and the protocol-set mismatch were fixed in place; neither has a class behind it worth a ticket (this is a hand-read measurement, not code).

Validation in this pass: `yarn eslint` on the scenario and `yarn workspace @serfab/integration-tests typecheck` clean; loopback arm (`yarn workspace @serfab/integration-tests exec vitest run strand-workload-on-a-phone-link`) passed, 8 rounds, converged. Phone arm not re-run (about 15 minutes; this pass changed only comments and ticket prose).
