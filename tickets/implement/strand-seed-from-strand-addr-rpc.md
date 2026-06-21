description: Make a strand's startup seed use each node's actual strand-network address (resolved live from co-cadre siblings) instead of the wrong control-network address, so a node's own other nodes really join the strand.
prereq: strand-addr-control-protocol
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-cohort.ts, packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/test/strand-cohort.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, docs/architecture.md
difficulty: hard
----

## Background

`deriveCohortSeed(peers, selfPeerId)` builds a strand's `bootstrapNodes` from
`CadrePeer.Multiaddr` — the **control** node's addresses — but feeds them to the
**strand** node (separate libp2p instance, different port; see the originating
plan ticket `strand-cohort-seed-uses-control-network-addresses`). Dialing a
control address reaches the remote's control instance, not its strand instance,
so the seed never joins the strand mesh.

The fix (decided in `strand-addr-control-protocol`): resolve strand-network
addresses **on demand** over the control mesh via the new
`/sereus/strand-addr/1.0.0` protocol. The control network is single-party, so
this bootstraps **this party's own co-cadre nodes** onto a strand; cross-party
strand discovery is out of scope (strand formation / `MemberPeer`).

This ticket wires the protocol from `strand-addr-control-protocol` into the
node's seed-derivation path and stops conflating control addresses with strand
seeding.

## Current shape (to change)

- `cadre-node.ts:2077 resolveCohortSeed()` — control-DB → `queryCadrePeers()` →
  `deriveCohortSeed(peers, selfPeerId)` → `{ bootstrapNodes, hasOtherPeers }`.
  `bootstrapNodes` here are control addrs (the bug).
- Callers: `launchStrand` (`:2051`) and `resumeStrandRuntime` (`:1788`). The
  resume path already has a `strandId`; `launchStrand` has `strand.Id`.
- `strand-cohort.ts deriveCohortSeed` derives BOTH `bootstrapNodes` (from
  `CadrePeer.Multiaddr`) and `hasOtherPeers` (membership presence).
- `StrandWakeService` is created + `initialize(controlNode)`d in
  `CadreNode.start()` (`:393`). The new `StrandAddrService` is wired the same way.

## Target shape

### 1. Split address-source from membership in `strand-cohort.ts`

`deriveCohortSeed` keeps responsibility for **membership only**: self-exclusion
and `hasOtherPeers`, and additionally returns the **list of other peerIds** the
caller will RPC. It no longer reads `CadrePeer.Multiaddr` for `bootstrapNodes`
(control addrs must not seed the strand mesh). Suggested shape:

```ts
export interface CohortMembers {
  /** PeerIds of cohort members other than self (the RPC fan-out targets). */
  otherPeerIds: string[];
  /** True when at least one CadrePeer row other than self exists. */
  hasOtherPeers: boolean;
}
export function deriveCohortMembers(peers: CohortPeerRow[], selfPeerId?: string): CohortMembers;
```

Keep `CohortSeed { bootstrapNodes, hasOtherPeers }` as the value `resolveCohortSeed`
returns to the strand manager (its consumers are unchanged), but populate
`bootstrapNodes` from the RPC, not from `CadrePeer`. Update/replace the existing
`strand-cohort.spec.ts` cases that asserted `bootstrapNodes` came from
`CadrePeer.Multiaddr`.

### 2. Wire `StrandAddrService` into `CadreNode.start()`

Alongside `strandWakeService` (`:393`):

```ts
this.strandAddrService = new StrandAddrService({
  isMember: (peerId) => this.isMember(peerId),
  getStrandMultiaddrs: (strandId) => this.getStrandMultiaddrs(strandId),
});
this.strandAddrService.initialize(this.controlNode);
```

Add `getStrandMultiaddrs(strandId): string[]` to `CadreNode`: look up the strand
instance via `this.strandManager.getInstance(strandId)`; if it has a live
`libp2pNode`, return `node.getMultiaddrs().map(String)` ordered signaling-first
(reuse `orderSignalingFirst`); else `[]`. Unhandle on stop/cleanup (mirror the
wake service teardown).

### 3. Make `resolveCohortSeed` strand-specific and RPC-sourced

```ts
private async resolveCohortSeed(strandId: string): Promise<CohortSeed> {
  if (!this.controlDatabase || !this.controlNode) {
    return { bootstrapNodes: [], hasOtherPeers: false };
  }
  const peers = await this.controlDatabase.queryCadrePeers();
  const { otherPeerIds, hasOtherPeers } =
    deriveCohortMembers(peers, this.controlNode.peerId.toString());

  // RPC only the siblings we already have a control connection to — they are the
  // ones that can answer right now. dialProtocol by peerId reuses the open conn.
  const connected = new Set(this.controlNode.getConnections().map(c => c.remotePeer.toString()));
  const targets = otherPeerIds.filter(id => connected.has(id));
  const bootstrapNodes = targets.length
    ? await collectStrandAddrs(this.controlNode, targets, strandId)
    : [];
  return { bootstrapNodes, hasOtherPeers };
}
```

