description: Two scenario tests check that a phone's change saved while it could reach nobody arrives at the other member once the phone restarts. They used to rely on a slow link happening to cut the phone off; they now cut it off on purpose by taking the other member offline, and the notes that described the old behaviour are updated.
prereq: strand-founder-commits-every-table-collection
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (file header, `FIRST_SYNC_MS` NOTE, `execReported`, `ringHoldsLive`, `hibernateFounderStrand`, `runJoinerRestartDelivers`, third arm's KNOWN FAILURE comment), docs/testing.md (the scenario's entry ~694), packages/cadre-core/src/strand-peer-redial.ts (NOTE ~234, stale sentence dropped), tickets/blocked/optimystic-write-made-alone-owes-no-one.md, tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md, tickets/backlog/debt-first-sync-gate-reads-every-strand-table.md
difficulty: medium
repro: verified
----
# The slow-link restart arms make their lone commit on purpose

## What changed

Since `strand-founder-commits-every-table-collection`, the joiner on the phone-shaped link (20 ms per-frame cap, event loop 70% busy) becomes writable while still connected to the founder. So its first commit goes to both members and no longer happens to be made alone. The fourth and fifth arms of `joiner-first-commit-over-slow-relay` depended on that lone commit, and failed at the commit.

`runJoinerRestartDelivers` now makes the lone commit on purpose. **Path taken: hibernate and wake.** The full-restart fallback was not needed. Steps:

1. Same setup as before, under the frame cap and the busy loop. The joiner becomes writable after about 45 s.
2. `hibernateFounderStrand`: the founder calls `A.hibernateStrand(strandId)` and the test asserts the strand reads `hibernating`. The sApp's `interactive` latency hint hibernates; `hibernateStrand` and `wakeStrand` work with the node's hibernation timers off (`HibernationManager.forceHibernate` checks only the hint). It then waits, bounded, for two things:
   - the joiner's strand node has no connection to the founder's strand peer (120 s bound);
   - **the joiner's FRET ring no longer holds the founder's strand peer as a live member** (`ringHoldsLive`: membership `member` and state not `dead`, read from `services.fret.exportTable()`; 180 s bound). This second wait was not in the ticket. Without it, the first run passed but the second failed at the commit with "Failed to get super-majority: 1/2 approvals". The founder's leave notice can be lost in the slow link's queue, and Optimystic builds a block's cohort from FRET's live members (`assembleServingCohort` → `fret.assembleCohort` with `isLiveMember`), so a disconnected founder that FRET has not yet marked dead is still in the cohort. In three runs with the wait, FRET marked it dead 18.3 s, 19.8 s and 19.4 s after the hibernate.
3. The joiner runs the seat batch through `execReported`, which picks that commit's report from the joiner's `strand:commit-durability` events by the table it wrote (`App.Seat`), because a multi-statement batch has no `returning StampId()`. **Asserted: `heldElsewhere === false`** (an absent report fails the assertion too). The old "founder held the joiner's rows when it stopped" log line is gone.
4. The joiner stops. On the fourth arm the frame cap and busy loop are lifted here.
5. `A.wakeStrand(strandId)`; the founder's `Database` is re-read from `A.getStrand(strandId)` after the wake.
6. The joiner restarts over `bHome` and re-claims the strand; wait for `holdsJoinerSeat` on the founder.

## Runs (2026-10-17, linked Optimystic 1.15.0 at `28e6e044`)

| Arm | Runs | Result |
|---|---|---|
| 4 (undelayed wake and restart) | 3 | 2 passed (about 85 s each; rows on the founder 0.8 s after the restart began, both). 1 failed at the commit, before the FRET-ring wait existed (see step 2). The final code ran once (the passing run with the ring wait). |
| 5 (wake and restart on the slow link) | 2, final code | Both passed (about 130 s each; rows on the founder 37.0 s and 38.3 s after the restart began). With `DEBUG=sereus:cadre:strand-redial` the member redial logged "no member connected; dialing 1 known member(s)" then "reconnected to a member" after the restart, so `docs/architecture.md`'s proof sentence for the redial still holds; unchanged. |
| 3 (`it.fails`) | 1 | Expected fail after 246 s. Writable at 45.9 s with the founder's strand peer connected; no "seat committed" line, so it failed at the commit. `it.fails` hides the error text; the implement ticket's earlier run recorded super-majority 1/2. |
| 1, 2, 6 | 1 | All passed. |

