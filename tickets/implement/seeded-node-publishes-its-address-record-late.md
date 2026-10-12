description: A node added to a cadre by a seed (a rented provider node, or a machine added with `cadre enroll add`) can take up to about seven and a half minutes to publish its own address record, so other members cannot look up its address in that window. Make every node keep trying on its regular 15-second check until its first publish lands, not only nodes that were claimed.
architecture: docs/architecture.md#enrollment-flow-phone-adds-provider-drone
files: packages/cadre-core/src/cadre-node.ts (publishSelfRecordOnceClaimed ~3270-3292, its call in reconcileControlCohort ~3665, the NOTE in startRecordRefresh ~3340-3359, the NOTE in scheduleSelfRegistration ~2961-2966, publishSelfRecord ~3023-3095, `removal` field ~644), packages/cadre-cli/src/commands/start-node.ts (NOTE on claimConfigFor ~108-118), packages/integration-tests/src/scenarios/provider-drone-phone-requester.integration.ts (header list item 5, steps 4 and 5), packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts (header paragraph ~48-52), docs/architecture.md (~448 and the last sentence of ~871), docs/testing.md (~612)
repro: verified
----
# A seeded node publishes its address record on the heartbeat, not when its row arrives

## The defect

Each member publishes a signed address record into its own `CadrePeer` row (`CadreNode.registerSelf`), and other members find its addresses through `CadreNode.resolvePeerAddrs`. A node with no owner key (every provider node, every `cadre enroll add` machine, the `B` node of `bootPair`, the seeded members of `control-trio.ts` and `topology.ts`) cannot insert its own row; it can only update a row an owner wrote for it. That row is written on the owner (`addDrone`, `authorizePeer`) and arrives by replication once the two connect, which is after the node booted. Until it arrives, `registerSelf` returns `skipped` (one `CadrePeer` read, no write).

The node tries to publish at:

- a one-shot 1 s after `start()` (`scheduleSelfRegistration`), usually before anyone has seeded or dialed it;
- the first-growth drain, at the moment of the first connection, usually before the row has replicated in;
- the heartbeat, every 7.5 minutes (`DEFAULT_PEER_RECORD_HEARTBEAT_MS`), or an address change (`self:peer:update`), which a provider node does not have;
- the reconcile pass (every 15 s, `DEFAULT_CONTROL_COHORT_RECONCILE_MS`), through `publishSelfRecordOnceClaimed`, which tries until the first publish lands — but only on a node started with `config.claim`.

Observed (2026-10-11, `provider-drone-phone-requester.integration.ts` step 5 with `DEBUG=sereus:cadre:node` on the child): when the seed arrived after the 1 s one-shot, `requester.resolvePeerAddrs(nodePeerId)` stayed empty for 90 s; when the seed arrived 0.74 s after start, the one-shot published and the record resolved within 1.5 s. In production a phone delivers the seed seconds to minutes after the container starts, so the slow case is the normal one.

## The fix (decided)

Drop the claim condition from the reconcile-pass publish, as the NOTE in `startRecordRefresh` already recommends. The method becomes "publish from the reconcile pass until this session's first publish lands", for every node, with these stop conditions:

- `this.lastSelfRecordPublishAt !== null` — already published this session (unchanged).
- `this.isAwaitingClaim()` — an unclaimed node has no row and no party yet (unchanged; saves the read).
- `this.removal !== null` — new. A node that has learned it was removed has nothing to publish; without this it would pay one read per pass forever (the old docstring's "claimed node later removed" cost, which the wider rule would extend to every removed node).

Rename the method to say what it now does, e.g. `publishFirstSelfRecord`, and rewrite its docstring and its log lines (`claimed node self-record publish` → something like `first self-record publish`).

Why not the narrower option (only nodes that accepted a seed this session, set from `recordSeedBootstrapPeers`): it adds a new piece of state, misses `bootPair`'s `B` and any other late-authorized node that did not take a seed path (an invited phone), and misses a seeded node restarted before its row replicated in. The wider rule costs little on top of what already happens:

- An owner node self-inserts or refreshes at the 1 s one-shot, so it never reaches the pass's publish unless that one-shot failed — and then retrying on the next pass is wanted: the NOTE in `scheduleSelfRegistration` (a restarted machine's one-shot failing with `ConcurrentModificationError` and waiting for the heartbeat) is resolved by the same change. Update that NOTE to say the reconcile pass retries.
- A non-owner node without its row pays one local `CadrePeer` read per pass until the row arrives. `publishSelfRecord` currently collects addresses (`collectSelfAddrs`) before that read; move the read first so a skipped publish does not collect addresses. Only the INSERT and UPDATE branches use `addrs`.
- The first publish on a non-owner is a background `CadrePeer` UPDATE that today usually waits for the heartbeat, so tests that use `bootPair`, `control-trio.ts` or `topology.ts` will now see that write during the test. `registerSelf` is single-flight, so it cannot race `control-trio`'s explicit `C.registerSelf()` poll. `tickets/blocked/forked-control-collection-sync-livelocks` suspects (unconfirmed) a background self-record write racing a foreground `CadrePeer` write on a lone, freshly restarted OWNER; this change adds no write on a node that already published, and a non-owner's new write happens only once its row has replicated in, i.e. while connected. Still, measure (see TODO).

