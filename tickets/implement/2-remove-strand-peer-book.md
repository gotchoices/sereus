description: Delete Sereus's own per-workspace address book, the code that swaps it between machines, and the setting apps used to supply its storage, now that the ring library's saved routing table does the same job. Keep the two things the book also did that the routing table does not: remembering the addresses a new invitation hands over, and keeping other parties' addresses from expiring while the node runs.
prereq: strand-network-state-persisted
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-peer-book.ts, packages/cadre-core/src/strand-peer-book-swap.ts, packages/cadre-core/src/strand-peer-book-protocol.ts, packages/cadre-core/src/strand-peer-book-file.ts, packages/cadre-core/src/strand-peer-observer.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/package.json, packages/cadre-core/test/strand-peer-book.spec.ts, packages/cadre-core/test/strand-peer-book-protocol.spec.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-host/src/orchestrator/node-identity.ts, packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/node-local-slots.ts, packages/reference-app-rn/src/phone-node-config.ts, packages/reference-app-rn/test/node-local-slots.spec.ts, packages/reference-app-rn/test/phone-node-config.spec.ts, packages/reference-app-rn/test/solo-founding.spec.ts, packages/reference-app-web/src/lib/cadre-web.ts, packages/reference-app-web/src/lib/node-local-slots.ts, packages/reference-app-web/src/lib/store.svelte.ts, packages/reference-app-web/src/Home.svelte, packages/reference-app-web/test/node-local-slots.spec.ts, packages/reference-app-ns/src/cadre-phone.ts, packages/reference-app-ns/src/node-local-slots.ts, packages/reference-app-ns/test/cadre-phone.spec.ts, packages/reference-app-ns/test/node-local-slots.spec.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/strand-restart-party.ts, packages/integration-tests/src/harness/fixtures/strand-restart-party.mjs, packages/integration-tests/src/scenarios/strand-relay-only-restart-reconverges.integration.ts, packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts, packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts, packages/integration-tests/src/scenarios/strand-always-on-replica-survives-phone-loss.integration.ts, tickets/backlog/debt-strand-peer-book-remote-write-bounds.md, docs/architecture.md, docs/strands.md, docs/testing.md, .release-notes.pending.md
difficulty: hard
----
# Remove the strand peer book

## Why

`strand-network-state-persisted` gave every strand node db-p2p `persistence`, so FRET's routing table survives a restart. The table carries each peer's signed address record, and neighbour snapshots forward those records live, which is FRET 1.0.0's replacement for the book's signed swap. That ticket's gate ran the gotchoices/sereus#18 restart scenario with the book at its in-memory default, and both arms re-converged. The maintainer does not want the duplicate (2026-09-28). There is no backwards-compatibility obligation.

**Start by confirming the gate still holds.** Run the #18 scenario's default arm once before deleting anything. If it does not converge, stop and route to `blocked/`, as the previous ticket describes.

## What the book did, and where each job goes

| Book job | Replacement |
|---|---|
| Restart: dial the other party's strand nodes first (`resolveCohortSeed` unions the book in) | The saved FRET table re-imports signed records into the peerStore; FRET stabilization dials its neighbours. The seed becomes siblings plus formation addresses only (below). |
| Swap: third parties and address rotation while apart (`/sereus/strand-peers/1.0.0`) | FRET neighbour-snapshot address hints. |
| Formation: `recordFormationStrandPeers` files the responder's carried `strandAddrs`, which the first attach's seed reads | **An in-memory per-strand map in `CadreNode`** (below). |
| Running node: `refreshOneStrandPeerAddrs` re-merges book addresses into the strand node's peerStore every 15 s | **Re-merge addresses from the running strand node's FRET table records** (below). |

### Formation-carried addresses

Replace `recordFormationStrandPeers`'s book write with `formationStrandAddrs: Map<strandId, string[]>` on `CadreNode`. A re-formation replaces the strand's list; it does not union onto it. The map is read by `resolveCohortSeed` as `unionAddrs(siblings, formationStrandAddrs.get(strandId) ?? [])`, so the first attach dials the responder exactly as it did through the book. It is cleared where the book was forgotten (`unpublishStrand`, `forgetJoinedStrand`, self-revocation). It is kept across `stop()`→`start()` of the same `CadreNode`, as the book's memory default was. When the strand is already running (a re-formation, which is the recovery path for a dead address), `formStrand` also merges the new addresses straight into that strand node's peerStore through `mergeStrandPeerAddrs`, rather than waiting for a refresh tick.

