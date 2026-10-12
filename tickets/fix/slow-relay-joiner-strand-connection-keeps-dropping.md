description: In the test that imitates two slow phones talking through a relay, the joining phone's connection to the other phone keeps breaking and reconnecting every few seconds, so it often never finishes downloading the shared workspace, or never hands back what it wrote while offline. Two of that test's cases fail on most runs because of it.
prereq:
architecture: docs/testing.md
files: packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (runJoinerRestartDelivers ~384, the fourth and fifth arms ~512-518), packages/integration-tests/src/harness/dedicated-relay.ts (createRelayNode ~93; no connectionMonitor or connectionManager timeouts), ops/docker/libp2p-infra/src/main.ts (connectionMonitor ~152, the settings the fixture says it matches), packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/src/strand-instance-manager.ts (whenStrandWritable ~1841), packages/cadre-core/src/link-budget.ts, packages/integration-tests/src/harness/ws-latency.ts
difficulty: hard
----

# Slow-relay joiner: the strand connection keeps dropping, so first sync and post-restart delivery stall

## Failing tests

`packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts`, both arms on a 20 ms `serial` frame cap with the event loop kept 70% busy:

- "delivers the rows of a commit made alone once the joiner restarts over its kept storage" (fourth arm)
- "delivers the rows of a commit made alone once the joiner restarts over its kept storage, still on the slow link" (fifth arm)

Command (after `yarn workspace @serfab/cadre-core build`):

```
yarn workspace @serfab/integration-tests test src/scenarios/joiner-first-commit-over-slow-relay.integration.ts -t "restarts over its kept storage"
```

Add `DEBUG_COLORS=0 DEBUG='sereus:cadre:strand-first-sync,sereus:cadre:strand-redial,sereus:cadre:strand-manager'` to see the connection cycle below.

## Two ways it fails

**At first sync**, before the joiner's stop (`control-nodes-pass-the-membership-predicate` scenario run, `tickets/.logs/control-nodes-pass-the-membership-predicate.scenarios-b.log`, both arms, 636 s and 635 s):

```
StrandAwaitingFirstSyncError: Strand strand-joiner-restart-1791815940108 is not writable yet: this machine has not yet received the strand's data from another member (waited 600027 ms).
 ❯ Timeout.<anonymous> ../cadre-core/src/strand-instance-manager.ts:1841:29
```

**After the restart** (triage run 2026-10-12, fifth arm, 519.7 s): the joiner became writable about 5.5 min in, committed alone, stopped and restarted on the slow link, re-opened its first-sync gate within 14 s, and then the founder never read its rows:

```
Error: Timeout waiting for every row the joiner committed alone is readable on the founder after the joiner restarts after 180000ms
 ❯ runJoinerRestartDelivers src/scenarios/joiner-first-commit-over-slow-relay.integration.ts:395:3
```

Measured rates: 3 of 5 runs of the slow-link arms with the joiner not writable after about 600 s (recorded on `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults` → "Update 2026-10-12"); both arms failing at first sync in the `scenarios-b` run; one triage run with the fourth arm passing (150.5 s, writable after about 145 s) and the fifth failing after the restart. The fourth arm passed in 149.2 s earlier the same day (`tickets/.logs/strand-commit-durability-restart-arm.log`). The third arm (same link, no restart) is `it.fails` for a different defect (`blocked/optimystic-write-made-alone-owes-no-one`) and has passed as "fails" throughout.

## What the logs show

In every slow-link run, the joiner's strand node reconnects to the founder's strand node through the member redial (`strand-peer-redial.ts`) and loses the connection again 10-60 s later, for the whole run. Redials in between fail as `ConnectionClosedError: The connection muxer is "closed" and not "open"` (a dead relay connection still listed as open) or `InvalidMessageError: failed to connect via relay with status NO_RESERVATION` (the relay dropped the target's reservation), each followed by the 21.5 s backoff. In the triage run's fifth arm, the joiner logged 13 reconnects, 16 closed-muxer failures and 8 `NO_RESERVATION` failures over about 8.5 min. A first sync or a post-restart catch-up that needs the circuit up for longer than one of these windows does not finish.

## Root-cause hypothesis

1. **The harness relay cuts the circuits.** `dedicated-relay.ts` claims to match the ops relay, but it runs libp2p's stock connection monitor. The ops relay (`ops/docker/libp2p-infra/src/main.ts`) pins a 30 s ping timeout and a 35 s interval. On a 70%-busy loop behind a 20 ms frame cap, pings answer late, and the stock monitor aborts the relay's connections to both strand nodes. That reset tears down every hop stream and every reservation on them. This is traced three times in the backlog ticket's "Third arm": `libp2p:connection-monitor:error aborting connection due to ping failure`, about 2 s after the founder's backfill push. The relay's reset towards the joiner also fails to send (`TypeError: First argument must be a valid error code number`), so the joiner keeps a dead relay connection, which explains the closed-muxer redials.
2. **With the cuts removed, something saturates the link.** One run with the ops settings copied into the fixture (not landed) stopped the cuts, but the joiner became writable only after 454 s instead of about 30 s. That run sent over 20 000 frames, against about 2 800 in a stock-relay run, which is about 400 s of link time at a 20 ms cap. Nobody identified the traffic. Suspects, in order: the peer-join backfill re-pushing the whole strand store on every reconnect edge (`peer-join-backfill.ts`, debounce and per-peer catch-up state), first-sync `Strand.Header` and table probes every 500 ms that each fan out cohort reads, and Optimystic 1.13's durability traffic (under-replication drain pushes, cohort consults on read).

Hypothesis 1 explains why the join fails; hypothesis 2 explains why the obvious fix for 1 did not help. The fix has to settle both.

## Suggested approach

- Give the fixture relay the ops relay's connection monitor and connection-manager timeouts (the contract it states), then measure frames per arm with `ws-latency.ts`'s counters and find what fills the link. Fix that at its source in this repo (backfill re-push, probe cadence), or route the upstream part to `blocked/` with the measured traffic as evidence.
- Fix 1 and 2 together or neither: landing relay parity alone trades intermittent failure for a 450 s join.
- Re-run the other eight scenarios on `startDedicatedRelay` after a relay settings change. With the ops settings the relay reclaims a dead peer 30-65 s after it stops answering, later than the stock monitor does.

## Design constraints

- Do not raise `FIRST_SYNC_MS` (600 s) or `CONVERGE` (180 s), and do not narrow the arms' link shape: the arms reproduce what real phones did on the public relay (file header).
- Do not convert the fourth or fifth arm to `it.fails` or `it.skip`; that needs a human sign-off recorded here.
- The third arm stays `it.fails` under `blocked/optimystic-write-made-alone-owes-no-one`; this ticket does not touch it.
- The ops relay's settings are the reference and are not changed by this ticket.
- No determinism edition, byte-format vector, golden fixture or migration is involved; the change is to libp2p configuration and replication traffic, not to stored data.
- Overlaps the "Third arm" section of `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults` (the fixture relay's settings); landing this settles that arm, so update or trim it there when this lands.
