description: Two scenario tests check that a phone's change saved while it could reach nobody arrives at the other member once the phone restarts, but they relied on a slow link happening to cut the phone off, and it no longer does. Make those tests cut the phone off on purpose, and update the notes that describe the old behaviour.
prereq: strand-founder-commits-every-table-collection
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (file header ~1-84, `FIRST_SYNC_MS` NOTE ~145-156, `runJoinerRestartDelivers` ~355-420, third arm's KNOWN FAILURE comment ~520-523), packages/cadre-core/src/cadre-node.ts (`hibernateStrand` ~7646, `wakeStrand` ~7617), packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts (the one scenario that already hibernates and wakes a strand), docs/testing.md (~694-701, the scenario's entry), docs/architecture.md (~1321, the member redial's "Proof"), tickets/blocked/optimystic-write-made-alone-owes-no-one.md, tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md
difficulty: medium
repro: verified
----
# The slow-link restart arms must make their lone commit on purpose

## What changed, and the decision taken

Since `strand-founder-commits-every-table-collection`, the founder creates an empty collection for every declared table when it founds a strand. On the phone-shaped link (every dialed WebSocket frame held 20 ms, one behind another, event loop kept 70% busy) the joiner is now still connected to the founder's strand node when it becomes writable. Before, it became writable only after that connection had dropped (the file header explains why), and its first commit was saved on the joiner alone (optimystic `commit:solo-cohort`).

Its first commit now goes to a two-member cohort and needs both approvals. On this link it fails, because the relayed connection between the strand nodes is aborted by the ping monitor while the commit is in flight (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`).

**Decision: this is correct behaviour, not a regression.** `docs/strands.md` ("Joining: no writes before the first sync", "Writable does not mean connected") already describes it: a commit goes to the cohort the machine can reach. The app now gets an error it can retry, instead of a success that may never be delivered. The failure belongs to the link's drop cycle, which is tracked upstream. Nothing in cadre-core changes.

## Evidence (2026-10-17, optimystic `28e6e044`, after the prereq landed)

Third arm, run once as a plain `it` with `DEBUG='optimystic:db-p2p:coordinator-repo*,libp2p:connection-monitor*'` (log `tickets/.logs/slow-link-restart-arms-lost-their-lone-commit.arm3.log`, pruned after 14 days):

- The joiner was writable after 45.5 s, with connections to the relay and to the founder's strand node.
- The joiner's strand node logged no `commit:solo-cohort`. It logged `coordinator-repo:pend-error` "Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections)" 55 s after becoming writable, then `cancel-error`s with the same text for the next 2 minutes. The connection monitor logged "aborting connection due to ping failure" 3 s after writable and 4 more times during the pend. These lines do not name the peer, so it is not proven which connection each one aborted.
- The test failed after 293 s with the same error the fourth and fifth arms hit: `Transaction commit failed: Some peers did not complete: <joiner>[block:…](in-flight) cause=Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections), <founder strand>[block:…](in-flight) cause=The stream has been reset`.

The fourth and fifth arms fail at the same step (the joiner's `seatBatch('F', …)` before it stops). With the founder's empty-collection step disabled, the fourth arm passed (`tickets/.logs/strand-founder-commits-every-table-collection.arm4-without.log`). The first, second and sixth arms pass.

## What to build

### Fourth and fifth arms: take the founder's strand offline before the joiner writes

These two arms are the only ones where the machine that wrote alone is also the one that restarts, and its restart has to deliver the write (peer-join backfill from the restarted joiner). That is the phone case behind GitHub issue 44, and `docs/architecture.md` cites the fifth arm as the proof that the strand member redial reconnects two restarted strand nodes on the slow link. The sixth arm covers the other direction: the writer stays up and the other member restarts. Keep both arms; do not retire them.

Produce the lone commit deterministically instead of relying on the link:

1. Same setup as now (party homes, founder founds and seats, joiner forms and becomes writable, all under the frame cap and busy loop).
2. **Founder takes its strand offline**: `A.hibernateStrand(strandId)`. This stops the founder's strand libp2p node and keeps its store and its control node. It is the mobile background-entry path. Check that it hibernates at all: `hibernateStrand` does nothing for a strand whose latency hint never hibernates (`HibernationManager.hibernates`). If the scenario's strand never hibernates, use a full `A.stop()` and restart the founder over `aHome` instead (see the fallback below).
3. Wait until the joiner's strand node has no connection to the founder's strand peer, as the sixth arm does in the other direction (`waitUntil(() => !bStrand.libp2pNode!.getConnections().some(c => c.remotePeer.equals(founderStrandPeer)))`). Bound it, and print the wait.
4. Joiner writes `seatBatch('F', …)`. This is now a commit made alone. **Assert that premise instead of logging it.** `runWriteMadeAloneReportedThenHeld` reads `commitDurability(tx)` to check `heldElsewhere: false`, but it gets `tx` from a one-statement `returning StampId()`, which the three-statement seat batch has no equivalent for. Find the cleanest way to get the batch's commit report (an event or accessor on the strand database), and assert `heldElsewhere: false`. If there is none, the disconnect wait in step 3 is the premise, and the old "founder held the joiner's rows when it stopped" log line is removed: with the founder hibernated it cannot be read, and it no longer means anything.
5. Joiner stops.
6. **Founder wakes its strand**: `A.wakeStrand(strandId)`. Its strand node is rebuilt over its kept store, so the founder's `Database` object may be a new one. Re-read it from `A`'s strand instance rather than reusing `founded.instance.database`. On the fourth arm the frame cap and busy loop are lifted before this step, as now. On the fifth arm they stay in force.
7. Joiner restarts over `bHome` and re-claims the strand (`claimDiscoveredStrand`). The founder must be awake before this, so the reconnect is the joiner's restart reaching an awake founder. That is what the fifth arm proves about `strand-peer-redial.ts`.
8. Wait for `holdsJoinerSeat` on the founder's current database, as now.

The test names stay as they are. The function's doc comment changes from "the third arm's journey up to the joiner's stop" to the steps above.

**Fallback, if hibernate and wake do not work here** (the strand never hibernates, or a woken founder does not come back writable or readable): stop the founder entirely (`A.stop()`), then restart it over `aHome` with `startPartyNode` and re-claim its strand before the joiner restarts. Check first that a founder's own strand comes back as `strand:discovered` after a restart. Its `Strand` control row should bring it back, but no scenario here restarts a founder over kept storage. Say which path you took in the review handoff, and why.

### Third arm: keep `it.fails`, record what it now fails on

It still fails, so it stays `it.fails`. It now fails at the commit, not because rows were lost. Rewrite the KNOWN FAILURE comment to say so: on this link the joiner is connected to the founder when it becomes writable, so its first commit goes to both members, and it fails with "Failed to get super-majority: 1/2 approvals" when the ping drop cycle resets the founder's leg (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`). When the arm starts passing, that drop cycle no longer cuts a commit on this link: make it a plain `it`. The arm no longer reproduces `blocked/optimystic-write-made-alone-owes-no-one`. Do not say it does.