Accepted tradeoff: a process restart between `formStrand` and the strand's first launch loses the carried addresses. The strand then launches with no cross-party seed until it is re-formed. Every embedder launches immediately after forming, and once the strand has run, the saved FRET table covers every later restart. Record this as a `NOTE: accepted tradeoff` at the map, with the revisit condition: an embedder that forms and launches in separate sessions. Persisting the list on `JoinedStrandRecord` was weighed and rejected. It would mix address state into the join record, which the maintainer wants kept separate, and it would need a "only until the first run" rule to stop dead addresses being dialled on every launch.

### Keeping other parties' addresses alive in a running node

libp2p's peerStore (`@libp2p/peer-store` 12.0.10) hides every address one hour after it was first observed. Because of an upstream bug, `merge` cannot refresh that stamp; see the `NOTE:` on `mergePeerAddrs` in `peer-addr-book.ts`, whose `save`-based restamp is the workaround. FRET does not re-apply the records it holds (it consumes a record only when a snapshot hint arrives or at import, and libp2p's `consumePeerRecord` refuses a record whose sequence number it already has). Without the book's 15-second re-merge, then, a running node whose connection to another party's strand node drops more than an hour after that peer was first seen has no address to redial. The other side redials only if it still holds a live address, and it has the same problem.

Replace `strandPeerBookAddrs` in `refreshOneStrandPeerAddrs` with a read of the running strand node's FRET table. Take `services.fret.exportTable()` off the strand node, accessed through a narrow structural type and treated as empty when absent. For each entry that is not self and has an `addressRecord`:
- decode the base64url envelope;
- open and verify it with `@libp2p/peer-record` (`RecordEnvelope.openAndCertify(bytes, PeerRecord.DOMAIN)`, then `PeerRecord.createFromProtobuf(envelope.payload)`). Add `@libp2p/peer-record` to cadre-core's dependencies, `^9.0.5`, matching FRET's;
- check that the record's peer id equals the entry id;
- bind each multiaddr to the peer with `withTrailingPeerId` (`peer-record.ts`), because a relay-only peer's circuit address ends in `/p2p/<relay>/p2p-circuit`;
- call `mergePeerAddrs(strandNode, entryId, addrs)` per peer, with no `groupAddrsByPeerId` pass, since attribution is already known.

A record that fails to decode or verify is skipped and counted in the pass's log line. The sibling half of the pass (the strand-addr RPC) is unchanged. Rewrite the `NOTE:`s on `refreshOneStrandPeerAddrs` and `mergeStrandPeerAddrs` that describe the book's ageing (14 days, 16×16) in terms of FRET's: a record is held while FRET holds the entry, and at most 14 days after it was last confirmed.

## Remove

- `strand-peer-book.ts`, `strand-peer-book-swap.ts`, `strand-peer-book-protocol.ts`, `strand-peer-book-file.ts` and its `package.json` subpath `./strand-peer-book-file`. Also remove `strand-peer-observer.ts`: its only consumer is the book (`onStrandPeerIdentified`), and `connectedIdentifiedPeers` is used only by the observer and the swap. Remove their exports from `index.ts` (including `dialableAddrs`, `connectedIdentifiedPeers` and `AddrLike`), after checking with `yarn knip` and grep that nothing else imports them.
- `CadreNodeConfig.strandPeers`, `initializeStrandPeerBookStore`, `strandPeerBookStore`, `getStrandPeerBookStore()`, `observeStrandPeer`, `rememberStrandPeer`, `StartStrandConfig.onStrandPeerIdentified` and `StartStrandConfig.strandPeerBook`, along with the manager's `peerObservers` and `peerBookSwaps` maps and their arm and release code in `strand-instance-manager.ts`. The NOTE about "a third `peer:identify` listener per strand" becomes stale; rewrite it for the listener that remains.
- The book's mention in `node-local-snapshot.ts`'s module comment.
- Embedders: cadre-cli `start` (the `FileStrandPeerBookStore` open), the RN, web and NS `strand-peers.<party>` slot key and its opening, and their tests that name it. The web app's `strandPeers` diagnostic count (`store.svelte.ts`, `Home.svelte`) was a book count, so remove it. Leave old on-device slots and files in place; the release note tells embedders they may delete them.
- Integration harness: `controlNodeConfig`'s `strandPeerBook` option; the child fixture's book (already dropped by the previous ticket) and its `getStrandPeerBookStore` op in `strand-restart-party.ts`/`.mjs`.
- The `cadre-core` specs `strand-peer-book.spec.ts` and `strand-peer-book-protocol.spec.ts`. In `cadre-node-strand-seed.spec.ts` and `cadre-node-strand-addr-refresh.spec.ts`, rewrite the cases that seed the book so that they pin the two replacements: the formation map reaching the seed, and FRET records reaching the address book. Delete any case that only restated the book.
- `tickets/backlog/debt-strand-peer-book-remote-write-bounds.md`: delete it. Its protections were requirements on FRET's ticket, and the code it names is gone. Note this in the handoff.

