description: A phone that adds an always-on node to its group now remembers the addresses it was handed and dials the node from them, both right after adding it and after a restart. Before this, the phone had no address it would accept for the new node until the two were already connected, so they never connected.
files: packages/cadre-core/src/cadre-node.ts (addDrone, authorizePeer NOTE, removePeer, warmSiblingAddrBook, refreshDialHint, resolveControlDialAddrs, retainedDialAddrs, recordSeedBootstrapPeers, retainDialTarget), packages/cadre-core/src/bootstrap-peer-store.ts, packages/cadre-core/src/bootstrap-peer-store-file.ts, packages/cadre-core/src/node-local-snapshot.ts, packages/cadre-core/src/seed-bootstrap.ts (addDrone doc), packages/cadre-core/README.md, packages/cadre-core/test/bootstrap-peer-store.spec.ts, packages/cadre-core/test/cadre-node-bootstrap-peers.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/cadre-core/test/cadre-node-control-replication.spec.ts, packages/cadre-core/test/node-local-snapshot.spec.ts, packages/cadre-core/test/control-dial-mixed-transports.spec.ts, docs/architecture.md, docs/cadre-host.md, docs/reference-app-rn.md
----
# An owner keeps dialing a node it added

## What landed

The node-local bootstrap-peer store (`bootstrap-peer-store.ts`: durable per party, never replicated, grants no authority) holds two kinds of dial target. One is the owner peers a seed nominated. The other, new here, is the addresses an owner was handed when it added a node through `CadreNode.addDrone`.

- **Record on add.** `CadreNode.addDrone` retains the drone's addresses after `SeedBootstrapService.addDrone` succeeds. It skips self and an empty list, and a persist failure is logged while the entry stays in memory. Seed intake uses the same helper, `retainDialTarget`.
- **Third dial fallback.** The steady-state reconcile pass dials a sibling from its signed record, then the libp2p address book, then its retained entry (`retainedDialAddrs`, bound to the peer id).
- **Keep the hint current.** `refreshDialHint` replaces an existing entry with the sibling's resolved record addresses when they differ. The comparison ignores order and missing `/p2p/` suffixes. It never creates an entry and ignores an empty resolution.
- **Forget on removal.** `BootstrapPeerStore.forget` (memory, persistent and file backends) and `NodeLocalSnapshot.remove`. `CadreNode.removePeer` forgets once the delete has committed.
- **Mixed transports.** No filtering: libp2p's dial queue drops addresses the node has no transport for. `control-dial-mixed-transports.spec.ts` proves it with real libp2p.
- **Write-while-alone queueing on add (review fix).** `CadreNode.addDrone` now queues the drone's row for re-replication when it committed with no control connection, as `authorizePeer` already did.

Callers still have to run `reconcileControlCohort()` after delivering the seed to dial at once; otherwise the next timed pass does it. The wire-level proof is `donation-scenario-phone-shaped-requester`, and the React Native caller is `rn-request-node-from-cadre-host`.

## Review findings

Read the implement diff (`4a0a247`) before the handoff, plus the code around each touched site: `runReconcileControlCohort`, `dialColdStartBootstrap`, `peerStoreAddrs`, `resolvePeerAddrs`, `noteControlWrite`, `authorizePeer`, `SeedBootstrapService.addDrone` and `authorizePeer`, and every caller of `addDrone` and `authorizePeer` across packages.

