----
description: A node learns its teammates' addresses for a shared workspace only once, when it joins — after that the address book goes stale and dials to a teammate that dropped off start failing. Refresh those addresses periodically and keep them in the workspace's address book.
prereq: merge-verified-peer-addrs-into-control-peerstore
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-addr-book.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/test/cadre-node-strand-seed.spec.ts
difficulty: medium
----

Split from `plan/feat-merge-cadre-peer-addrs-into-libp2p-peerstore` (strand-network arm).
The control arm (`merge-verified-peer-addrs-into-control-peerstore`) introduces the
`mergePeerAddrs` helper this ticket reuses — assume it has landed exactly as specified there.

## Problem

Each strand runs its own libp2p node with its own **transport peer id** derived per strand
(`strand-transport-key.ts`), so `CadrePeer.Multiaddr` — which carries *control* addresses —
cannot address it. Strand addresses are resolved on demand over the control mesh with the
`/sereus/strand-addr/1.0.0` RPC (`strand-addr-protocol.ts`, `collectStrandAddrs`), and
`resolveCohortSeed` (`cadre-node.ts:3538`) uses the result exactly twice: as the
`bootstrapNodes` list at strand launch (`cadre-node.ts:3490`) and at resume
(`cadre-node.ts:3007`).

That is a one-shot. Afterwards:

- Nothing re-resolves a sibling's strand address, so a sibling that restarts its strand node
  or rotates its relay reservation becomes unreachable on the strand network until this node
  restarts or resumes the strand.
- Optimystic's cluster/repo clients and FRET dial strand peers **by peer id**
  (`libp2p.dialProtocol(peerId, …)`) and read the strand node's peerStore, which after the
  bootstrap-discovery pass holds nothing newer.
- Even the launch-time addresses do not survive: `@libp2p/peer-store@12.0.10` filters
  addresses older than `MAX_ADDRESS_AGE` (1 hour) on read, and re-merging cannot refresh
  their timestamp (see the measurement and workaround in the control-arm ticket). So a strand
  node running longer than an hour ends up with an empty address book for every sibling it is
  not currently connected to.

This is the layer where the reported symptom actually bites: replication runs on the strand
network.

## Design

### 1. Attribute collected strand addresses to their peer — `peer-addr-book.ts`

`collectStrandAddrs` returns a flat, deduplicated `string[]` union across siblings. Each
entry is a sibling's `getMultiaddrs()` output and therefore carries its own trailing
`/p2p/<strand-transport-peer-id>` component (for a relayed address,
`…/p2p/<relay>/p2p-circuit/p2p/<strand-peer>` — the **last** `/p2p/` component is the one we
want). Add to the helper module:

```ts
/** Group multiaddr strings by the peer id in their final `/p2p/` component. */
export function groupAddrsByPeerId(addrs: string[]): Map<string, Multiaddr[]>;
```

- Parse with the top-level `multiaddr()`; read components via `getComponents()` and take the
  last `CODE_P2P` value.
- Drop (and log) an address that does not parse or carries no `/p2p/` component — it cannot
  be attributed to a peer, so it cannot enter an address book.
- Pure function, no libp2p node needed; unit-testable on its own.

### 2. Merge the launch/resume seed into the new strand node's peerStore

`resolveCohortSeed`'s result already feeds `bootstrapNodes`, which only reaches the peerStore
via `@libp2p/bootstrap` discovery at node start. Right after the instance is running (both
the launch path around `cadre-node.ts:3490-3510` and the resume path at `cadre-node.ts:3007`),
group the seed addresses and `mergePeerAddrs(strandNode, peerId, addrs)` for each group.
Best-effort: a merge failure is logged and never fails the launch/resume.

### 3. Periodic strand-address refresh, driven by the control reconcile pass

Add `refreshStrandPeerAddrs(now = Date.now())`, called from `runReconcileControlCohort`
(`cadre-node.ts:1758`) immediately after `refreshDelegateGrants()`, with the same shutdown
re-guard and best-effort error handling. Per pass:

- Build the running-strand set from `this.strandManager.getInstances()`, keeping only
  instances with a live `libp2pNode` (a hibernating / quiescing strand has no node to seed).
- Throttle per strand on a `Map<strandId, number>` of last-refresh timestamps, mirroring
  `delegateAnnounceAt` / `pruneStoppedStrandAnnounces` in `delegate-admission.ts`. Prune
  entries for strands no longer running.
- New constant `STRAND_PEER_ADDR_REFRESH_MS = 10 * 60 * 1000` (10 min). Rationale to record
  in the constant's doc comment: comfortably inside the peerStore's 1-hour address expiry
  while leaving headroom for a missed pass, and far above the 15 s reconcile cadence so the
  RPC fan-out stays cheap. Make it overridable through the existing
  `config.network` shape if that is a one-liner; otherwise leave it fixed and say so.
- For each due strand: reuse the connected-sibling target list that `resolveCohortSeed`
  builds (extract it into a small private helper rather than duplicating the
  `queryCadrePeers` → `deriveCohortMembers` → filter-by-connected chain), call
  `collectStrandAddrs(controlNode, targets, strandId, { delegatePeerId })` with the running
  strand node's peer id as `delegatePeerId`, then `groupAddrsByPeerId` the result and
  `mergePeerAddrs` each group into **that strand node's** peerStore.
- Strands refresh concurrently (`Promise.all`), exactly as `refreshDelegateGrants` does, so
  one unreachable sibling's dial timeout does not stack per strand.
