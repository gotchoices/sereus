description: After a phone adds an always-on node to its cadre, the phone's shared workspace stays unconnected to that node for about a minute, so everything saved in that minute lands on the phone alone. Make the phone ask the node for its workspace address again within seconds, including when the node says it has nothing yet because it is still starting.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/cadre-node.ts (`STRAND_PEER_ADDR_RETRY_MS` ~262, `siblingAnswered` ~362, `strandAddrAskDueAt` ~867, `refreshStrandPeerAddrs` ~7812, `askSiblingsForStrandAddrs` ~8007), packages/cadre-core/src/strand-addr-protocol.ts (`StrandAddrOutcome` ~305, `answerStream` doc), packages/cadre-core/src/control-cohort.ts (`nextReconcileWakeMs`), packages/cadre-core/src/types.ts (`strandAddrRefreshMs` ~629), packages/cadre-core/src/delegate-admission.ts (`prunePeerStrandKeys`), packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-core/test/control-cohort-wake.spec.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md (Strand-Address Resolution ~1400–1409, "Retries a pass arms" ~419)
repro: verified
----
# A failed or empty strand-address ask right after a claim costs a minute, or ten, of solo commits (gotchoices/sereus#56)

A strand is a shared database that runs on its own libp2p node. To connect to a sibling's strand node, a node has to ask that sibling for the address over the control network (the strand-address ask, `/sereus/strand-addr/1.0.0`). A phone that claims a node has no other way to name the node's strand peer.

## What was measured

All runs on 2026-11-03: current master with the linked Optimystic build, Node 24, one machine, the issue's script against the real `cadre-cli` bin.

**The defect reproduces.** One run of 70 s: the node's strand started at 5.8 s. The phone's strand had 0 connections and every commit was cohort 1 through the +50 s sample, then 1 connection and cohort 2 at +60 s, with 58 `commit:solo-cohort` lines. The phone's asks failed at claim time (`UnexpectedEOFError`, then `StreamStateError`, 0.35 s apart) and the next one was exactly 60 s later (23:27:12.7 → 23:28:12.8).

**What a restarting node answers over time.** The script asked the node every 100 ms from just before `claimNode`, with `collectStrandAddrs`:

| Run | `unreachable` until | `empty` for | then `answered` at |
|---|---|---|---|
| 1 | 1 521 ms | 677 ms | 2 198 ms |
| 2 | 2 395 ms | 1 321 ms | 3 716 ms |
| 3 | 724 ms | 181 ms | 905 ms |

So **a restarting node does answer `empty`**, for 0.2 to 1.3 s here. It serves the RPC from `start()` onward, and it has no strand to report until its strand row arrives and the strand launches. On a slower link or a larger control database that window should be longer (inferred, not measured).

**A real ask in each window** (the script clears `strandAddrAskDueAt` and runs `reconcileControlCohort` the moment the probe sees that outcome):

- During `answered`, two runs: the phone's strand connected 1 592 ms and 1 601 ms after the pass began, and the next commit sample was cohort 2. So the ask is the only thing missing: nothing else holds the connection back once the address is merged.
- During `empty`, one run: the pass stamped a due time 600 s out, and the strand was still unconnected with cohort 1 at the end of the 15 s wait.

**This is the trap in the obvious fix.** Retrying failures quickly without changing `empty` lands the retry inside the `empty` window, and turns a one-minute wait into a ten-minute one. Today's code can already reach that if its one prompt ask after the reconnect lands in the window. That is inferred from the code and was not seen in an unforced run.

## Cause

`askSiblingsForStrandAddrs` chooses the next ask from one outcome with two flat waits: `answered` or `empty` waits `STRAND_PEER_ADDR_REFRESH_MS` (10 min), everything else waits `STRAND_PEER_ADDR_RETRY_MS` (60 s). Neither wait suits a sibling that is starting up. That is the one site to change.

## Design

Each (sibling, strand) gets a count of consecutive asks that produced no address. The wait after each ask is:

```ts
// streak: consecutive asks that produced no address, this one included
wait(answered)    = refreshMs                                   // streak resets to 0
wait(empty)       = min(FIRST × 2^(streak − 1), refreshMs)
wait(any failure) = min(FIRST × 2^(streak − 1), min(refreshMs, STRAND_PEER_ADDR_RETRY_MS))
```

`FIRST` is a new constant of 1 s (`STRAND_PEER_ADDR_FIRST_RETRY_MS`), the same step `CLAIM_RESTART_REDIAL_STEP_MS` uses for this restart on the control connection. `empty` and the failures share one streak, because a restarting node moves from one to the other.

