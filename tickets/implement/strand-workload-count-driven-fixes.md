description: Read the phone-link test's measurement of which time limits fire and how often (GitHub #48), and from those numbers file the fixes that stop a slow link from filling up with retries: proposals to Optimystic and FRET, and to the project's own design rules where they say nothing, plus a check of why the two sides ended with different data.
prereq: strand-workload-on-a-phone-link-scenario
architecture: docs/cadre-consistency.md#deadlines-over-optimystics-reads-and-commits
files: packages/integration-tests/src/scenarios/strand-workload-on-a-phone-link.integration.ts (its doc comment holds the measurement), packages/quereus-plugin-sereus/src/cluster-size.ts (`STRAND_CLUSTER_POLICY`), packages/cadre-core/src/link-budget.ts, docs/architecture.md ("The declared value" ~1984), docs/cadre-consistency.md ("Deadlines Below Cadre", the table of every limit a strand runs under), tickets/blocked/fret-maintenance-deadlines-below-the-declared-link.md, tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md, tickets/blocked/optimystic-write-made-alone-owes-no-one.md, ../optimystic/packages/db-core/src/utility/batch-coordinator.ts (`processBatches` ~111-164, read only), ../optimystic/packages/db-core/src/transactor/network-transactor.ts (`get` retry ~275-310, read only), ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts (read repair ~1272, ~1426-1458, read only)
----

# File the fixes the phone-link measurement calls for

GitHub gotchoices/sereus#48. On a phone-shaped link (every outbound WebSocket frame held 20 ms behind the one before it, event loop 70% busy) a two-member strand's steady work collapses: rounds of 11-169 s against 0.1 s on loopback, failed operations, many requests abandoned to deadlines and retried, and in one run the two sides ended disconnected holding different rows. The prereq commits the reporter's scenario and runs its phone arm once with debug logging. This ticket reads those numbers and files what they call for.

Most of what this ticket produces is tickets, not code: every fix the counts can call for is either upstream (Optimystic, FRET) or a change to a design rule the docs do not yet state, and both of those go to `blocked/` as proposals. That was settled during planning (below), so the implementer's job is to compute the quantities defined here, apply the table, and write the proposals with the measured numbers in them.

## What planning settled from the code (Optimystic `28e6e044`, FRET `6c04166` = p2p-fret 1.1.0)

Recheck these sites if either sibling has been bumped since (`docs/cadre-consistency.md` → "Deadlines Below Cadre" names the versions its table was read at). The sibling repositories are read only: read their source, never build or run anything in them.