**Correctness**
- **Fixed: `CadreNode.addDrone` did not queue its write for re-replication.** `authorizePeer` calls `noteControlWrite(peerId, 'authorize')`, but `addDrone` inserts the same row and did not. This predates the ticket but hits its main use case: a phone adding its first always-on node has no control connection, so the insert commits local-only. The owner's "reconstruct the queue on the first growth after start" pass covered the common case, but not a phone whose earlier connection had already dropped in the same process. Added the call and two tests in `cadre-node-control-replication.spec.ts` (queued when alone, cleared when connected).
- **Checked, no defect:** the self and empty guards in `retainDialTarget`. In `refreshDialHint`, set equality by size plus containment is sound because `normalizeDialAddrs` de-duplicates both sides. In `removePeer`, `?.forget(...).catch(...)` short-circuits the whole chain when the store is null. The single `all()` snapshot in `warmSiblingAddrBook` is safe because `record` replaces entries rather than mutating them.
- **Decided: `authorizePeer` does not retain its `multiaddrs`.** The implementer left this open. The flows that use `authorizePeer` have the new peer reach the owner (it applies a seed naming the owners, or dials in with an invite). Several unit tests also pass it fictitious addresses (for example `8.8.8.8`), which background reconcile passes would then dial. Parked as a `NOTE:` tripwire at `CadreNode.authorizePeer`: retain the addresses there if a flow ever vouches a peer that cannot reach the owner.
- **Accepted as designed:** the refresh also rewrites seed-retained owner entries, and address-book entries take priority over the hint while the process is up. A seed's owner addresses are projected from the same `CadrePeer.Multiaddr` column the record carries, so the two normally agree. The "announces fewer reachable addresses" risk is already a tripwire at `refreshDialHint`.

**Error handling and resource cleanup**
- **Fixed (minor):** `PersistentBootstrapPeerStore.forget` logged "forgotten" even when there was no entry, which the memory backend did not do. It now logs only when the entry exists.
- Persist failures in record, refresh and forget are all logged and none is swallowed. Nothing is opened that needs closing.

**Tests**
- **Added:** `node-local-snapshot.spec.ts` gets a direct test that `forget()` joins the same serialised write chain as `record()`: one save at a time, with the last snapshot omitting the forgotten peer. The implementer flagged that `remove` had no test at this level, and a `remove` that bypassed the chain would fail it.
- The implementer's coverage is otherwise adequate: store contract across three backends, wiring of add and remove including failure paths, all four fallback-and-refresh cases against the real resolver, and the real-libp2p mixed-transport dial.
- Not unit-tested, by design: the full phone-to-lent-node path, which is `donation-scenario-phone-shaped-requester`.

**Docs**
- **Fixed:** `packages/cadre-core/README.md`'s drone example now calls `reconcileControlCohort()` after the seed is delivered. `docs/cadre-host.md` "Who dials whom" now says how a `CadreNode` requester dials the lent node, linking to architecture.md. The `docs/reference-app-rn.md` heading "Cold-start bootstrap peers" was renamed "Bootstrap dial targets" because the section now covers added nodes too (nothing linked to the old anchor). The `addDrone` doc now says that a reconcile pass already in flight is joined, so a caller waiting for the connection should allow for one more timed pass.
- Read and left as they are: `docs/architecture.md` (the cohort and cold-start bullets and step 9 match the code) and `docs/api.md` (signature only).

**Performance and size**
- `retainedDialAddrs` copies the store's map once per sibling that falls through to it. That costs siblings × entries per pass, on a handful of each. Not worth a note.
- Size debt: `wc -l packages/cadre-core/src/cadre-node.ts` gives 6895 lines at the parent commit, 7024 at the implement commit and 7034 after this review. Appended as evidence to `backlog/debt-cadre-node-single-file-size.md`; no new ticket.

**Tripwires** (all `NOTE:` comments at the site)
- `CadreNode.authorizePeer`: multiaddrs not retained (added in review, above).
- `retainedDialAddrs`: a removal replicated from another owner does not forget the entry. It only matters to the cold-start branch (implementer's).
- `refreshDialHint`: replace rather than merge (implementer's).
- `BootstrapPeerStore.record`: no eviction; wording extended to added machines (implementer's).

**Considered-and-declined:** nothing — no accepted-tradeoff `NOTE:` sits at any of these sites.

**Validation**
- `yarn workspace @serfab/cadre-core typecheck`: clean. `yarn lint`: clean.
- `yarn workspace @serfab/cadre-core test`: 128 files, 2116 passed, 1 skipped (up from 2113 by the three tests added here).
- Not re-run: the consumer-package typechecks and `control-cohort-cold-start-retry`. The review changed no public types, and the only runtime change, in `addDrone`, is outside that scenario's path.