**Why `empty` climbs to the refresh interval and not to 60 s.** `empty` is a normal steady state: a phone has no listening strand addresses and always answers it, and the node asks the phone in the same way (seen in the trace), and a hibernating sibling answers it too. Backing off all the way keeps the steady cost at today's one ask per ten minutes. The price is the extra asks while climbing: 1, 2, 4 … 512 s is 10 asks in the first 17 minutes rather than 2 (counted from the ladder, not measured). The steps below the 2-minute backstop are 7 extra wakes of the reconcile pass. That cost repeats per (sibling, strand) on each new control connection. Leave a `NOTE:` at the site: if those wakes show up on a phone's battery or in pass counts, stop the `empty` ladder from waking a pass and let its later steps wait for the backstop.

**The streak dies with the due time.** Prune it at the same two sites (`prunePeerStrandKeys`, and `clear()` when no strand runs), so a reconnected sibling starts again at the first step. A new connection may be a new incarnation of the sibling. A sibling flapping its connection costs one prompt ask per reconnect, which it already costs today.

**Representation.** A second map keyed by `peerStrandKey`, beside `strandAddrAskDueAt`. `nextReconcileWakeMs` and the specs read the due map as plain numbers, and `nextReconcileWakeMs` needs no change: it already wakes a pass for the earliest due time, and a retry due sooner than the backstop wakes it. `trigger` lets an earlier pending run win. Put the wait in a small exported pure function, so the ladder has one table test, and replace `siblingAnswered` with it.

**Stamps.** `askSiblingsForStrandAddrs` stamps from the pass's `now`, taken before the ask. An ask that took longer than its wait is due at once, and `nextReconcileWakeMs` wakes a pass at delay 0. That cannot spin, since each failure lengthens the next wait, so leave it as it is.

### Rejected

- **A new "starting" answer from the node.** The freshly restarted node does not know the strand exists until its row replicates, so it cannot tell "not yet" from "never".
- **Treating an inbound ask from the sibling as "ask it back now".** The node's strand launch does send the phone an ask carrying its strand peer id, so this would be nearly immediate. But it gives a read path a side effect on scheduling, it needs its own rate limit, and that ask can arrive before the strand is serving, so a retry would still be needed. Worth revisiting only if the ladder proves too slow.

## Not in this ticket

Offline mode committing alone during such a window, and a commit made alone reporting nobody owed, are `plan/offline-mode-holds-writes-for-party-machines-it-cannot-reach`. So is a node with its control port reachable and its strand port firewalled: its ask succeeds, so this ticket changes nothing there.

## Reproducing by hand

Take `strand-unconnected-repro.mjs` from gotchoices/sereus#56 and save it inside `packages/integration-tests/` so its imports resolve. On Windows run the bin through `process.execPath` in the script's `execFileSync` and `spawn`. Then:

`CADRE=<repo>/packages/cadre-cli/dist/bin/cadre.js NODES=1 WAIT_MS=70000 DEBUG='sereus:cadre:strand-addr,optimystic:db-p2p:coordinator-repo*' node <script> 2> <log>`

Count `commit:solo-cohort` in the log, and delete the script afterwards.

## TODO

- Build the ladder per the design above, in `askSiblingsForStrandAddrs`, as an exported pure function plus a streak map pruned with the due map
- Add the `NOTE:` tripwire on the extra `empty` asks
- Table-test the pure function: the first step, doubling, the 60 s cap for failures, the refresh cap for `empty`, a configured refresh shorter than 60 s, reset on `answered`
- Update `cadre-node-strand-addr-refresh.spec.ts`: its retry test (~358) asserts a flat `STRAND_PEER_ADDR_RETRY_MS`; add one case that a sibling answering `empty` then addresses gets merged on the ladder's next step and returns to the refresh interval
- Add the regression arm to `node-claim-by-phone.integration.ts`, which fails today at about 60 s:
  - Before the claim, the phone publishes a strand and calls `addStrand` as founder, using `createSignedSAppConfig` as in `strand-always-on-replica-survives-phone-loss.integration.ts`. The child's config already runs strands by default.
  - In step 3, start polling before `claimNode` for `strand.libp2pNode.getConnections().length > 0` with a 20 s limit, and await that at the end of the step.
  - Remove "strand replication onto the claimed node" from the file header's out-of-scope line only as far as this connection goes; replication stays out of scope.
- Update comments that state the old schedule: `STRAND_PEER_ADDR_RETRY_MS`, `STRAND_PEER_ADDR_REFRESH_MS` ("last ANSWERED (even with nothing)"), `strandAddrAskDueAt`, `refreshStrandPeerAddrs`, `askSiblingsForStrandAddrs`, `StrandAddrOutcome`'s `empty`, `answerStream`'s "wait ten minutes" remark, and `strandAddrRefreshMs` in `types.ts`
- Update docs/architecture.md: the per-sibling schedule in "Into the strand's address book, and kept warm", the status sentence under "Request/response", and the strand-address clause of "Retries a pass arms"
- Rebuild `@serfab/cadre-core` before the integration arm (the stale-build guard fails otherwise), run the issue's script once, and record the solo-commit count in the review handoff