Update both callers to pass the strand id: `launchStrand` → `resolveCohortSeed(strand.Id)`,
`resumeStrandRuntime(strandId)` → `resolveCohortSeed(strandId)`.

### 4. Asymmetric bootstrap (no extra code, but verify)

First node up runs the strand with an empty seed (no other members yet →
`bootstrap` mode) and **answers** the strand-addr RPC. A later sibling RPCs it,
gets its live strand addr, and dials in. Confirm the receiver answers for a
`bootstrap`-mode strand (it should — `getStrandMultiaddrs` only checks for a live
node, not mode).

## Edge cases & interactions

- **Empty seed at first launch.** When no connected sibling yet runs the strand,
  `bootstrapNodes` is `[]`. Mode still follows membership (`selectStrandMode` uses
  `hasOtherPeers`), so a node with other members but no reachable strand peer
  starts `networked` with an empty seed and waits — consistent with today's
  documented "membership presence, not dialability" semantics. It self-heals: the
  hibernation **check-in / resume** path re-runs `resolveCohortSeed` and re-applies
  a fresh seed via `resumeStrand` overrides. Consider (optional, note if deferred)
  re-resolving on the control-connection-growth edge that already drives
  `drainPendingControlReplication`.
- **Self-exclusion** in both `deriveCohortMembers` and the RPC fan-out.
- **Sibling connected on control but not running the strand / hibernating** →
  empty response; skipped. (Optionally the caller could push-wake it first via the
  existing wake path — leave OUT of v1, note as future.)
- **NAT'd sibling** reachable only via relay → the strand-addr RPC uses
  `runOnLimitedConnection` (handled in the protocol ticket). The returned strand
  multiaddr must itself be dialable on the strand network; deep per-strand NAT
  relay reachability is tracked separately (`strand-network-nat-relay-reachability`).
- **Concurrent strand launches** racing the RPC sweep — each launch resolves its
  own seed; `startStrand`'s existing "already running" guard prevents double-build.
- **Control DB / control node absent** (not yet started) → empty seed, no throw.
- **resume vs launch parity** — both must pass the same `strandId` and apply the
  same `{ bootstrapNodes, mode }` resolution (resume already threads overrides via
  `ResumeStrandOverrides`).
- **`CadrePeer.Multiaddr` semantics unchanged** — it still carries *control*
  addrs for control bootstrap + `resolvePeerAddrs`; this change only stops it from
  feeding the strand seed.
- **Stop/teardown** — `strandAddrService.shutdown()` (unhandle) on node cleanup so
  a restart does not hit `DuplicateProtocolHandlerError`.

## Docs

Update `docs/architecture.md` (§ "Strand Networks" / "Cadre Node" and the seed
discussion) and the open question in `docs/strands.md:83-84` to describe
strand-address resolution over the control network: CadrePeer carries control
addrs; strand-network addrs are resolved on demand from co-cadre siblings via
`/sereus/strand-addr/1.0.0`; cross-party strand discovery remains future
(strand-overlay DHT / `MemberPeer`).

## TODO

- `strand-cohort.ts`: add `deriveCohortMembers` (membership + `otherPeerIds`);
  stop sourcing `bootstrapNodes` from `CadrePeer.Multiaddr`. Keep `CohortSeed`.
- `cadre-node.ts`: add `strandAddrService` field + `getStrandMultiaddrs`; wire
  `StrandAddrService` create/initialize in `start()` and `shutdown` in cleanup.
- `cadre-node.ts`: rewrite `resolveCohortSeed(strandId)` to RPC connected siblings
  via `collectStrandAddrs`; update `launchStrand` and `resumeStrandRuntime` callers.
- Tests:
  - `strand-cohort.spec.ts`: rewrite for `deriveCohortMembers` (self-exclusion,
    `hasOtherPeers`, `otherPeerIds`); drop the old `bootstrapNodes`-from-Multiaddr
    assertions.
  - `cadre-node-control-cohort.spec.ts` (or a new `cadre-node-strand-seed.spec.ts`):
    `resolveCohortSeed` unions strand addrs from connected siblings, returns empty
    when none connected/running, and selects mode from membership independent of
    addr availability.
- Update `docs/architecture.md` + `docs/strands.md` as above.
- `yarn workspace @serfab/cadre-core build` + run the cadre-core suite (stream with
  `tee`); confirm strand-cohort, cadre-node, hibernation, and wake specs pass.
