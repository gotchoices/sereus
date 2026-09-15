description: When a phone adds an always-on node to its group, the phone never actually connects to it and could not find it again after a restart. The phone only dials addresses a node has signed itself, and it cannot receive those until the two are already connected. Keep the address the phone was handed as a lasting dial hint, and use it whenever nothing better is known.
files: packages/cadre-core/src/cadre-node.ts (addDrone ~6502, removePeer ~6362, warmSiblingAddrBook ~2820, resolveControlDialAddrs ~2931, dialColdStartBootstrap ~3026, recordSeedBootstrapPeers ~2978, bootstrapDialAddrs), packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/seed-bootstrap.ts (addDrone doc ~1150), packages/cadre-core/test/bootstrap-peer-store.spec.ts, packages/cadre-core/test/cadre-node-bootstrap-peers.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md (Enrollment Flow: Phone Adds Provider Drone)
----
# An owner keeps dialing a node it added

Split from `phone-adds-cadre-host-node-to-its-cadre`. Shared cadre-core code: it serves a phone adding a cadre-host lent node, a provider drone, or any drone added through `addDrone`.

## Terms

- **Adder**: the owner node that calls `CadreNode.addDrone({ dronePeerId, droneMultiaddrs })`. In the case this ticket is for, a phone that cannot listen.
- **Signed record**: a peer's `CadrePeer` row after the peer has published its own addresses with its own signature (`registerSelf`). `resolvePeerAddrs` (`cadre-node.ts` ~2422) returns addresses only from such a row, and only while it is fresh (`DEFAULT_PEER_RECORD_MAX_AGE_MS`, 15 minutes; the owner republishes every 7.5).
- **Bootstrap-peer store**: the node-local, non-replicated, durable store of dial targets learned out of band (`bootstrap-peer-store.ts`). Today it holds only the owner peers a seed nominated.

## What goes wrong today (read, not run)

1. `addDrone` → `SeedBootstrapService.authorizePeer` inserts the drone's row with `sig: null` (`seed-bootstrap.ts` ~311). The addresses the adder was handed land in that unsigned row, and `resolvePeerAddrs` rejects it (signature check), by design.
2. The adder's reconcile pass (`runReconcileControlCohort`) now lists the drone as a sibling, so it takes the steady-state branch, not the cold-start branch. For the drone, `resolveControlDialAddrs` (~2931) tries the signed record (empty), then the libp2p address book (`peerStoreAddrs`, empty on the adder, which never applied a seed naming the drone), and skips it: "no dialable control address for sibling".
3. The drone cannot dial a phone. So the two never connect, the drone never self-publishes into the party, and the signed record that would unblock step 2 never arrives.
4. Even after a first connection, a phone offline for more than 15 minutes relaunches with only a stale signed record for the drone, and hits the same dead end. The libp2p address book will not help: unverified entries age out after an hour (`peer-addr-book.ts`) and are not durable on a phone.

The architecture guide's "Phone Adds Provider Drone" flow says "9. Dial drone (outbound, NAT-safe)"; nothing in the code does it.

## Design

The adder keeps the drone's handed-over addresses in the bootstrap-peer store and treats that entry as the last dial fallback for that peer.

- **Record on add.** In `CadreNode.addDrone`, after `seedBootstrapService.addDrone` resolves, call `bootstrapPeerStore.record(dronePeerId, droneMultiaddrs)` when the list is non-empty. Same fire-and-log handling as `recordSeedBootstrapPeers`: the entry is visible synchronously, and a persist failure is logged, not thrown. Factor the shared "retain and log" into one private helper used by both.
- **Third dial fallback.** `resolveControlDialAddrs(peerId, resolved)` order becomes: signed record → address book → retained store entry, the last normalised through `bootstrapDialAddrs(peerId, entry.addrs)` so every address is bound to that peer id.
- **Keep the hint current.** In `warmSiblingAddrBook`, for a sibling that has a retained entry and whose signed record resolved, re-record the entry when the resolved address strings differ from the stored ones (order-insensitive compare). This carries a port or LAN address change the adder saw while connected into its next relaunch. Only peers that already have an entry are refreshed; the store must not grow into a copy of every sibling's addresses.
- **Forget on removal.** Add `forget(peerId): Promise<void>` to `BootstrapPeerStore` (same contract as `record`: reflected in `all()` synchronously, the promise tracks durability), implemented in `MemoryBootstrapPeerStore`, `PersistentBootstrapPeerStore` and `FileBootstrapPeerStore`. `CadreNode.removePeer` calls it after the delete succeeds.
- **Wording.** Generalise the store's module doc and `BootstrapPeerEntry` doc from "owner peers a seed nominated" to "dial targets learned out of band: a seed's owner peers, and nodes this node added". The trust argument is unchanged: an entry grants no authority and every dial is bound to the retained peer id.
- **No new public API and no dial inside `addDrone`.** At `addDrone` time the seed has not reached the drone yet. The caller triggers the dial after seeding with the already-public `reconcileControlCohort()` (the React Native ticket does exactly that); otherwise the next timed pass does it.