### File header and the `FIRST_SYNC_MS` NOTE

These describe the joiner as connected only to the relay when it becomes writable, and becoming writable only once it is cut off from the founder. Both are no longer true. Per AGENTS.md, docs describe the system as it is now. Name the ticket that changed it (`strand-founder-commits-every-table-collection`) and do not retell the old diagnosis.

- "What it found": the third arm's joiner becomes writable connected to the founder (45.5 s in the run above). Its first commit goes to a two-member cohort and fails when the drop cycle resets the founder's leg, so the app is told of the failure. Keep the paragraph explaining why the strand nodes keep losing each other (the ping handler's 10 s limit). That is still the cause, and it is now what fails the commit.
- "Why the joiner's first sync takes minutes there": remove it, or rewrite it from a fresh run. The 45 s first sync no longer waits for a cut-off. The arms 4 and 5 restart timings (48 s and 211 s) were measured on the old shape. Replace them with the figures from your runs.
- Fourth and fifth arm paragraphs: describe the new steps (founder hibernates, joiner writes alone, joiner stops, founder wakes, joiner restarts).
- `FIRST_SYNC_MS` NOTE: the sentence that removing the fixture relay's ping service "would make the arm pass by cutting the joiner off from the founder sooner" no longer holds. Rewrite or drop it. Keep the warning that a first sync past 600 s would keep the third arm's `it.fails` green for the wrong reason.

### Docs and blocked tickets that cite these arms

- `docs/testing.md` (~694-701): the entry says the third arm "makes the joiner commit with a cohort of only itself", and that the fourth arm restarts "that joiner". Update both to the new shape.
- `docs/architecture.md` (~1321): the fifth arm stays the member redial's proof. Check that the sentence is still true of the redesigned arm ("restarts a joiner … and the founder must then hold the rows the joiner committed alone").
- `tickets/blocked/optimystic-write-made-alone-owes-no-one.md`: its "What Sereus does when it lands" says to watch the third arm flip. The third arm no longer exercises this defect. Point it at what still shows it: the sixth arm's logged `unconfirmed [...]` names, or does not name, the stopped member as owed. The redesigned fourth arm's lone commit is a second place. Add one dated line to its findings saying why the third arm stopped reproducing it.
- `tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md`: add one line saying the third arm's commit failure is now this ticket's reproduction in Sereus, so adopting its fix should flip that arm.

## Validation

Each slow-link arm takes about 4 to 5 minutes. Run them one at a time in the foreground, and tee each into `tickets/.logs/`:

```
cd packages/integration-tests
npx vitest run joiner-first-commit-over-slow-relay -t "restarts over its kept storage" 2>&1 | tee ../../tickets/.logs/slow-link-restart-arms-lost-their-lone-commit.arms45.log
```

(`-t` matches both the fourth and fifth arms; run them separately if the pair approaches the 10-minute idle limit.) If the stale-build guard reports that `@serfab/cadre-core` is stale, `yarn workspace @serfab/cadre-core build` is in this repo and is fine to run. A stale `../optimystic` or `../quereus` dist is not yours to build (`tickets/rules/sibling-repos.md`). Also run the whole file once, so the third arm is shown still `it.fails` and the sixth arm still green. Run `yarn lint` and the integration-tests typecheck.

The working copy of the scenario file may show as modified with no content diff: the fix stage restored a temporary edit, and git sees a line-ending stat change. Ignore it.

## TODO

- Redesign `runJoinerRestartDelivers`: founder hibernates its strand, joiner waits to lose the founder's strand peer, joiner writes alone (assert `heldElsewhere: false` if the batch's commit report is reachable), joiner stops, founder wakes (re-read its `Database`), joiner restarts, founder holds the rows. Use the full-restart fallback only if hibernate and wake do not work, and say so.
- Run the fourth and fifth arms; both green. Record the restart-to-rows timings in the file header.
- Rewrite the third arm's KNOWN FAILURE comment (fails at commit: super-majority 1/2, founder leg reset by the ping drop cycle). Keep `it.fails`.
- Rewrite the file header's "What it found", "Why the joiner's first sync takes minutes there", and the fourth and fifth arm paragraphs. Fix the `FIRST_SYNC_MS` NOTE.
- Update `docs/testing.md`'s entry for this scenario. Check `docs/architecture.md`'s fifth-arm proof sentence.
- Add the one-line notes to `blocked/optimystic-write-made-alone-owes-no-one` and `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`.
- Run the whole scenario file once, then `yarn lint` and the typecheck.
