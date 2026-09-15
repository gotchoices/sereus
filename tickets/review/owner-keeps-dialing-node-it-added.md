description: A phone that adds an always-on node to its group now remembers the addresses it was handed and dials the node from them, both right after adding it and after a restart. Before this, the phone had no address it would accept for the new node until the two were already connected, so they never connected.
files: packages/cadre-core/src/cadre-node.ts (addDrone, removePeer, warmSiblingAddrBook, refreshDialHint, resolveControlDialAddrs, retainedDialAddrs, recordSeedBootstrapPeers, retainDialTarget, bootstrapPeerStore field doc), packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/enrolled-machine-store.ts (doc only), packages/cadre-core/src/seed-bootstrap.ts (addDrone doc), packages/cadre-core/test/bootstrap-peer-store.spec.ts, packages/cadre-core/test/cadre-node-bootstrap-peers.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/control-dial-mixed-transports.spec.ts (new), docs/architecture.md, docs/reference-app-rn.md
----
# An owner keeps dialing a node it added — review handoff

## What changed

The node-local bootstrap-peer store (`bootstrap-peer-store.ts`: durable, per party, never replicated, grants no authority) used to hold only the owner peers a seed nominated. It now also holds the addresses an owner was handed when it added a node, and the steady-state reconcile pass uses them.

- **Record on add.** `CadreNode.addDrone` calls `retainDialTarget(dronePeerId, droneMultiaddrs)` after `SeedBootstrapService.addDrone` resolves. It records nothing when the list is empty, when the id is this node's own, or when `addDrone` throws. A persist failure is logged and the entry stays in memory. `recordSeedBootstrapPeers` now goes through the same helper, so the self/empty guards and the fire-and-log handling live in one place.
- **Third dial fallback.** `resolveControlDialAddrs` now tries, in order: the signed record, then the libp2p address book, then `retainedDialAddrs`, which is the retained entry bound to the peer id through `bootstrapDialAddrs`.
- **Keep the hint current.** In `warmSiblingAddrBook`, `refreshDialHint` replaces an EXISTING entry with the sibling's resolved signed-record addresses when the two sets differ. The comparison ignores order and runs after binding both lists to the peer id, so an entry recorded without `/p2p/` suffixes is not rewritten just for lacking them. It never creates an entry, and an empty resolution leaves the entry alone.
- **Forget on removal.** `BootstrapPeerStore.forget(peerId)` has the same contract as `record`: the change is visible synchronously and the promise tracks durability. It is implemented in the memory and persistent stores, and the file store inherits it from the persistent one. `NodeLocalSnapshot` gained `remove(key)`, which writes nothing for an absent key; `put` and `remove` share one `queuePersist`. `CadreNode.removePeer` forgets after the delete succeeds (fire-and-log).
- **Mixed transports.** No filtering was needed. libp2p 3.1.3's dial queue (`calculateMultiaddrs`) drops addresses the node has no transport for and fails only when none remain. The new `control-dial-mixed-transports.spec.ts` proves this with real libp2p: a WebSocket-only node dials a TCP-first TCP + `/ws` list and connects over `/ws`.
- **Docs.** Updated the store module doc, the `CadreNode` field doc, `SeedBootstrapService.addDrone`'s doc (it retains nothing itself; use `CadreNode.addDrone`, then `reconcileControlCohort()`), `docs/architecture.md` (the cohort bullet, the cold-start bullet, and step 9 of "Phone Adds Provider Drone") and `docs/reference-app-rn.md`.

No new public API. `addDrone` does not dial: the caller runs `reconcileControlCohort()` after delivering the seed, otherwise the next timed pass (about every 15 s) does it.

## Use cases to validate

- A phone adds a lent node whose row is unsigned, and the phone never applied a seed naming that node. The next pass dials the node from the handed-over addresses, each ending in `/p2p/<node>`.
- The phone relaunches after more than 15 minutes: the node's record is stale and the address book is empty, so the phone dials from the hint. The hint is left unchanged.
- The record is fresh and its addresses differ from the hint, for example a new port: the record is dialed and the hint is replaced once. The next pass does not rewrite it.
- `removePeer` on this node drops the entry; a failed `removePeer` keeps it.

## Validation run

- `yarn workspace @serfab/cadre-core test`: 128 files, 2113 passed, 1 skipped.
- `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn typecheck` in cadre-cli, cadre-host, reference-app-rn, reference-app-web and reference-app-ns (all consumers of the interface): clean.
- `yarn lint`: exit 0. `yarn check:test-file-typecheck-coverage` and `yarn check:vitest-typecheck-coverage`: pass.
- `packages/integration-tests` `control-cohort-cold-start-retry`: 1 passed. To run it I had to build cadre-core, and also cadre-host, whose `dist` was already stale at HEAD (the freshness guard refused to start). That was a rebuild, not a test failure, so no pre-existing-error report was filed.

## Known gaps and things to look at

- **No wire-level proof yet.** Nothing here runs a real phone-shaped adder against a real lent node; that is `donation-scenario-phone-shaped-requester`. The React Native caller still has to call `reconcileControlCohort()` after seeding (`rn-request-node-from-cadre-host`).
- **Only `CadreNode.addDrone` records.** The public `CadreNode.authorizePeer(peerId, multiaddrs)`, and `SeedBootstrapService.addDrone` called directly, retain nothing. That matches the ticket's scope; the reviewer should decide whether `authorizePeer` should retain too.
- **The refresh also rewrites seed-retained owner entries.** On a joiner, once its owner's record resolves with addresses different from the seed's, the entry becomes the record's. This was intended ("peers that already have an entry"), but it changes behaviour for seed entries, not just added nodes.
- **The address book outranks the hint.** While the process stays up, unverified address-book entries (seed or identify) are dialed instead of the hint until they age out (one hour). I judged this fine because those entries normally match the hint, but I did not measure it.
- **Tripwires left as `NOTE:` comments.** (1) `retainedDialAddrs`: a removal replicated from another owner does not forget the entry. The steady-state pass is unaffected, but the cold-start branch still dials every entry; prune entries for retired rows if that ever causes dial churn. (2) `refreshDialHint`: it replaces rather than merges, so a node whose record announces fewer reachable addresses than it was added with gets the worse set after a relaunch.
- **`node-local-snapshot.spec.ts` has no direct `remove` test.** `remove` is covered through `PersistentBootstrapPeerStore` in `bootstrap-peer-store.spec.ts`: removal survives a reopen, an absent key writes nothing, and a failed persist rejects while the removal holds in memory and lands with the next write.
