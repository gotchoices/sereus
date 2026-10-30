description: When two machines of a cadre start at the same moment (a host reboot, a power cut), each writes its own address record while it cannot yet reach the other, and the two writes conflict in a way nothing later repairs, so the cadre can no longer add machines (gotchoices/sereus#53). Background control writes must wait until another machine is reachable when the party has other members, as adding an owner key already does.
architecture: docs/architecture.md#writes-made-while-alone
repro: verified
files: packages/cadre-core/src/cadre-node.ts (`scheduleSelfRegistration` ~3330, `startRecordRefresh` ~3729 and its `republish`, `ownerKeyWriteAlone` ~9543, `publishFirstSelfRecord` ~3698, `runDrainControlReplication` ~4890, `pendingSelfPeerWrite`, `hasReachableControlSibling` ~8684, `isControlCohortMember` ~2880), packages/cadre-core/src/pending-join-runner.ts (`isAlone`, `reissueWritesMadeAlone`), packages/integration-tests/src/scenarios/control-members-restarted-together.integration.ts (new, the reproduction), packages/integration-tests/src/harness/cadre-invite.ts (`startPinningMember` gained `connectionGater`), docs/architecture.md ("Writes made while alone" ~491, "Cadre Node" item 4 ~238, the boot-time publish sentence ~391), docs/testing.md (~582, the paragraph on a node's first address-record publish)
----
## What is wrong

`CadreNode.scheduleSelfRegistration` publishes the node's own `CadrePeer` record (its signed address record) one second after `start()`, whether or not any sibling is reachable. When two members of a party restart together, both are alone at that moment: nothing dials a sibling before the timer, because the control-cohort reconcile pass is first triggered after the publish and a cadre-cli node has no bootstrap-peer store entries for its siblings. Each commits an update to the same `CadrePeer` block at the same next revision with different content. That is a fork. The queue-and-re-issue path in "Writes made while alone" cannot heal it: the re-issue on the first growth edge is judged by the other node against its own copy and refused (`content-digest-mismatch`), and every later `CadrePeer` write is refused the same way. Healing an existing fork is upstream work (`tickets/blocked/forked-control-collection-sync-livelocks.md`, whose "Sixth trigger" section already records #53 with the reporter's numbers).

## Reproduction (verified)

`packages/integration-tests/src/scenarios/control-members-restarted-together.integration.ts`, new in this ticket, fails on HEAD and turns green with the fix. Run it with `yarn workspace @serfab/integration-tests exec vitest run control-members-restarted-together` (about 20 s).

Shape: phone-shaped owner A admits two `storage` members M1 and M2 (each on a raw store kept across the restart). A is cut off by a dial gate. M1 and M2 stop and restart together on the same listen addresses, each with a dial gate refusing the other in both directions. A member's first reconcile pass runs only after its boot publish has finished, and that pass dials the other member, so a refused dial on a member's gate is a positive signal that its boot publish is over. The scenario reads each member's own row then (the invariant: unchanged), opens the gates, waits until each member holds the other's fresh record, then reconnects A and adds a third machine M3, which both members must list. It does not depend on timing.

Measured on HEAD:
- 2 of 2 runs failed at the invariant: both own rows rewritten while alone, 12 ms apart (the report saw 40 ms).
- With that assertion temporarily removed (1 run, `DEBUG=sereus:cadre:node,sereus:cadre:control-db`), the downstream symptom of #53 appeared. Both boot publishes committed alone (`registerSelf: refreshed own CadrePeer record` followed by `Record refresh wired`, 11 ms apart, about 1 s after `CadreNode started`). Then each growth drain's re-issue was refused: `Control write abandoned [self-record-update] … Transaction rejected by validators (1/2 rejected): <other>: content-digest-mismatch`. The members never converged: `Timeout waiting for each restarted member publishes its record and holds the other's after 60000ms`.

Prototype (since reverted, with cadre-core rebuilt to match HEAD): in `scheduleSelfRegistration`, skip the publish and set `pendingSelfPeerWrite = true` when `ownerKeyWriteAlone()` is true. The new scenario passed 3 of 3 runs: both boot publishes deferred, the members held each other's fresh record 823 to 860 ms after the gates opened (two connected members publishing at the same moment resolve through normal consensus, without a fork), and M3 was added and listed by both. `control-write-while-alone-convergence` (2 tests) and `cadre-invite-any-member` also passed with the prototype, 1 run each.

## The invariant

A background control write (one no caller is waiting on) does not commit while this node is alone and the party has other authorized members. It defers to the next growth drain or connected reconcile pass, which already publish the self-record once a sibling is reachable.

- "Alone" is `!hasReachableControlSibling()` (`committedAlone()`), the predicate every other alone rule uses.
- "The party has other members" is `authorizedControlPeers.size > 0` (the snapshot excludes this node). Read it only after `membershipGateDrain` settles, because until `start()`'s first membership refresh lands the snapshot is empty and would read as a party with no other members.
- Both halves already exist as `CadreNode.ownerKeyWriteAlone()`, used by `addOwner`, `removeOwner`'s re-vouch and one more site (~10558). Rename it to a name that is not about owner keys (for example `controlWriteWouldFork()`), keep a single predicate for all callers, and fix its doc comment, which says "holds no control connection" where the predicate means "no reachable sibling".
- A lone founder (no other members) still publishes at boot: a party with no other members cannot fork.

## Where to apply it: one seam for the self-record

Every background self-record publish should go through one private method that checks the predicate. That covers the boot one-shot in `scheduleSelfRegistration` and both triggers of `startRecordRefresh`'s `republish` (the `self:peer:update` address change and the TTL heartbeat). When it defers, it sets `pendingSelfPeerWrite = true`, so the next growth drain publishes (`runDrainControlReplication` step 2 publishes when that flag is set, not only on the first growth). Without the flag, a heartbeat or address change deferred after the first growth would wait for the next heartbeat (up to 7.5 minutes), and the record could age past the 15-minute freshness limit (`DEFAULT_PEER_RECORD_MAX_AGE_MS`) at resolvers. The boot path must still call `startRecordRefresh()` and trigger the reconcile pass after a deferral, as the prototype did.

Not through that seam:
- `registerSelf()` itself stays unguarded. It is public and awaited by callers (`cadre start --owner` in `packages/cadre-cli/src/commands/start-owner.ts:204`, and scenarios such as `control-write-while-alone-convergence` that write alone on purpose), so it is user-initiated and still commits alone under the queue-and-re-issue rule.
- The growth drain and `publishFirstSelfRecord` run only once a sibling is reachable, so they need no new check.
- A deferral is not a failure. It must not call `escalateIfSelfRecordStale`, and it must not stamp `lastSelfRecordPublishAt` (so `publishFirstSelfRecord` keeps retrying on connected passes).

## Audit of other background control writers

List each in the review handoff with its disposition. The audit so far:

- Boot one-shot, heartbeat, `self:peer:update` republish: guard (above).
- `publishFirstSelfRecord`, the revoked-row reap sweep and `joinedStrands.syncWithParty` in `runReconcileControlCohort`: already gated on `hasReachableControlSibling()`.
- Growth drain (`runDrainControlReplication`: revocation re-issue, self row, `retouchSelfDeviceToken`, `reconstructAuthoredMembership`, pending owner authorizes, pending joins): runs on the reachability edge. The connection can drop mid-drain; that window exists today and is not this ticket's.
- `pending-join-runner.ts`: retries join writes on its own timers and re-issues those written alone (`reissueWritesMadeAlone`). That is the same queue-and-re-issue path that cannot heal a same-revision fork if a sibling writes the same table meanwhile. Read which control tables its timer-driven attempts write, and whether `deps.isAlone()` already defers them. If they commit alone in a party with other members, defer them under the same predicate (the runner's `isAlone` dependency can carry it), or record why not.
- Inbound handlers (cadre invitation and owner grant redemption, seed delivery): they write in answer to a connected peer, which is a reachable sibling or an admitting device (`admittingDevices`, counted by `isControlCohortMember`). Confirm.
- Search the rest of `cadre-node.ts` and the services it owns for any other control write started from a timer, event or `scheduleRuns` consumer (the strand watcher, the membership gate watch) and dispose of each.

## Edge cases to confirm by reading the code

- **A device redeeming within a second of start.** `scheduleSelfRegistration`'s doc comment cites this case. The device counts as reachable through `admittingDevices` once it has identified, so the node is not alone. Rewrite that comment, which currently says connectivity "does not matter".
- **Restart while the sibling stays down.** The node defers until a sibling appears. Check that nothing waits on that write while the node is alone: `relayStatus`, address resolution by others (they cannot reach it anyway), and the owner's seed minting. The new scenario's invariant assertion covers that the write did not happen.
- **The address changes while alone (relay rotation).** Deferred with the flag set; the growth drain publishes the current addresses.
- **The owner's re-touch of other machines' rows** (`reconstructAuthoredMembership` → `reauthorizeCadrePeer`) runs only in the growth drain, so not alone.
- **A revoked node, or one awaiting claim:** skipped as today.
- **An empty membership snapshot on a node that has members** (anchor never seeded, rows not yet replicated): reads as "no other members", so the node publishes alone as today. Put a `NOTE:` tripwire at the predicate if that case stays reachable.

## Docs

- `docs/architecture.md` → "Writes made while alone": state which writes commit alone (user-initiated ones, under the queue-and-re-issue rule) and which defer (background ones, in a party with other members), and why a re-issue cannot heal a write that took the same block to the same revision as a sibling's write. Name this ticket's slug, not the story. Add the new scenario to the "Proven by" line.
- `docs/architecture.md` → "Cadre Node" item 4 ("after the attempt the node makes a second after start") and the sentence near line 391 ("The boot-time publish a second after start …"): the boot publish now waits for a reachable sibling in a party with other members.
- `docs/testing.md` ~582: that paragraph says an owner makes its first publish about a second after `start()`. After the fix that holds only for a lone founder; a member of a party with others publishes on its first growth.

## Release note

A cadre already forked by 1.19.x stays forked after this fix. Healing it, and the torn multi-collection commit seen when adding a machine to it (`CoordinatorPartialCommitError`), still need the upstream work `tickets/blocked/forked-control-collection-sync-livelocks.md` waits on. Say so in the handoff.

## TODO

- Rename `ownerKeyWriteAlone` to a general name, fix its doc comment, keep its callers on it (`addOwner`, `removeOwner`, `redeemOwnerGrantLocally`). Update the name in `tickets/backlog/bug-owner-key-removal-revouch-made-alone-is-not-reissued.md`'s `files:` header, which cites it.
- Add the background self-record publish seam (guard plus `pendingSelfPeerWrite` on deferral); route the boot one-shot and both `startRecordRefresh` triggers through it; rewrite `scheduleSelfRegistration`'s doc comment.
- Audit the other background control writers (list above, `pending-join-runner.ts` first) and record each disposition in the handoff.
- Update `docs/architecture.md` (three places) and `docs/testing.md` as listed.
- Build cadre-core (`yarn workspace @serfab/cadre-core build`; the integration suite's stale-build guard checks it), then run the cadre-core tests, `control-members-restarted-together` (3 runs), `control-write-while-alone-convergence`, `cadre-invite-any-member`, `control-delete-while-alone-convergence`, `yarn lint` and `yarn typecheck`.