- **Cannot fire in this workload:** the inbound authorization timeout (cadre's predicates are synchronous), Optimystic's cohort-topic frame read and signature collection (only with `strandReactivity`, off in the scenario). A `read timed out` line in the scenario's log is FRET's own request.
- **The commit retry is bounded per chain.** `processBatches` retries a failed batch until the transaction expires, excluding each failed coordinator; once every peer and self are excluded, `findCoordinator` throws `No coordinator available (all candidates excluded)`. On a two-member strand a chain is B, then self. Two problems remain: the retry fires at once with no backoff, and the self-coordinated retry sends the same cluster transaction to the same slow B, whose earlier request is probably still in the link's send queue. The read path's `get:retry` is one extra round. Above Optimystic, `control-write-retry.ts` and the app retry too.
- **`Transaction expired` is a consequence, not a cause.** It fires when a transaction outlives its own budget (170 000 ms at the default declaration).
- **The read-repair window can be set from cadre, but any value is a new design rule.** `readRepairWindowMs` (Optimystic's default 10 000 ms; cadre sets it on neither network) makes a read of a held block last checked more than the window ago start a background consult of the block's cohort. Phone rounds are 11-169 s apart, so every table read of every phone round can start one consult per held block; loopback rounds are 0.1 s apart and start almost none. `STRAND_CLUSTER_POLICY` could set it. But the window is the longest a held copy that missed a commit broadcast goes unnoticed, and no doc states such a bound for strand reads (`docs/cadre-consistency.md` explains why read repair matters at a cohort of two, and states no staleness limit). So a strand window would be the first stated staleness bound: **if the counts call for it, it goes to `blocked/` as a proposal, not to code here.**
- **Declaring a larger link** (`linkRoundTripMs` on a phone deployment) is not a fix under any outcome: the declaration is fixed and the queue is not, so it moves the point of collapse instead of removing it. Do not file it, and do not document it as a workaround unless a phone run with a larger declaration was actually made and shows it helps (not required here).
- **FRET's fixed 2 s maintenance ping** is already proposed upstream (`blocked/fret-maintenance-deadlines-below-the-declared-link`): three missed pings mark the other member `dead`, which removes it from every cohort. Extend that ticket with the counts; do not file a second FRET ticket.

## Step 1: find the measurement

The prereq writes its numbers into the scenario file's doc comment and appends them to this ticket under `## Measured`. Use whichever is present (the doc comment is the authoritative copy).

- **Present:** go to step 2.
- **Absent, but the scenario file exists:** the prereq's agent could not finish the phone run inside its budget. Run it here, as the prereq ticket specifies: the loopback arm once with `WS_FRAME_STATS=1` (leave `STRAND_WORKLOAD_PHONE` unset), then the phone arm once with `STRAND_WORKLOAD_PHONE=1 DEBUG='optimystic:*,libp2p:connection-monitor*'`, in the foreground, `| tee tickets/.logs/strand-workload-count-driven-fixes.phone.log`. The arm prints a progress line each minute, which keeps the runner's idle timer alive; it takes about 15 minutes. Record the results in the doc comment exactly as the prereq ticket lists them.
- **The run ends in setup failure** (no rounds ran): run it once more. If it fails again, stop: record in the review handoff that no measurement exists and file nothing from the code alone.
- **The scenario file does not exist:** the prereq did not land. Stop and say so in the handoff.

## Step 2: compute the quantities

From the measurement:

- **`T_clean`** — the loopback arm's busiest socket's frames per round, divided by 50 (the phone link's 20 ms per frame). The seconds one round of the workload, with nothing firing, occupies a phone socket.
- **`T_phone`** — the same for the phone arm's rounds.
- **Excess share** — `(T_phone − T_clean) / T_phone`: the part of what the phone link carried that the clean workload did not need. FRET and libp2p upkeep over the phone arm's longer wall time is in this excess too; subtract the per-protocol stream counts for FRET and ping over the rounds if they are a visible part of it, and say so.
- **Attribution of the excess** — the pattern × namespace table's `read-repair consult`, `commit retried` and `get retried` counts against the outbound streams opened during the rounds, per protocol. Count a consult as one cohort request per consult, a read retry as one, and a commit retry as the requests one write costs on a two-member cohort (pend, commit, and the broadcast to the other member, so three); write the per-type estimate into the proposals with this rule stated.

Then the deadline the workload runs against: **7 s**, the per-peer cohort read (`cohortQueryTimeoutMs`), the smallest deadline a strand read or write waits on that follows the declared link. FRET's 2 s ping is below it and fixed; its case is the FRET ticket's.

## Step 3: decide

| what the numbers show | output |
| --- | --- |
| The phone arm passes (no failed operation, converged) | Only the upstream proposals the counts still justify (the FRET counts, a retry proposal if retries still fired). |
| `T_clean` below 3.5 s (half the cohort read: the clean workload leaves room for the queue to grow before a read times out) | **Reduce the traffic.** If consults are at least a quarter of the excess: the read-repair window proposal. If retries are at least a quarter: the retry backoff proposal. Both if both. If neither reaches a quarter, say what the excess is made of and file nothing for it. |
| `T_clean` 3.5 s or more | The work alone builds a queue that crowds a deadline counted in declared round trips, so cutting traffic cannot be enough. **The measured-deadline proposal**, and the traffic proposals as well wherever their share reaches a quarter: they still shorten the queue. |

A quarter is the bar because a source smaller than that cannot by itself bring a queue that overran a deadline back under it; state the computed shares in every proposal so the human can weigh a source near the bar.

## The proposals, settled except for their numbers

Each goes to `blocked/` with the proposal form (blocked category and what unblocks it on the first line; the recommended text; the alternatives rejected and why; what happens if nothing is done; how reversible it is), and carries the measured numbers from step 2.

**Read-repair window for strands** (`blocked/decide-strand-read-staleness-bound`). Category: the specification is silent. Proposed text for `docs/cadre-consistency.md`, beside the explanation of read repair: a strand member serving a read from its held copy may lag a commit it missed by at most one strand read-repair window, and that window is derived from the declared link as the full span of Optimystic's commit-broadcast retry (every attempt's request deadline plus the intervals between them, read at `commitBroadcastRetry*` and `responseTimeoutMs`; by the ladder's values somewhere between one and two minutes at the default declaration; compute it exactly at the site and state it). Reason: read repair is the backstop for a broadcast that gave up, and a window shorter than the time the broadcast is still retrying spends consults on copies the broadcast is still delivering. Alternatives to list: keep Optimystic's 10 s (the status quo: every phone round consults every held block); a fixed larger value (not derived, so it fails again on a slower link); `readRepairMode: 'off'` (no bound at all, rejected). Reversible: one policy field. Once accepted, the implement work is setting `readRepairWindowMs` in `STRAND_CLUSTER_POLICY` (and through `link-budget.ts` for a host that declares its own link) and adding its row to the ladder table.

**Retry backoff in Optimystic** (`blocked/optimystic-retries-do-not-back-off`). Category: a dependency outside this repo. One ticket, two arms, because both are the same cause (a retry adds a request to a queue that the request it replaces is still sitting in): `processBatches`' coordinator retry and `NetworkTransactor.get`'s retry round. Proposed change: wait before each retry, starting at one declared round trip and doubling, inside the transaction budget; and when the next coordinator's transaction must reach a peer whose request just timed out (on a two-member cohort the self-coordinated retry always must), wait at least as long as that request was outstanding before sending again. Unblocks when Optimystic ships it in a version Sereus can adopt.

**Deadlines from measured response time** (`blocked/decide-link-deadlines-from-measured-response-time`). Category: a change to a stated design principle. Proposed text for `docs/architecture.md` → "The declared value": a link deadline is the larger of its count of declared round trips and the same count of the peer's measured response time, where the measured time is a smoothed average plus four times its smoothed variation, as TCP sizes its retransmit timer (RFC 6298); the declared value stays the floor and the starting estimate before any sample exists. FRET already records each ping's `rttMs`. Name the alternatives (declare a larger link per deployment; a fixed queue allowance) and why they fail on a queue that grows with traffic. Say which project would hold the estimator (Optimystic and FRET own the deadlines that fire) and that this proposal is the principle, not the mechanism.

**FRET.** Append the measured `contact strike` and `revived` counts, and the namespace they were logged under, to `blocked/fret-maintenance-deadlines-below-the-declared-link`.

**Cohort-topic deadlines.** Only if a run with strand reactivity on shows them; this measurement runs with it off, so normally nothing.

## The diverged end state

If the measurement reproduced the two sides ending with different rows: check whether the chain `contact strike` (three in a row) → peer `dead` → `commit:solo-cohort`, together with `blocked/optimystic-write-made-alone-owes-no-one` (a write made alone is never re-sent to the member who missed it), accounts for every differing row. Match by time: each differing row's write should fall after a `dead` marking and before the matching `revived`. File a follow-up (`bug-` in `backlog/`, with `repro: verified`) only for rows neither covers. If the run did not reproduce it, say so and file nothing.

## Edge cases & interactions

- **No measurement after two setup failures, or no scenario file.** File nothing from the code alone; the handoff says why. Verified by inspection of the handoff.
- **The measuring run and the runner's idle timeout.** Foreground, `tee` into `tickets/.logs/`, no silent redirect; the scenario's per-minute progress line covers a slow round. If one run cannot finish in the agent's budget, say how far it got and leave the measurement to review or a human.
- **A stale sibling build.** If the stale-build guard reports a sibling's `dist` is stale, stop the run and record that this ticket is blocked on the sibling's build (`tickets/rules/sibling-repos.md`). Never build a sibling.
- **Sibling version drift.** If `@optimystic/*` or `p2p-fret` moved past the versions above, reread each cited site before quoting it in a proposal; a proposal citing a line that changed is not actionable.
- **A source just under the quarter bar.** Report its share in the proposals that are filed; do not file a separate ticket for it.
- **Both rows apply in spirit** (`T_clean` near 3.5 s). The table's threshold decides; state `T_clean` in the proposal so the human sees how close it was.
- **The phone arm passes.** The prereq makes it a plain `it`; this ticket then files only what the counts still show, and the review handoff says the arm passes.
- **Overlap with open tickets.** Before writing each proposal, grep the open stages for its sites (`processBatches`, `readRepairWindowMs`, `linkRoundTripMs`) and append to a ticket that already claims one instead of filing beside it.
- **The ladder table** (`docs/cadre-consistency.md` → "Deadlines Below Cadre") changes only when a value in this repo changes. Every output here is a proposal, so the table is not edited by this ticket; the proposal for the read-repair window names the row its implement ticket will add.

No new test: this ticket changes no behaviour, and the scenario is the check every resulting fix names.

## TODO

- Find the measurement (step 1); run the arms if it is missing, and record the results in the scenario's doc comment.
- Compute `T_clean`, `T_phone`, the excess share and its attribution (step 2); write them into the scenario's doc comment beside the measurement.
- Apply the table (step 3) and write the proposals it selects into `blocked/`, each with its numbers.
- Append the FRET counts to `blocked/fret-maintenance-deadlines-below-the-declared-link`.
- If the end state diverged, match the differing rows against the solo-commit chain and file a follow-up only for what neither blocked ticket covers.
- Hand off to review with the computed quantities, the row the table selected, and the list of tickets filed or extended.

## Measured

Taken 2026-10-17 by `strand-workload-on-a-phone-link-scenario`, on sereus 1.16.0 (`9e16a3e8` plus the scenario), Optimystic 1.15.0 (`28e6e044`), p2p-fret 1.1.0 (`6c04166`): the versions planning read, so the cited sites need no recheck unless a sibling moves again. The scenario's doc comment is the authoritative copy, with the full pattern × namespace table; this is the part step 2 needs.

- **Runs.** Phone arm twice under `DEBUG='optimystic:*,libp2p:connection-monitor*'` with `WORKLOAD_SHOW_DEBUG=1` (the debug lines kept in the log, so events can be matched by time). Run 1 ended in setup failure: the joiner's seat transaction failed as a partial commit. The scenario now retries the seat (`seatJoiner`, up to 4 attempts), and run 2 measured the rounds. Loopback ran twice more with `WS_FRAME_STATS=1`.
- **Logs** (in `tickets/.logs/`, pruned after 14 days): `strand-workload-on-a-phone-link-scenario.phone-2.log` (scenario output) and `.phone-2.debug.log` (every debug line, timestamped); `.phone-1.log` / `.phone-1.debug.log` (the setup failure); `.frame-stats-1.log`, `.frame-stats-2.log` (loopback frame counts).
- **Rounds.** Loopback: 8 in 0.6-1.2 s, no failure, converged at once. Phone: 90.6, 94.8, 3.1 s, then 0.01-0.02 s each for rounds 4-8; the writes of rounds 1-3 failed (`Some peers did not complete`), no read failed. Only rounds 1-3 crossed the link: rounds 4-8 each committed alone.
- **Frames over the rounds, busiest dialed socket.** Loopback with `WS_FRAME_STATS=1`: 3 778 and 3 806 frames (472 and 476 a round; 7 427 and 7 503 frames over all sockets). Phone: 2 586 frames (7 242 over all sockets), worst observed send wait 17 272 ms. Per round, divide the phone figure by the 3 rounds that crossed the link, not 8, and say so.
- **Deadline events over the phone rounds.** Read-repair consult 309: A control 116, B control 108, A strand 45, B strand 40. **224 of the 309 are on the control nodes**, whose databases the workload's statements do not read (what drives those reads was not traced); `STRAND_CLUSTER_POLICY` does not reach them. FRET contact strike 74; cohort silent 56; stream reset 31; commit retried 16; ping failure 9; FRET peer marked dead 5; solo commit 5; no coordinator 4. Read timed out, get retried, transaction expired, read-repair deferred and FRET revived were all 0. Loopback: 7 read-repair consults on A's strand node, everything else 0.
- **Outbound streams the strand nodes opened over the phone rounds.** Circuit-relay hop A 16, B 12; block-transfer B 9, A 5; sync B 8, A 2; libp2p ping A 7, B 5; cluster B 6, A 4; repo 1 each; no FRET stream succeeded (the counter counts only opens that succeed). Loopback rounds: B sync 38, B cluster 32, A cluster 13, A sync 8, A dcutr 2, A block-transfer 2, and one FRET ping, FRET neighbors and identify push from each side.
- **Seating on the phone arm.** Writable 45.4 s after joining; the seat transaction took 94.4 s on its first attempt; seated 163.9 s after joining.
- **End state.** A's strand node held 0 connections to B's after the rounds. Not converged after 180 s: A held Ledger r5, r7; B held Invoice r4, r6, r8; r1-r3 on neither.
- **The diverged rows, matched by time** (the "diverged end state" section above). FRET marked A's strand node `dead` at 10:39:53.8 (its third contact strike) and B's at 10:39:55.5. Rounds 4-8 started at 10:39:57.0, and each logged `commit:solo-cohort` on its writer: 3 on B's strand node, 2 on A's. Those five rows are exactly the rows that differ. The strand nodes reconnected at 10:40:04, and the five rows were not exchanged in the following 180 s. So the chain "contact strike → dead → solo commit", together with `blocked/optimystic-write-made-alone-owes-no-one`, accounts for every differing row in this run. Peer ids in that run: A strand `12D3KooWSB2r…`, B strand `12D3KooWF67X…`, relay `12D3KooWANBU…` (FRET marked the relay `dead` twice too). The scenario now prints every node's peer id at setup.