The `claimConfigFor` NOTE in `start-node.ts` (a claimed node restarted without the secret would wait for the heartbeat) no longer holds: the publish no longer depends on `config.claim`. Remove that NOTE, or reduce it to the remaining consequence (no claim policy, so a rival's seed is refused as untrusted), which the docstring above it already states.

## The reproduction and the acceptance assertion

`provider-drone-phone-requester.integration.ts` step 5's NOTE becomes the assertion it describes: `requester.resolvePeerAddrs(nodePeerId)` resolves, with an address containing `/ws`, within one node reconcile pass (15 s, plus slack for the pass itself and the replication back to the requester; `OP_MS` = 30 s is reasonable).

For the assertion to prove anything, the seed must arrive after the node's 1 s one-shot has already run. Step 4 should wait, before `applySeed`, until the node has been up for a few seconds — e.g. poll `/status` until `uptime` is at least 5 s past the value read when the container first reported `running`. (`uptime` counts from the health server's construction, not from `CadreNode.start()`, so use a delta rather than an absolute.) Run the changed test once BEFORE the core fix and confirm step 5 fails with the empty resolve; that is the reproduction. Then apply the fix and confirm it passes.

Update the file header's list item 5 to say the node's record now reaching the requester is pinned.

## TODO

- In `provider-drone-phone-requester.integration.ts`: delay the seed delivery in step 4 as above; replace the step 5 NOTE with the `resolvePeerAddrs` assertion (non-empty, some address includes `/ws`, within ~`OP_MS`); update header item 5.
- Build `@serfab/cadre-core`, `@serfab/cadre-cli`, `@serfab/cadre-provider` (own packages only — never the sibling repos), run the scenario, and confirm step 5 FAILS on the unfixed core. Record the result in the review handoff.
- In `cadre-node.ts`: replace `publishSelfRecordOnceClaimed` with the renamed method gated on `lastSelfRecordPublishAt`, `isAwaitingClaim()` and `removal`; rewrite its docstring and log lines; update its call site in `reconcileControlCohort`.
- In `publishSelfRecord`: read `queryPeerRecord` before `collectSelfAddrs`, so a skipped publish skips address collection.
- Rewrite the NOTE in `startRecordRefresh` (the late-authorization case is now handled for every node by the reconcile pass; keep the measured facts about `self:peer:update` and the membership-change seam that explain why the pass is the trigger) and the NOTE in `scheduleSelfRegistration` (a failed one-shot is retried on the next reconcile pass).
- `start-node.ts`: remove or rewrite the `claimConfigFor` NOTE as above.
- `node-claim-by-phone.integration.ts` header (~48-52): name the renamed method and say it runs for every node, not only claimed ones.
- Docs: `docs/architecture.md` ~448 (the scenario now checks the drone's record reaching the phone), the last sentence of ~871 (a claimed node is one case of the general rule — state the rule once, in the section that owns self-registration around ~171 or ~277, and link to it), and `docs/testing.md` ~612 (drop "not asserted yet").
- Re-run the scenarios this touches, under the normal parallel suite load: `provider-drone-phone-requester`, `node-claim-by-phone`, the files that use `bootPair`, `control-trio.ts` and `topology.ts`, and `control-delete-while-alone-convergence` (isolated, a few rounds — it fails more in isolation; compare against its known rate in `tickets/blocked/forked-control-collection-sync-livelocks`). Run the full integration suite if it fits within the agent's run limits; otherwise say in the handoff that it was deferred. Check `tickets/.pre-existing-known.md` before attributing any failure to this change.
- `yarn lint` and the cadre-core unit tests.
