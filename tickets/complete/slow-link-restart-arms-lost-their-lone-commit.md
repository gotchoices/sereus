description: Two scenario tests check that a phone's change saved while it could reach nobody arrives at the other member once the phone restarts. They used to rely on a slow link happening to cut the phone off; they now cut it off on purpose by taking the other member offline, and the notes that described the old behaviour are updated.
prereq: strand-founder-commits-every-table-collection
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, docs/testing.md, docs/strands.md, packages/cadre-core/src/strand-peer-redial.ts, tickets/blocked/optimystic-write-made-alone-owes-no-one.md, tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md, tickets/blocked/report-libp2p-websockets-buffered-amount.md, tickets/backlog/debt-first-sync-gate-reads-every-strand-table.md
----
# The slow-link restart arms make their lone commit on purpose

## What landed

Since `strand-founder-commits-every-table-collection`, the joiner on the phone-shaped link (20 ms per-frame cap, event loop 70% busy) becomes writable after about 45 s while still connected to the founder, so its first commit goes to both members and is no longer made alone. The fourth and fifth arms of `joiner-first-commit-over-slow-relay` depended on that lone commit.

`runJoinerRestartDelivers` now makes it on purpose:

- `hibernateFounderStrand`: the founder calls `hibernateStrand` (the mobile background-entry path) and the test asserts the strand reads `hibernating`. It then waits until the joiner's strand node has no connection to the founder's strand peer, and until the joiner's FRET ring no longer holds that peer as a live member (`ringHoldsLive`, the same rule as FRET's `isLiveMember`). The second wait is needed because Optimystic builds a block's cohort from FRET's live members; a disconnected founder that FRET has not yet marked dead is still in the cohort, and the commit then fails with "Failed to get super-majority: 1/2 approvals".
- `execReported` runs the seat batch and picks its `strand:commit-durability` report by the table it wrote (`App.Seat`); the arm asserts `heldElsewhere === false`.
- The joiner stops; on the fourth arm the frame cap and busy loop are lifted; the founder wakes its strand; the joiner restarts over its kept storage and re-claims the strand; the founder must then hold every row.

The scenario header, the `FIRST_SYNC_MS` NOTE, the third arm's KNOWN FAILURE comment (now: commit fails at super-majority 1/2 when the ping drop cycle resets the founder's connection), `docs/testing.md`, a NOTE in `strand-peer-redial.ts`, and three tickets were updated in the implement pass (`ticket(implement): slow-link-restart-arms-lost-their-lone-commit`).

Runs: implement pass, fourth arm 2 of 3 passing (the failure was before the ring wait existed), fifth arm 2 of 2, third arm failed as expected, arms 1, 2 and 6 passed. Review pass: fourth arm passed again (86 s; ring dropped the founder 20.0 s after the hibernate; rows on the founder 0.8 s after the restart began; report `local (1/2, unconfirmed [<founder strand peer>])`, followed), and the loopback arm passed.

## Review findings

Read the implement diff first, then the whole scenario file, every doc and ticket that names the scenario, and the FRET and cadre-core code the new helpers depend on.

**Correctness, checked and holding.**
- `ringHoldsLive` matches FRET's `isLiveMember` (`../Fret/packages/fret/src/service/live-member.ts`: `membership === 'member' && state !== 'dead'`). `isLiveMember` is not exported from `p2p-fret`'s entry, and integration-tests does not depend on `p2p-fret`, so the structural copy, the same pattern as cadre-core's `strand-fret-addrs.ts`, is the right call.
- `execReported` relies on `strand:commit-durability` being emitted synchronously inside the commit; `types.ts` documents that it is. Filtering by `App.Seat` is sound, because cadre-core's membership writers write only `Strand.*` tables. That addresses the concern `docs/strands.md` → "A commit's durability" raises about taking every report that arrived during an `exec`.
- `hibernateStrand` is a silent no-op for a strand whose latency hint never hibernates; the arm's `expect(... 'hibernating')` catches that case loudly.
- Cleanup: the `finally` stops both nodes, the relay, the busy loop and the link on every path, including a failure between the hibernate and the wake.

**Docs, fixed in this pass.**
- `docs/strands.md` → "Writable does not mean connected" said a writable machine with no peer connected commits alone. The arm showed that this is not true right after a member disconnects: that member stays in the cohort until FRET marks it dead (about 19 s on the phone-shaped link), and a commit in that window fails. Added a labelled sub-paragraph, "Not at the moment a member disconnects".
- `tickets/blocked/report-libp2p-websockets-buffered-amount.md` pointed to the scenario header section "Why the joiner's first sync takes minutes there", which the implement pass removed. Replaced that pointer with a statement of what the section said and why the scenario no longer depends on it.
- Other references checked and still accurate: `docs/architecture.md`'s proof sentence for the strand member redial, `peer-join-backfill.ts`'s NOTE, `strand-peer-redial.ts`'s header, `strand-first-sync-gate.ts`'s NOTE, and `ws-latency.ts`. `strand-moves-between-cadres.integration.ts` cites an older 24.5 s delivery time for its 90 s bound; the current figures (0.8 s and 37 s) are within that bound, so I left it. The opt-in phone arm of `strand-read-cost-over-relay.integration.ts` is still described as taking minutes; that is that scenario's own claim, which I did not re-measure.

**Code, fixed in this pass.**
- DRY: `runJoinerFirstCommit` repeated the body of `holdsJoinerSeat` inline. It now calls the helper (the loopback arm passed afterwards).

**Tripwires.**
- The third arm's `it.fails` stays green only because a ping drop lands while the commit is in flight. That happened in 2 of 2 runs. A single red run could just be timing. Parked as a `NOTE:` at the `it.fails`.
- If FRET renames the exported `state` / `membership` fields, `ringHoldsLive` returns false at once. The test would then fail loudly at the super-majority commit, not pass silently. No note added; the implement handoff already records this, and it is not a silent failure.

**Tests.** No tests added or cut. The fourth and fifth arms were redesigned in place, and each pins a separate contract: delivery by peer-join backfill on an undelayed link, and delivery by the strand member redial on the slow link. The sample is still small (fourth arm: 2 runs of the final code; fifth arm: 2). Every run so far has passed, with the ring wait between 18 and 20 s.

**Left for a human (unchanged from implement).** `blocked/optimystic-write-made-alone-owes-no-one`'s 2026-10-17 findings line asks whether that ticket can close. The fourth and fifth arms' lone commit names the absent founder as owed. The sixth arm's founder write still reports `1/1, unconfirmed []`.

**Checks.** `yarn lint` and the integration-tests `typecheck` script pass. No cadre-core source changed in this pass.

**Empty categories.** Performance, resource use and type safety: nothing found. The new helpers poll at 100 ms within bounded waits, use no `any`, and narrow the FRET service with a type guard.