In every passing fourth and fifth arm run, the joiner's lone commit reported `local (1/2, unconfirmed [<founder strand peer>])`, `followed true`: it named the hibernated founder as owed. The sixth arm's founder write still reported `local (1/1, unconfirmed [])`, followed, with `strand:commit-held` 38.1 s after the joiner's restart. It does not name the stopped joiner.

Logs: `tickets/.logs/slow-link-restart-arms-lost-their-lone-commit.{arm4,arm4b,arm4c,arm5,arm5-redial,arm3,arms126}.log` (pruned after 14 days). `arm4b` is the failed run without the ring wait.

`yarn lint`, the integration-tests typecheck and the cadre-core build pass. cadre-core was rebuilt because a comment in its source changed.

## Doc and ticket edits

- Scenario header: "What it found" became "What the third arm shows" (writable while connected, the commit goes to both members, fails at super-majority 1/2, and the app is told). The drop-cycle paragraph is kept with the old "between windows, only the relay connected" ending removed. "Why the joiner's first sync takes minutes there" is removed. The fourth and fifth arm paragraphs describe the new steps and timings.
- `FIRST_SYNC_MS` NOTE: first sync about 45 s; the relay-ping-service sentence is dropped; the `it.fails` warning is kept.
- Third arm's KNOWN FAILURE comment: rewritten to the commit failure and the ping drop cycle. It no longer claims to reproduce `optimystic-write-made-alone-owes-no-one`.
- `docs/testing.md`: entry updated for all six arms and the new timings.
- `strand-peer-redial.ts` NOTE: dropped the sentence saying the third arm's joiner becomes writable with no member connected. The tripwire is kept.
- `blocked/optimystic-write-made-alone-owes-no-one`: "What Sereus does when it lands" now points at the sixth arm's `unconfirmed [...]`, with the fourth and fifth arms as a second place. Added a dated findings line. **For the human:** Optimystic's `a-write-made-alone-names-the-members-it-is-owed-to` is in Optimystic's `complete/` and tagged from v1.13.0, and Sereus's floors are `^1.15.0`. The fourth and fifth arms show the absent member named; the sixth arm's shape still shows `unconfirmed []`. That ticket may be closable, or the sixth arm's shape may be a remaining upstream gap; the line asks a human to decide. I did not move it.
- `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`: a short "Reproduction in Sereus" section names the third arm as its reproduction.
- `backlog/debt-first-sync-gate-reads-every-strand-table`: its evidence sentence now cites the arms' on-purpose lone commit, and says a read in that state is still unchecked.

## Tests

No new test. The fourth and fifth arms were redesigned in place:
- Fourth arm: a lone commit made by a joiner whose only other member is offline is delivered to that member by the joiner's restart (peer-join backfill), on an undelayed link.
- Fifth arm: the same, with the wake and the restart on the slow link, where only the strand member redial reconnects the two strand nodes.

## Known gaps, for the reviewer

- **Sample size.** The final code ran the fourth arm once and the fifth twice. The ring wait closed the one failure seen, and its premise is read from Optimystic's cohort assembly, but three runs do not prove it is never flaky.
- **The test reads FRET's table export structurally** (`exportTable().entries[].state` / `.membership`), as cadre-core's `strand-fret-addrs.ts` does. If FRET renames those fields, `ringHoldsLive` answers false at once and the wait passes immediately. The commit could then go to both members again and fail at super-majority, so it fails loudly, not silently.
- **`execReported` matches the table key case-insensitively** (`App.Seat`). The plugin keys reports `schema.table` from its own schema and table names. If no report matches, `alone` is `undefined` and the assertion fails with "no report recorded".
- **Not changed, not verified:** `strand-read-cost-over-relay.integration.ts`'s header says its opt-in phone arm is opt-in "because its first sync takes minutes". That is its own scenario's claim, which I did not re-measure.
- The third arm's failure text was not captured this run (`it.fails` swallows it). Only its shape was: writable while connected, and no commit line.
