description: Two machines that reach each other through a relay now try once, in the background, to connect directly over WebRTC instead, and move their traffic to the direct connection when it works.
architecture: docs/network/relay.md
files: packages/cadre-core/src/webrtc-upgrade.ts (new), packages/cadre-core/test/webrtc-upgrade.spec.ts (new), packages/cadre-core/src/link-budget.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/control-protocol-guard.ts, packages/integration-tests/src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts, docs/network/relay.md, docs/network/deadlines.md, docs/contributing/topology-coverage.md
difficulty: medium
----
# Relayed connections try a WebRTC upgrade in the background

## What landed

A new module, `webrtc-upgrade.ts`, with two parts:

- **`decideWebrtcUpgrade`**, pure: given this node's and the remote's peer ids, the kinds of every open connection to that peer, the remote's identified listen addresses, whether this node publishes a WebRTC address, and the peer's backoff, it answers "attempt, at this address" or "no, for this reason" (`not-relayed`, `already-direct`, `no-webrtc-addr`, `remote-dials`, `in-backoff`).
- **`WebrtcUpgradeService`**, the wiring: subscribes to `peer:identify`, judges each one, dials at most one upgrade per peer at a time, and keeps a per-peer in-memory backoff (1 min doubling to 30 min after a failure, cleared by a success).

It is installed on the control node (`cadre-node.ts`, beside `startControlBackfill`, stopped in `cleanup`) and on every strand node (`strand-instance-manager.ts`, beside the peer redial, stopped first in `releaseRuntime`). It is inert on a node that cannot dial WebRTC, judged by whether the node serves `/webrtc-signaling/0.0.1` — now one exported constant that `control-protocol-guard.ts`'s class table also uses.

The dial budget is derived in `link-budget.ts`: `webrtcUpgradeDialBudgetMs` = `WEBRTC_SIGNALING_ROUND_TRIPS` (9) at the declared link + two admission allowances + a flat `ICE_NEGOTIATION_ALLOWANCE_MS` of 25 s, so 60.5 s at the default. Deliberately longer than the ~23 s the WebRTC stack takes to give up on its own: nothing waits on this dial, so the only way to lose by the deadline is to cut a slow working negotiation off.

Docs: a "Relayed connections are upgraded in the background" subsection in `docs/network/relay.md`, a row in the budget table in `docs/network/deadlines.md`, and the rewritten coverage row for the scenario.

## Three deviations from the ticket, each for a reason — weigh them

**The dial goes through `peer-dial.ts`'s `dialAddr`, not `node.dial`.** The ticket said `node.dial` straight on libp2p, because `findExistingConnection` lets a WebRTC address through beside an unlimited relayed connection. That is true, but libp2p's dial queue also **joins any dial to a queued job for the same peer id, whatever address the new dial names** (`dial-queue.js`, the `existingDial` lookup, which `force` does not bypass). An upgrade dial through the queue can therefore be answered by someone else's relayed dial of the same peer and report a success that upgraded nothing — and on a strand node, `@optimystic/db-p2p` dials peers by id constantly. `dialAddr` dials exactly the address given, refuses to hand back an open relayed connection for a WebRTC address (the branch the prereq added for this ticket), runs the gater hooks, and aborts on the node's own stop. The outcome is still classified after the dial resolves, as a guard if anyone moves back to `node.dial`; on this path that branch should be unreachable, so cutting it is a defensible review call.

**The decision takes no "which connection did identify arrive on".** The ticket listed "the identify arrived on a relayed connection" and "no open direct connection" as two conditions; they collapse into one input, the kinds of all open connections to that peer: upgrade when at least one is relay-carried and none is direct. Same outcomes, one less input to keep consistent, and it is what let the already-connected pass below reuse the same function.

**`start()` also judges the peers already connected** (from their peer-store addresses, as `PeerJoinBackfill.scheduleConnectedPeers` does). Not in the ticket, but the control node needs it: it is armed at the end of `CadreNode.start()`, and building the control database first connects to every reachable sibling, so those peers have already identified and the event will not come again until **they** change addresses. Without the pass, a party's two relay-only machines could sit relayed indefinitely.

## How to check it works

`yarn workspace @serfab/integration-tests vitest run src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts` — two arms over two relay-only parties on one dedicated relay, both listening on `/webrtc`, sharing the shared setup helper:

- **ICE can never connect** (the prereq's arm, unchanged in substance): formation stays under 15 s and nothing anywhere ends up on a WebRTC connection — now also proving that a failed upgrade attempt disturbs nothing.
- **ICE can connect** (new): each party's strand node ends up holding a `webrtc` connection to the other within the gate, the relayed connection is still open beside it, and rows replicate both ways afterwards. Measured 253-257 ms from "strand writable" to "both sides direct", over four runs.

Add `DEBUG='sereus:cadre:webrtc-upgrade'` to watch the mechanism: one side logs `remote-dials` (the tie-break), the other logs `upgraded <peer> to …/p2p-circuit/webrtc/p2p/<peer>`, and both then log `already-direct`. That is how the upgrade was confirmed to be the cause rather than some dial happening to pick the WebRTC address — worth re-running, because the assertion itself cannot tell the two apart.

`yarn workspace @serfab/cadre-core vitest run test/webrtc-upgrade.spec.ts` — 19 cases over the pure function: the connection-set conditions, the tie-break both ways, the backoff still running and just expired, and one relay chosen out of two.

## Known gaps — the reviewer's starting points

- **The control-node install site is exercised by nothing.** The scenario's upgrades all happen on strand nodes. Worse, it cannot easily be: Optimystic names identify per network, so two parties' control nodes never identify each other and are never candidates (observed — the control nodes logged no judgement at all in the scenario). What the control site actually covers is a party's **own** machines reaching each other through a relay, plus a device redeeming an invitation into the party. That claim is from reading the protocol table in `control-protocol-guard.ts` and from the absence of control-node log lines, not from a test.
- **The already-connected pass is verified by inspection only.** Nothing exercises the path where a peer identified before the service armed.
- **`noteFailure`'s doubling and 30-minute cap have no test.** The table test pins the `backoffUntilMs` input, not the state machine that produces it.
- **`canDialWebrtc` tolerates a node with no `getProtocols()`** and treats it as "no WebRTC". That was added because 9 unit-spec files build small libp2p doubles without it (105 failures otherwise). It is the fail-safe answer and matches how `peer-dial.ts` and `relay-reservation.ts` read node slices, but it is production code shaped by test doubles; a reviewer may prefer fixing the doubles.
- **Verified by inspection, as the ticket allowed**: the connection gater (the dial runs `denyDialPeer`/`denyDialMultiaddr` inside `dialAddr`), the capped-relay case (`@libp2p/webrtc` opens its signalling stream with `runOnLimitedConnection: true`, and `initiateConnection` reuses the open connection to the peer rather than dialing), the membership guard (`/webrtc-signaling/0.0.1` was already classed `transport`), and a dropped WebRTC connection being re-evaluated on the next identify. Teardown is better than inspection: the failing-ICE arm's log shows `stop()` aborting the in-flight attempt at node teardown.
- **A load flake, not reproduced.** The first full `@serfab/cadre-core` run failed `cadre-node-owner-grant.spec.ts > a member redeeming locally while alone is refused by name` with `Timed out waiting for the member to be alone` (a 15 s poll). It passed 1/1 in isolation and the two later full runs were green (2657 passed). That spec's nodes have no WebRTC transport, so the service never subscribes there. Not in `tickets/.pre-existing-known.md` and nothing written to `.pre-existing-error.md`, since one non-reproducing occurrence would send a triage agent after a phantom — recorded here instead.
- **Six new entries on knip's unused-export warn list** (`WEBRTC_SIGNALING_ROUND_TRIPS`, the two backoff constants, `canDialWebrtc`, `WebrtcUpgradeSkipReason`, and the skip-reason type's companions). Kept exported to match `link-budget.ts`'s convention that every round-trip count is part of its vocabulary; the gate is green either way (dead exports are `warn` by design).

## Tripwires parked at their sites

- `webrtc-upgrade.ts`, module doc: Optimystic groups a peer's connections by limited/unlimited rather than direct/relayed, so a relayed connection **re-opened** after an upgrade would become the newest unlimited one and win again. Not reachable today; the fix would be upstream ranking, not closing the relayed connection here.
- `webrtc-upgrade.ts`, "Which side dials": the tie-break reads each side's current addresses, so in the window where one side publishes a WebRTC address and the other does not yet, both can decide they are the dialer and two WebRTC connections open.
- `webrtc-upgrade.ts`, "Backoff": the map holds one entry per peer ever attempted, for the node's life, and is deliberately not cleared on disconnect.
- `cadre-node.ts`, `startWebrtcUpgrade`: a device redeeming an invitation into this party is the one peer upgraded before it is admitted, and ICE tells it this machine's interface and server-reflexive addresses, which the relayed connection did not. Accepted, with the alternative named.

## Gates

`yarn lint` (ESLint plus `check:docs`) and `yarn typecheck` across every workspace pass. `@serfab/cadre-core`: 198 files, 2657 tests, green on the final run. The scenario file: both arms green, four runs. `yarn dep-check` green. Nothing was committed — the runner does that.