## Scenarios

- `strand-relay-only-restart-reconverges`: remove the book assertions. After the previous ticket, these are the post-restart "each book holds the other side's entry signed after the restart" check and any book reads left in the child. What the scenario proves stays the same: both arms, phase 2 both ways, all paths relayed, and the pre-restart saved-table gate. Run the default arm and the two-process arm; run the negative control once.
- `strand-formation-cross-party-seed`: it asserts book contents on both sides. Replace those assertions with ones on the new seam: the joiner's first attach dials the formation-carried address and the strand nodes connect. This is the "formation-carried addresses still get dialled on the first attach" check. Run it.
- `blind-relay-phone-to-phone-e2e` and `strand-always-on-replica-survives-phone-loss`: remove the book references and run both.

## Edge cases & interactions

- **First attach with no saved table and no formation map** (a joiner re-offered a strand after a restart that happened before its first launch): the seed is empty and the strand waits. This is the accepted tradeoff above. By inspection.
- **Hibernation resume** goes through `resolveCohortSeed`, which now reads the formation map instead of the book, and imports the saved table via `persistence`. By inspection.
- **A peer that rotated its address while this node was apart:** the new record reaches this node through a FRET hint from any common neighbour, or through identify when the peer dials in. In a two-party strand there is no common neighbour, so the rotated peer has to dial us. The book's swap had the same limit, so this is not a regression. By inspection; say so in the docs.
- **FRET service absent** on a strand node (a db-p2p build without it) makes the re-merge a no-op, with no throw and no per-tick log spam. By inspection.
- **Refresh cost:** `exportTable()` serialises the whole table every 15 s tick, per running strand. That is fine at strand table sizes. Park a `NOTE:` tripwire: if many strands or large tables make it show up, read only entries whose address stamp is near the one-hour mark.
- **Decode/verify failure** on a record must not abort the pass for the other peers. A test covers it only if the loop has a branch beyond skip-and-count.
- **The identity-less random strand key** (`launchStrand` generating an Ed25519 key when neither `keyStore` nor `privateKey` is set) was added for the swap's signing. Keep it: the delegate announcement uses it too, and FRET seals its own record with the node's key. Its tests stay.
- **No stale references:** grep the repo, excluding `dist/` and `tickets/complete/`, for `strand-peer-book`, `StrandPeerBook`, `strandPeers`, `strand-peers`, `/sereus/strand-peers/1.0.0`, `StrandPeerObserver` and `onStrandPeerIdentified`. Expect zero hits.

## Docs and release note

- `docs/architecture.md`: remove `/sereus/strand-peers/1.0.0` from the protocol list. Rewrite the Strand-Address Resolution bullets for the book and the swap as the saved FRET table plus the formation map plus the FRET-record re-merge. Update the paragraph at line ~76 on cross-party meshes ("each side then remembers the other in its node-local strand peer book … signed book swap"): FRET's hints are what now reach members met since. Update the node-local snapshot paragraph, and the "And the same pair restarting" paragraph under Relay Integration.
- `docs/strands.md`: "How a restarted machine re-finds its strand's peers", and the joined-strand section's closing paragraph that says the record needs the durable book beside it (it now needs the network-state store).
- `docs/testing.md`: the topology line for the restart shape.
- `.release-notes.pending.md`: under one heading, say that the strand peer book, `CadreNodeConfig.strandPeers`, the `@serfab/cadre-core/strand-peer-book-file` subpath and the `/sereus/strand-peers/1.0.0` protocol are removed. Say what replaces the `strandPeers.store` embedders were passing: `strandNetworkState.store` (`PersistentStrandNetworkStateStore` / `FileStrandNetworkStateStore`), already added by the previous release note bullet, so merge the two bullets. Say that old `strand-peers.<party>` slots and files can be deleted. State that there is no compatibility with a node still running the swap protocol: it logs the missing protocol and skips.

## TODO

- Run the #18 default arm once; stop and route to `blocked/` if it fails.
- Add the formation map and the direct merge into a running strand on re-formation.
- Replace the refresh pass's book read with the FRET-record re-merge; add the `@libp2p/peer-record` dependency.
- Delete the book, swap, protocol, file store, observer, config, wiring and exports.
- Update the embedders and the integration harness.
- Rewrite the seed and refresh specs; delete the two book specs.
- Update the four scenarios and run them.
- Delete `backlog/debt-strand-peer-book-remote-write-bounds.md`.
- Docs and release note.
- `yarn lint`, `yarn typecheck`, `yarn knip`, `yarn workspace @serfab/cadre-core test`, and the reference-app unit suites.
