description: After a phone adds an always-on node to its cadre, the phone's shared workspace now connects to that node within seconds instead of about a minute, so saves made right after adding a node no longer land on the phone alone.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-addr-protocol.ts (`nextStrandAddrAsk`, `STRAND_PEER_ADDR_FIRST_RETRY_MS`, `STRAND_PEER_ADDR_RETRY_MS`), packages/cadre-core/src/cadre-node.ts (`strandAddrAskStreak`, `refreshStrandPeerAddrs`, `askSiblingsForStrandAddrs`), packages/cadre-core/src/types.ts (comment only), packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md, docs/strands.md, docs/testing.md
repro: verified
----
# Retry the strand-address ask within seconds after a node claim (gotchoices/sereus#56)

A strand is a shared database on its own libp2p node, and a node learns a sibling's strand address by asking over the control network. After a claim the phone's asks failed or came back empty while the node restarted, and the next ask waited a flat 60 s or 10 minutes.

## What changed

`nextStrandAddrAsk` (`strand-addr-protocol.ts`, replacing `siblingAnswered`) sets the wait from the ask's outcome and a per-(sibling, strand) count of the steps climbed so far:

| Outcome | Wait | Count |
|---|---|---|
| `answered` | refresh interval (10 min) | back to 0 |
| `empty` | 1 s × 2^count, up to the refresh interval | +1, unless the wait is at its cap |
| `unreachable`, `unavailable`, `unsupported` | 1 s × 2^count, up to the smaller of 60 s and the refresh interval | +1, unless the wait is at its cap |

The count lives in `strandAddrAskStreak`, beside `strandAddrAskDueAt`, and is pruned at the same two sites, so a reconnected sibling or a resumed strand starts at 1 s. `nextReconcileWakeMs` is unchanged: it already wakes a pass for a due time before the backstop.

## Measurements

All on 2026-11-03, one machine, Node 24, against the real `cadre-cli` bin, on the implementer's build (before the review's change to the count, which only affects asks past a cap).

**The new integration arm** fails on the old build (one run: `Timeout … after 20000ms`, both claim-time asks failed, no further ask inside the window). On the new build it passed 4 of 4 runs, plus 1 more after the review's changes. Step 3 takes about 3.3 s, against the 20 s limit.

**The issue's script, one run**, `NODES=1 WAIT_MS=70000`, at the default 2-minute backstop, so the 1 s retry came from the pass's own wake:

- The node's strand started at 5.0 s. The +0 s sample showed 0 connections and cohort 1. Every sample from +10 s to +70 s showed 1 connection, cohort 2, `heldElsewhere true`. The old code stayed at cohort 1 through +50 s.
- The asks failed at 25.585 and 25.852, and the next one, 1.02 s later at 26.876, returned 6 addresses.
- `commit:solo-cohort` count: 53, against 58 before. This count is a poor measure, because 50 of the 53 are the phone founding its databases in the first second, before any node exists. 2 are control-database commits before the first failed ask, and 1 is a strand commit after the claim: the +0 s write, 0.5 s before the addresses arrived.

## Known costs and limits

- **Reconnects cost more than one ask.** A phone always answers `empty` to a node, and the count resets on reconnect, so each new connection pays the early steps again: a connection that lasts 60 s costs 6 asks per (sibling, strand) rather than 1 (counted from the steps, not measured).
- **The extra asks and passes are unmeasured.** The `NOTE:` on `nextStrandAddrAsk` gives the counted figures and the way out if they show up on a phone's battery or in pass counts.
- **The integration arm does not pin the wake.** `buildPhoneOwner` sets a 2 s backstop, so a pass runs regardless. The wake has unit coverage in `control-cohort-wake.spec.ts`, and the script run above exercised it at the default backstop, once.

## Not in this ticket

The +0 s write above still commits alone, and offline mode does not hold it. That window, and a node with its control port reachable but its strand port firewalled, belong to `plan/offline-mode-holds-writes-for-party-machines-it-cannot-reach`, which names both.

## Review findings

Read the diff of `ticket(implement): strand-addr-retry-waits-a-minute-after-a-node-claim` first, then the code around it: `refreshStrandPeerAddrs`, `nextReconcileWakeMs`, `armReconcileWake`, and the pass's dial loop.

**Found and fixed in this pass**