- Only stamp the throttle map when the pass actually had targets to RPC; a strand with no
  connected siblings should retry on the next reconcile tick rather than sit out 10 minutes.

**Relationship to `refreshDelegateGrants`.** That pass covers **relays** on a 15-minute
throttle (`DELEGATE_GRANT_TTL_MS / 2`) and exists to keep circuit-relay admission grants
alive. This pass covers **siblings** on a 10-minute throttle and exists to keep the strand
address book warm. They overlap only in that both carry `delegatePeerId`, which is
deliberate: a sibling that also runs a relay gets its grant refreshed as a side effect. Keep
them separate — merging them would tie an admission-grant TTL to an address-expiry window
that has nothing to do with it.

**Cost.** One strand-addr RPC per (running strand × connected sibling) per 10 minutes, each a
single tiny request/response on an already-open control connection. Leave a `NOTE:` tripwire:
if a node ever runs many strands at once, batch the RPC to ask for several strand ids per
request instead of one fan-out per strand.

## Edge cases & interactions

- **Strand stops mid-pass.** The RPC is awaited; re-read the instance (and its `libp2pNode`)
  after the await and skip the merge if it is gone. Never write to a stopped node's store.
- **`stop()` racing the pass.** Re-guard `this._running` / `this.controlNode` before and
  after each await, like every other step of the reconcile pass.
- **No connected siblings / all RPCs fail.** `collectStrandAddrs` folds per-peer failure to
  `[]`; an empty union merges nothing and leaves the throttle unstamped.
- **Self-addresses.** We never RPC ourselves, but guard anyway: skip a group whose peer id
  equals the strand node's own `peerId`.
- **Addresses with no `/p2p/` component** (a sibling advertising a bare listen addr) are
  dropped — unattributable. Log the count once per pass, not per address.
- **Malicious or buggy sibling.** A member could answer with arbitrary multiaddrs bound to
  arbitrary peer ids and poison the strand address book. This is the *same* exposure the
  existing launch-time `bootstrapNodes` seeding already accepts, and the cost is bounded:
  addresses grant no authority, the dialed peer authenticates by peer id at the handshake,
  and a bad entry costs a failed dial that ages out at the peerStore's 1-hour expiry. Record
  the reasoning in a comment at the merge site; do not add new gating here (cross-party
  strand trust is `backlog/strand-network-nat-relay-reachability`).
- **Address expiry.** All merges go through `mergePeerAddrs`, which handles the upstream
  frozen-timestamp bug; do not call `peerStore.merge` directly from this path.
- **Cross-party strand members.** The strand-addr RPC is control-network (single-party) only,
  so this pass warms addresses for own-cadre siblings alone. Members from other parties are
  out of scope and stay covered by `backlog/strand-network-nat-relay-reachability`.
- **Hibernation.** A strand hibernated between passes drops out of the running set and its
  throttle entry is pruned, so a later resume refreshes immediately rather than inheriting a
  stale stamp.

## Tests

`packages/cadre-core/test/peer-addr-book.spec.ts` (extend) — `groupAddrsByPeerId`:

- a relayed addr (`/ip4/…/p2p/<relay>/p2p-circuit/p2p/<strand>`) groups under `<strand>`,
  not under the relay.
- a direct addr (`/ip4/…/tcp/…/p2p/<strand>`) groups under `<strand>`.
- multiple peers' addresses split into the right groups; duplicates collapse.
- an addr with no `/p2p/` component, and an unparsable string, are dropped without throwing.

`packages/cadre-core/test/cadre-node-strand-seed.spec.ts` (extend its existing stub harness)
or a new `cadre-node-strand-addr-refresh.spec.ts`:

- a running strand with two connected siblings: one refresh pass RPCs both and merges each
  sibling's strand addresses into the strand node's peerStore, keyed by the strand transport
  peer id (not the control peer id).
- a second pass immediately after does **no** RPC (throttled); a pass after
  `STRAND_PEER_ADDR_REFRESH_MS` does.
- a strand with no connected siblings leaves the throttle unstamped — the next pass retries.
- a hibernating strand (instance present, `libp2pNode` undefined) is skipped and its throttle
  entry pruned.
- a strand stopped between the RPC and the merge produces no peerStore write.
- an RPC that rejects and a peerStore that rejects both leave the pass completing and the
  other strands refreshed.
- launch/resume: the resolved cohort seed lands in the new strand node's peerStore, grouped
  by peer id.

## TODO

- Add `groupAddrsByPeerId` to `packages/cadre-core/src/peer-addr-book.ts` with its unit tests.
- Merge the launch and resume cohort seed into the started strand node's peerStore
  (`cadre-node.ts:3007`, `cadre-node.ts:3490-3510`), best-effort.
- Extract the connected-sibling target list out of `resolveCohortSeed` into a private helper
  shared with the new refresh pass.
- Add `STRAND_PEER_ADDR_REFRESH_MS`, the per-strand throttle map (+ pruning), and
  `refreshStrandPeerAddrs`, wired into `runReconcileControlCohort` after
  `refreshDelegateGrants` with the same guards.
- Add the `NOTE:` tripwire about per-strand RPC fan-out cost.
- Write the refresh-pass tests; extend the strand-seed spec's doubles with a strand-node
  `peerStore`.
- Update `docs/strands.md` with a short paragraph: strand addresses are re-resolved over the
  control mesh on a 10-minute cadence and merged into each strand node's address book, so
  dial-by-peer-id keeps working between live connections.
- `yarn lint` + `yarn test` in `packages/cadre-core`, plus a typecheck of the package.
