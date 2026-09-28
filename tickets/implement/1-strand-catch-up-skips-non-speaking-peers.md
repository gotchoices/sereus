description: After a strand peer connects, the node pushes its stored blocks to it, but it also tries this against the relay, which cannot receive strand data, and after three failures prints a warning naming the relay. Stop the catch-up from targeting peers that do not speak the strand's block-transfer protocol.
architecture: docs/architecture.md#strand-networks
files: packages/cadre-core/src/peer-join-backfill.ts, packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/src/strand-instance-manager.ts, docs/strands.md
difficulty: easy
----

## Why

gotchoices/sereus#18: two relay-only parties restart, replication stops, and the only recurring line in both logs is

```
[cadre:<strandId>] peer-join block catch-up to peer <relay> has failed 3 times in a row (dial budget 8000ms, response budget 10000ms)
```

The relay is a connected peer of every strand node but speaks no `/optimystic/strand-<id>/…` protocol, so the push can never land. The failure is real but meaningless, and it sent the reporter down the wrong path. The maintainer decision on `feat-cross-party-strand-addr-durability` (2026-09-27) item 4 is to stop targeting such peers at all. This ticket is independent of the address-book work and goes first because the next ticket (`strand-peer-book-local`) needs the same "does this connected peer speak the strand's protocol" test.

## Where it lives today

`packages/cadre-core/src/peer-join-backfill.ts`:

- `start()` subscribes to the network's `connection:open` and `scheduleConnectedPeers()` enumerates `libp2p.getConnections()`, so every connected peer, relay included, is scheduled.
- `runCatchUp` dials `BlockTransferClient` at `buildBlockTransferProtocol(protocolPrefix)` (db-p2p: `${protocolPrefix}/db-p2p/block-transfer/1.0.0`). A non-speaking peer fails the first chunk, `peerUnreachable()` bails out of the rest, `scheduleRetryWithBackoff` re-arms it on a doubling backoff, and `warnPersistentFailure` prints the `console.warn` after `PEER_JOIN_BACKFILL_WARN_AFTER_FAILURES` (3).
- The module comment already carries a `NOTE:` saying "pre-check `libp2p.peerStore` for this network's block-transfer protocol before enumerating" if this ever costs too much. The condition has now tripped in a different way: the cost is not CPU but a misleading warning. Replace that note with the mechanism.

## Design

**Schedule on `peer:identify`, not `connection:open`.** libp2p's identify runs on every new connection and its `peer:identify` event (`IdentifyResult { peerId, protocols, listenAddrs }`) names the protocols the remote supports. A peer whose `protocols` does not include `buildBlockTransferProtocol(protocolPrefix)` is not a member of this network's data plane and is never scheduled. That covers the relay, a bootstrap node, and on the control network (which uses the same class with `authorizePeer`) any stranger admitted by the inbound gate.

Concretely:

- `PeerJoinBackfillDeps` gains nothing; `protocolPrefix` is already there. Add a small pure helper, exported for the next ticket: `speaksBlockTransfer(protocols: readonly string[], protocolPrefix: string): boolean`.
- `start()`: subscribe to `peer:identify`; in the handler, schedule only when `speaksBlockTransfer(detail.protocols, prefix)`. Keep `scheduleConnectedPeers()` for the start-time sweep and for the control network's membership-change re-drive, but make it consult `peerStore.get(peerId)` (protocols are persisted there after identify) and skip a peer whose stored protocols are known and lack ours. A peer with no stored protocols yet (identify not finished) is left to the `peer:identify` handler rather than dialed blind.
- `stop()` removes the identify listener like the existing `connection:open` one. Decide whether to keep `connection:open` at all: it is redundant once identify drives scheduling. Remove it unless a test shows identify does not fire in some fixture; if you keep it, it must apply the same protocol filter. Say which in the handoff.
- `runCatchUp` keeps its unreachable-peer bail as a backstop; do not remove it.
- Update the module comment: the paragraph on strand networks ("A peer that does NOT speak the strand's block-transfer protocol … the dial fails and the push is dropped") now describes what used to happen. State the new rule and why (the #18 warning).

**Do not** add the filter to `PeerJoinBackfill` callers in `strand-instance-manager.ts` or `cadre-node.ts`; the class owns its peer selection.

## Edge cases & interactions

- **Identify arrives after `scheduleConnectedPeers()` at start.** The peer is skipped by the sweep (no stored protocols) and picked up by the identify event. Verified by the unit test below with a fake libp2p that emits identify after `start()`.
- **Identify never fires for a connected peer.** That peer is never caught up by this path. db-p2p nodes always run identify, and read repair still covers reads. Note it in the module comment as the accepted cost; no test.
- **Control network: a member's identify lists the protocol but the membership gate denies it.** Unchanged: denial is still judged at push time in `runCatchUp`, and `scheduleConnectedPeers()` on a membership change still re-drives. Verified by the existing control-backfill tests (`cadre-node-control-backfill.spec.ts`) staying green.
- **A peer that re-identifies with a changed protocol list** (identify push after the remote restarts a service). The handler runs again; `done`/`retryAfter` memoization still applies. Inspection.
- **The `warned` set and the `NOTE:` about many non-speaking connections.** Both become moot for non-speakers; leave the warning in place for genuine speakers that cannot be reached, which is what it was written for.
- **The integration scenarios that count backfill pushes** (`strand-late-cadre-join`, `strand-membership-closed-strand-e2e` whole-store coverage gate) must stay green; they are the proof that real strand peers are still scheduled.

## Tests

One new unit test in `packages/cadre-core/test/peer-join-backfill.spec.ts`: a connected peer whose identify carries no block-transfer protocol is never dialed, never re-armed, and never warned, while a peer whose identify does carry it is pushed to. This pins the branching that the #18 report tripped on. Reuse the spec's existing fake libp2p; extend it with `peer:identify` dispatch and a `peerStore.get` that returns stored protocols.

## Docs

`docs/strands.md`: the "peer-join catch-up" mention in the relay/`Some Questions` area and anywhere the catch-up is described should say the catch-up targets only peers that speak the strand's protocol, so the relay is never a target. One sentence. Add a bullet to `.release-notes.pending.md` under a heading for this issue (create `## Fixes` if the file has no headings yet) naming gotchoices/sereus#18 and the misleading warning.

## TODO

- Add `speaksBlockTransfer` and the `peer:identify`-driven scheduling; filter `scheduleConnectedPeers()` through stored protocols; decide the fate of the `connection:open` listener and record it.
- Rewrite the module comment paragraphs that describe the old behaviour and the pre-check `NOTE:`.
- Unit test as above.
- Run `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`, and the integration scenarios `strand-late-cadre-join`, `strand-membership-closed-strand-e2e`, `blind-relay-phone-to-phone-e2e` in the foreground.
- Doc sentence and release-note bullet.