- **Defect: a long run of failures sent the next `empty` answer straight to the 10-minute wait.** The count kept rising while the failure wait sat at 60 s, so after about 10 failures (roughly 5 minutes with the connection up, the sibling refusing or timing out) the first `empty` waited the full refresh interval. That is the trap this ticket exists to remove, reached by a longer route; found by reading, and no run hit it. The count now stops when the wait stops, so that `empty` waits 64 s. The doubling for a plain failure or `empty` run is unchanged. Four rows of the `nextStrandAddrAsk` table changed their expected count, and one of them now names this behaviour. `docs/architecture.md` says so.
- **Doc: `docs/testing.md` said the claim scenario runs "no strand"**, which the new arm made false, and the ticket's file list did not include that file. It now states the connection and keeps replication out of scope.
- **Doc: `docs/architecture.md` "Retries a pass arms"** said only a change-driven pass redials an offline sibling between backstops. A strand-address wake does too. Corrected.
- **File size: moved `nextStrandAddrAsk` and the two constants only it uses from `cadre-node.ts` (11,573 lines) to `strand-addr-protocol.ts` (about 610 lines)**, which already defines `StrandAddrOutcome`. It is pure and needs nothing from the class. `STRAND_PEER_ADDR_REFRESH_MS` stayed, because it is the class's config default and reaches the function as an argument. The wider split remains `backlog/debt-cadre-node-single-file-size`.

**Noticed and parked as a tripwire**

- The early `empty` steps are full reconcile passes, so each also redials any offline sibling and advances the redial wait: with one sibling offline, the steps at 1, 2, 4 and 8 s can take the redial wait to its 2-minute cap in about 8 s rather than about 105 s. It needs a second sibling that is offline, and it does not affect the claimed node itself, whose keys are pruned while it is disconnected. From reading the code, not measured. Added to the `NOTE:` on `nextStrandAddrAsk`.

**Checked, nothing found**

- **Spin and stamps:** an ask that outlasts its wait gives a delay-0 wake. With a sibling whose asks time out at about 10 s, that is about five back-to-back passes before the wait exceeds the ask, then it settles. Bounded, as the comment on `askSiblingsForStrandAddrs` says. At the 60 s cap the wait no longer grows, but an ask would have to outlast 60 s to run back to back, and that is the old flat retry's behaviour.
- **Prune sites:** both maps are pruned together, and the only writes are in `askSiblingsForStrandAddrs`. `grep` found no other reader or writer of `strandAddrAskStreak`. A flap faster than a pass keeps the count, which only continues the climb.
- **Overflow and odd config:** the count is now bounded by the cap. A `strandAddrRefreshMs` below 1 s waits that interval with the count at 0, and the existing override test covers a 1 s refresh.
- **Security:** the schedule changes no message or authorization. Asks still carry `delegatePeerId`, and the longest wait is unchanged at 10 minutes inside the grant's 30-minute lifetime.
- **Integration arm:** the 20 s limit is about 6 times the observed step time and still under the old 60 s retry, so it distinguishes the two builds. Its polling promise is bounded and its rejection is handled. The added strand did not disturb steps 4 to 6.
- **Tests:** none cut. The table pins branching logic in the ticket's design, and the three `CadreNode` cases each cover a seam nothing else does (both prune sites, an `empty` answer reaching the merge). None added beyond the changed rows.
- **Other docs and tickets:** `docs/strands.md` and the comment in `types.ts` still hold after the count change. `docs/cadre-host.md` states nothing about this schedule. The plan ticket's claims about the two leftover windows match this ticket.

**Validation after the review's changes**

- `yarn typecheck`, `yarn lint`: pass.
- `@serfab/cadre-core` full suite: 2573 passed, 1 skipped, 189 of 189 files. `peer-record-resolution.spec.ts`, which failed to load during the implementer's run, passed here, consistent with its diagnosis as a sibling rebuild in progress. The stale-build guard did not refuse this run.
- Integration, against a rebuilt `@serfab/cadre-core`: `node-claim-by-phone` 6 of 6, `cadre-host-join-by-qr` 6 of 6, `strand-always-on-replica-survives-phone-loss` 1 of 1.

**Not run:** the rest of the integration suite. The implementer ran all 24 `strand-*` files (69 passed, 8 skipped by their own opt-in flags) before the review's changes, and those files took 11 minutes, past the per-command limit, so they were not repeated. The review's change only alters waits after a cap, and the move changes no behaviour, but that is reasoning, not a run. The other 56 of the 80 integration files have not been run against this ticket at all and are left to the release gate.
