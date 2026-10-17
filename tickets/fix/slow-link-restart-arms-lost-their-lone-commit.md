description: Now that the founder creates storage for every table when it founds a strand, a joining machine on a very slow link is connected to the founder by the time it may write, so its first write goes to both machines and fails when that link drops the connection, where before it was saved alone. Two scenario tests that were built on the old "saved alone" behaviour now fail and need a decision on what they should test.
prereq: strand-founder-commits-every-table-collection
architecture: docs/strands.md#joining-no-writes-before-the-first-sync
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (the third arm's KNOWN FAILURE comment and `it.fails` ~527-535, `runJoinerRestartDelivers` ~368-428, the fourth and fifth arms ~537-543, the file header's "What it found"), tickets/blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline.md, tickets/blocked/optimystic-write-made-alone-owes-no-one.md
repro: verified
----
# The slow-link restart arms no longer start from a commit made alone

## What fails

`packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts`, on the phone-shaped link (every dialed WebSocket frame held 20 ms, one behind another, event loop 70% busy):

- fourth arm, "delivers the rows of a commit made alone once the joiner restarts over its kept storage";
- fifth arm, the same "…, still on the slow link".

Both fail at the joiner's first transaction (the `seatBatch('F', …)` exec in `runJoinerRestartDelivers`, before the joiner stops; the "founder held the joiner's rows when it stopped" line never prints), with:

```
Transaction commit failed: Some peers did not complete: <peer>[block:…](in-flight) cause=Failed to get super-majority: 1/2 approvals (needed 2, 0 rejections), <peer>[block:…](in-flight) cause=The stream has been reset
```

Runs, 2026-10-17, optimystic `28e6e044`:

| change | fourth arm | fifth arm |
|---|---|---|
| `strand-founder-commits-every-table-collection` applied | failed, 2 of 2 (257 s, 225 s) | failed, 1 of 1 (262 s) |
| same tree, founder's empty-collection step disabled | passed, 1 of 1 (100 s; "founder held the joiner's rows when it stopped: false", rows on the founder 2.0 s after the restart) | not run |

The first, second and sixth arms pass with the change. The third arm (`it.fails`) still fails as expected. Its log shows the joiner's strand node connected to the relay **and the founder's strand node** when it became writable (45.7 s). The arm's comment says the node "holds only the relay connection when its strand becomes writable" and commits with a cohort of itself.

Logs (pruned after 14 days): `tickets/.logs/strand-founder-commits-every-table-collection.integ-c.log`, `.arm4-with.log`, `.arm4-without.log`, `.arm56-with.log`.

## Why (static, not confirmed by a trace)

Before the change, the founder's never-written app tables had no collection, so the joiner's first-sync probe settled them without needing the founder's blocks. On this link the joiner could become writable after its connection to the founder had dropped. Its first commit then resolved a cohort of only itself and committed alone (`commit:solo-cohort`), which is the premise the fourth and fifth arms rely on ("the third arm's journey up to the joiner's stop").

Now every declared table has a collection on the founder, which peer-join backfill and the probe's reads must bring over, and the joiner is connected to the founder when it becomes writable. Its first commit goes to a two-member cohort, so it needs both approvals. The founder's leg is reset mid-commit. Each relayed connection on this link drops on the next liveness ping because the pinged side's 10 s handler limit fires first (`blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`: "each drop … resets every read in flight"). Both runs with the change also logged peer-join catch-up to the other peer failing 3 times in a row on its 13 s response budget.

To confirm: one run of the fourth arm with `DEBUG='optimystic:db-p2p:coordinator-repo*,libp2p:connection-monitor*'`, checking that the joiner's commit is not `commit:solo-cohort`, and that a ping-failure abort of the joiner–founder connection falls inside the commit.

## What needs deciding, and the expected outcome

The suite should be green, and each arm should test what its name says.

- **Is the new behaviour acceptable?** Recommended: yes. The joiner's first commit now takes the correct path (it reaches the other member instead of being saved alone and possibly lost, `blocked/optimystic-write-made-alone-owes-no-one`). It fails because this link drops connections, which is tracked upstream. The app now sees an error it can retry, instead of a success that may never be delivered.
- **The fourth and fifth arms** exist to show that rows of a commit made alone reach the founder after the joiner restarts. They need a way to produce that commit that does not depend on the joiner happening to miss the founder. One candidate: the joiner commits after the founder has stopped, which is the same way the sixth arm produces the founder's lone write. The alternative is to retire them, if the third arm and the sixth arm between them cover what is left.
- **The third arm's KNOWN FAILURE comment and the file header's "What it found"** describe a solo commit that this link no longer produces. Record what the arm now fails on (run it as a plain `it` once to see the error), and keep it `it.fails` while it reproduces.