Why the store and not a new field or table: it is already the durable, per-party, non-trust-bearing home for "addresses I was told out of band, used to get back in", it already has Node, React Native (LevelDB) and browser backends, and the cold-start branch already reads it.

## Edge cases & interactions

- **Mixed address list.** A cadre-host lent node reports TCP and `/ws` addresses on loopback and LAN interfaces, none carrying `/p2p/`. `bootstrapDialAddrs` encapsulates the peer id. Verify that one `dial()` over the normalised list succeeds over `/ws` on a WebSocket-only node rather than failing the whole list; if libp2p rejects a list with any undialable entry, filter to addresses the node's transports can dial before dialing (and say so in a comment).
- **Empty `droneMultiaddrs`.** Record nothing (the persistent loader drops empty entries anyway).
- **`addDrone` throws** (not an owner, insert refused): record nothing.
- **Adding self, or a peer already retained from a seed:** `record` replaces, which is the documented semantics; adding self must not create an entry (the cold-start pass would dial itself forever). Guard with the same self check `recordSeedBootstrapPeers` uses.
- **Signed record fresh:** the hint is not used for dialing (resolved wins), only refreshed when different.
- **Signed record stale** (adder offline > 15 minutes): the hint is used, the connection lands, sync refreshes the record, and the next pass refreshes the hint if the addresses moved.
- **Hint stale too** (the drone moved while the adder was offline): the dial fails each pass, cheaply, as the cold-start pass already does. Nothing here can fix it; the cadre-host side keeps ports stable across respawn (`donated-node-reachable-by-phone`).
- **Peer removed by another owner.** `removePeer` on this node forgets the hint, but a removal replicated from elsewhere does not. The steady-state branch consults hints only for current siblings, so a revoked peer is not dialed there. The cold-start branch (no siblings at all) still dials every entry. Leave it, with a `NOTE:` at the fallback: if hints for revoked peers ever cause dial churn, prune entries whose peer has a retired row during the membership refresh.
- **Concurrent reconcile and add.** `reconcileControlCohort` is single-flight and the store returns snapshots, so a hint recorded mid-pass is simply seen on the next pass.
- **Dial by bare peer id elsewhere.** Optimystic's cluster clients and FRET dial by peer id through the address book, which the hint does not populate. That is intended: once the connection exists those layers use it, and after it drops the reconcile pass redials. Do not merge unverified hint addresses into the address book; `mergePeerAddrs`'s doc explains why that helper takes only verified addresses.
- **Party scope.** The store is per party; a node started under a different party id sees different entries. On the React Native app that matters only once the party id persists (`backlog/feat-rn-persist-node-start-options`).

## Tests

- `bootstrap-peer-store.spec.ts`: `forget` removes the entry synchronously in all three backends; the persistent and file backends round-trip a forget across a reload; forgetting an unknown peer is a no-op.
- `cadre-node-bootstrap-peers.spec.ts` (or beside it): `addDrone` records the drone's addresses; an empty list records nothing; a failing `addDrone` records nothing; `removePeer` forgets.
- `cadre-node-control-cohort.spec.ts`: a sibling whose signed record does not resolve and whose address book entry is empty is dialed from its retained hint, with every dialed address ending in `/p2p/<that peer>`; a sibling whose record resolves is dialed from the record, not the hint; a resolved record with different addresses replaces the hint, and an identical one does not rewrite it (count `record` calls).
- Keep the cold-start retry proof green: `packages/integration-tests/src/scenarios/control-cohort-cold-start-retry.integration.ts`.
- The wire-level proof with a phone-shaped adder and a real lent node is `donation-scenario-phone-shaped-requester`.

Run: `yarn workspace @serfab/cadre-core test`, `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`.

## TODO

- Add `forget` to `BootstrapPeerStore` and its three implementations; update the module and entry docs.
- Extract the "retain and log" helper; call it from `recordSeedBootstrapPeers` and from `CadreNode.addDrone` (with the self and empty-list guards).
- Add the retained-hint fallback to `resolveControlDialAddrs`, with the revoked-peer `NOTE:`.
- Refresh an existing hint from a resolved, differing signed record in `warmSiblingAddrBook`.
- Call `forget` from `CadreNode.removePeer`.
- Verify the mixed-transport dial behaviour and filter only if needed.
- Update `SeedBootstrapService.addDrone`'s doc and `docs/architecture.md` → "Enrollment Flow: Phone Adds Provider Drone" (step 9: the adder dials from the retained hint; the caller may trigger it with `reconcileControlCohort()`).
- Unit tests listed above; run cadre-core tests, typecheck, lint.
