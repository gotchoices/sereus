# Sereus Cadre Architecture

This document describes the architecture of the Sereus Cadre system—the infrastructure that enables parties to control sets of nodes participating in distributed strand networks.

## Overview

A **cadre** is a party's personal cluster of nodes that collectively represent their presence across strands. Cadre nodes range from always-on cloud servers with terabytes of storage to intermittently-connected mobile devices. The cadre system provides:

- **Unified control**: A single control network through which a party manages all their nodes
- **Strand participation**: Automatic lifecycle management for joining, syncing, and leaving strand networks
- **Flexible deployment**: Support for self-hosted nodes (see [@serfab/cadre-host](cadre-host.md) for basement-PC deployments), provider-hosted containers, and mobile devices
- **Key-based authorization**: Cryptographic owner delegation without central servers

```mermaid
graph TD
    subgraph Party["Party (User)"]
        subgraph CN["Control Network<br/>(Distributed Optimystic DB, CadreControl schema)"]
            Phone["Phone (edge)"] --- Laptop["Laptop (edge)"] --- Cloud["Cloud (core)"] --- NAS["NAS (core)"]
        end
        CN --> SA["Strand A (2 nodes)"]
        CN --> SB["Strand B (3 nodes)"]
        CN --> SC["Strand C (1 node)"]
    end
```

## Core Components

### Control Network

The control network is a private Optimystic network involving only the party's own cadre nodes. It uses the `CadreControl` schema to maintain:

| Table | Purpose |
|-------|---------|
| `OwnerKey` | Keys authorized to make control changes. Add/remove only (rotation is add-then-remove), each authorized by a signature from an owner that existed **before** the transaction — so no key can seat itself and no pair can seat each other — and the table can never be emptied. Details in the constraint comments in `schemas/control.qsql` |
| `ValidationKey` | Keys that can validate strand formation disclosures — this is the list the invitation approver check reads. Add/remove only (rotation is add-then-remove); both writes need an owner signature bound to the row, over distinct add/remove digests, and a removal must retire the row's stamp into `Revocation` in the same transaction. When an invite carries a `ValidationUrl`, `FormationUsage.Authorized` requires a matching row here and verifies the disclosure sign-off against the **stored** key, not against the key supplied on the redeeming insert — so a redeemer cannot approve itself with a throwaway keypair. Removal only narrows who may approve future redemptions. Each sign-off authorizes exactly ONE redemption: it is signed over the invitation, that redemption's single-use nonce, the strand being joined, the joining peer, and the disclosure text — so it cannot be re-presented for another use of the same invitation, another strand, or another joiner, and a verbatim re-presentation is refused as a duplicate nonce. Details in the constraint comments in `schemas/control.qsql` |
| `Strand` | List of strands the party participates in. Add/remove only, same owner-signed add/remove rule as `ValidationKey`. Adding may instead be authorized by a redeemed formation invitation (no signature) — but only by a `FormationUsage` row naming this row's one-off `StampId`, only from an **unbound** invite, only in the open/keyless shape (`Type='o'`, null `MemberPrivateKey`), only **once per strand id, ever**, and **never after any removal of that id** (every removal's `Revocation` tombstone names the removed id) — so consent can neither choose the party's secrets nor bring back an id that was ever seated before (re-join is owner-gated); removing may **not** be so authorized — an invitation authorizes forming a strand, never destroying one, and a closed strand's row carries the party's `MemberPrivateKey` for that network |
| `CadrePeer` | Registry of nodes in the cadre |
| `DeviceToken` | Self-published FCM/APNs push token per mobile peer (for push-wake of a suspended app). The owner's insert approval binds the **whole row** — every column, ending in the row's one-off `StampId` — so one captured signature cannot re-point the party's push-wakes at an attacker-chosen `(Platform, Token)`; the delete approval is narrower (`PeerId`, `StampId` only) and a clear must retire that stamp into `Revocation` in the same transaction, so the insert approval dies with the row |
| `FormationInvite` | Open invitations to form strands with this party |
| `FormationUsage` | Append-only audit log of formation invite consumption: one row per redemption, recording which peer joined (`PeerKey`, its own ed25519 public key — the libp2p peer id is the identity multihash of those bytes and is not stored separately) and a per-redemption single-use nonce (`UsageStampId`, minted by the joining peer). Both are bound into the approver sign-off digest that `Authorized` verifies for a `ValidationUrl` invite, which is what makes one approval spendable exactly once. The named peer is **not** writer-asserted: the row also stores that peer's own signature (`PeerSig`) over a distinct `'consent'` digest covering the token, nonce, peer key and disclosure, which the `PeerConsented` CHECK verifies against `PeerKey` on insert — so a redemption cannot be filed in a peer's name without that peer's private key, and because the signature lives on the row rather than passing through as context, any later reader can re-check it |
| `Revocation` | Append-only retirement record for the one-off `StampId` nonces of removed `OwnerKey` / `CadrePeer` / `ValidationKey` / `Strand` / `DeviceToken` rows. Removing a row without retiring its stamp would leave the add-approval signature (never expires, and for `CadrePeer` stored on the replicated row) able to re-seat the row verbatim. Appending is itself an **owner action**: every tombstone carries an owner signature bound to the `(TableName, RowKey, StampId)` triple it retires — `RowKey` is the removed row's primary key, recording *which row* was retired, which is what lets `Strand.AuthorizedInsert`'s consent branch make removal final for an id, and each guarded table's `RevocationRecorded` CHECK refuses a delete whose tombstone names a different row — under a domain tag distinct from the delete's own remove digest, so neither signature stands in for the other. Ungated it was both a flooding surface (rows never go away, and the read side re-reads the whole set per inbound gate request) and a remote eviction primitive — a tombstone naming a `CadrePeer` row not yet visible locally dropped that peer party-wide *and* permanently blocked the owner's own later re-admission of it. Details in the constraint comments in `schemas/control.qsql` |

#### Local write serialization

A node's control database is one Quereus `Database` handle, and Quereus tracks transaction state per handle — so a write statement's implicit transaction stays open across the awaits inside `exec`. Two of the node's own components writing at once therefore either join each other's open transaction (a torn commit if one side rolls back) or trip the commit-boundary assert that guards the `CadrePeer` mutators. The race is real: the background self-record publish on a control connection opening collided with a foreground `authorizePeer`.

`ControlDatabase` closes that class with a **process-local write queue**: every public write method runs its statement(s) through `withWriteLock` (single statements via the `execWrite` shorthand). Every `CadrePeer` write statement now lives on `ControlDatabase` itself (`insertCadrePeer` / `reauthorizeCadrePeer` / `deleteCadrePeer` / `updateSelfPeerRecord`) — `SeedBootstrapService` supplies the owner key and signer and delegates, holding only a `select` of its own — and an eslint `no-restricted-syntax` rule fails the build on a literal `CadrePeer` insert/update/delete written anywhere else, so a new writer cannot silently skip the membership refresh. Reads are deliberately unlocked — they take no transaction of their own, and locking them would deadlock the membership listener that reads during a notify. The lock is **not re-entrant**; the file's own comments carry the details and the failure mode. This is node-local concurrency control only: it says nothing about agreement between nodes, which is [`cadre-consistency.md`](cadre-consistency.md)'s subject.

#### Network scoping (current implementation)

Cadre uses `@optimystic/db-p2p` to create libp2p+Optimystic nodes. In that implementation, **libp2p service protocols are namespaced by** `networkName` via:

- `protocolPrefix = /optimystic/${networkName}`
- control network uses `networkName = control-${partyId}`

Cadre-specific protocols are separate and live under `/sereus/*` (e.g. seed delivery uses `/sereus/seed/1.0.0`; control-network push-wake uses `/sereus/strand-wake/1.0.0`, see [Strand Hibernation → Wake Mechanisms](#strand-hibernation); on-demand strand-address resolution uses `/sereus/strand-addr/1.0.0`, see [Strand-Address Resolution](#strand-address-resolution)).

#### Replication cluster size

Optimystic replicates each block to a group of nodes it calls a **cluster**, and how many nodes that group should have is an embedder-supplied number. Cadre answers it differently for the two kinds of network it runs, because the two have different reading patterns. Both constants — and the control network's cluster policy alongside them — live in `@serfab/quereus-plugin-sereus`'s `cluster-size.ts` (re-exported by `@serfab/cadre-core`) so the SQL plugin, cadre-core and the integration harness can never disagree.

**Control network — replicate to the whole party (`CONTROL_REPLICATION_BREADTH`, currently 16).** Not configurable. Every control node reads the *whole* control database — membership, peer addresses, the strand list — so a member excluded from a block's cohort is a member that may never learn the fact. Optimystic caps a cohort at the peers that actually serve the network (`Libp2pKeyPeerNetwork.findCluster` keeps `min(serving peers, clusterSize - 1)` non-self members) and downsizes a cohort it cannot fill, so any value at or above the party's node count makes every control cohort the entire party. 16 is roughly twice the largest deployment documented below under [Deployment Configurations](#deployment-configurations) ("Enterprise", 7 nodes).

**Strand networks — partial replication is fine, but not *thin* replication (`DEFAULT_STRAND_CLUSTER_SIZE`, currently 4, overridable via `CadreNodeConfig.strandClusterSize`).** Strand data is application data that no single node needs in full, so breadth is a storage/availability tradeoff rather than a whole-party requirement. The question is therefore how few copies is too few, and the answer is four. Every strand node-creating path routes through `resolveStrandClusterSize`, which applies the default and rejects a non-integer or anything below `MIN_CLUSTER_SIZE` (2, Optimystic's own `minAbsoluteClusterSize`, and the smallest value that reaches the cluster path at all — a lone node writes to local storage without forming a cluster). That includes the SQL plugin's `connectToStrand` / `connectToStrandBrowser`, whose `StrandConnectionOptions.clusterSize` defaults to the same number: leaving the option unset is *not* neutral, because Optimystic's own fallback is **10**. The option is ignored when a caller injects an already-built libp2p node (cadre-core's `StrandDatabase` does), since the node carries the value it was constructed with.

**Why the strand default is 4 and not 2.** A write commits on a super-majority of the cohort, and that bar is 0.75 (`DEFAULT_SUPER_MAJORITY_THRESHOLD`, selected by naming no threshold — see `CONTROL_CLUSTER_POLICY` below). Approvals needed is `ceil(cohort × 0.75)`, so a cohort of 2 needs 2, a cohort of 3 needs 3, and a cohort of 4 needs 3 — four is the smallest breadth that commits while one holder is offline. Cohorts of 5 and 6 still tolerate only one absence, so they buy nothing over 4 and overfetch more. The second reason is correctness, not durability: at breadth 2 the read repair described below cannot converge at all, because the reader has exactly one corroborator. Four also makes the *number* of copies grow past the two-node case that motivated the `Member`-count question — and it is a constant rather than a function of the member list for four independent reasons: the `Member` rows live in the strand database that runs on the node whose cluster size is already frozen; open strands (`Strand.Header.Type = 'o'`) have no member list at all; the count grows in the unsafe direction, since the node that restarted after a join derives the *wider* view that the confident-path admission gate rejects; and a `Member` is a party, not a machine, while cohort width consumes machines. Rolling the value out is a restart of every node on the strand — there is no mixed-version story, and a node still holding the old value derives a different expected cohort from one holding the new.

This section is the canonical explanation of the replication-breadth decision; `cluster-size.ts` and [`cadre-consistency.md`](cadre-consistency.md#what-ships-today-the-control-database-replicates-to-the-whole-party) state the decision and link here. What matters operationally:

- **Two-member cohorts cannot self-heal.** A member that misses a write is supposed to catch up by *read repair*: on reading a block it asks the block's cohort for the newest revision. At a cohort of two that is exactly one peer, and Optimystic accepts a single peer's answer as the cluster's truth when the cohort cannot hold a second voter (`corroboratorCapacity` in `db-p2p/src/cluster/quorum-restore.ts` caps the corroboration floor at what the cohort can supply). If that one peer also missed the write it honestly answers with the older revision, the reader concludes it is current and re-arms its repair window — so it never converges. Measured on the control-DB replication scenario: 4 failures in 10 runs at breadth 2, 0 in 20 at breadth 3, 0 in 10 at breadth 8, 0 in 20 at full-party breadth. This is why the control database replicates to everyone, and the second reason the strand default is 4 rather than the `MIN_CLUSTER_SIZE` floor of 2 — any value above 2 lifts the corroboration floor off a single voter. Neither change fixes the underlying Optimystic behaviour (`backlog/debt-read-repair-single-voter-corroboration`), so a caller that explicitly configures a strand at 2 still takes the exposure.
- **Whole-party breadth removes the control path's *routine* dependence on read repair, not read repair itself.** A member serving the network at write time is in the cohort and receives the block directly. A member that was offline then is not in the cohort at all (`findCluster` admits only positively-serving peers), so it still catches up one of two other ways: by read repair on its next read of the block, or — when the writer itself had no connected cohort — by the write-while-alone re-replication queue, which re-issues those writes on the control node's 0→≥1 connection edge (`CadreNode.drainPendingControlReplication`).
- **It also *strengthens* the read repair that remains.** `corroboratorCapacity(cohortPeerCount, assumedClusterSize)` is `max(cohortPeerCount, assumedClusterSize - 1)`, and `cohortPeerCount` is now the whole party rather than one peer. In a party of three or more the capacity rises from 1 to N-1, so the corroboration floor rises from 1 to `CORROBORATION_FLOOR` (2) and a lone stale — or lying — peer can no longer be accepted as the cluster's truth; `selectQuorumRev` then takes the *highest* corroborated revision, so repair converges. The flip side is narrow but real: in a party of three where two members were offline for a write, the returning majority sees only one peer holding the new revision, now *below* a floor of 2 where at breadth 2 it sat at a floor of 1. The re-replication queue above, not read repair, is the backstop for that case — so the floor rise is not unambiguously free.
- **Every node on the same network should use the same value.** The number is a replication target, and Optimystic's membership admission gate does *not* measure a declared peer set against it — the gate's fallback yardstick is `ClusterConsensusConfig.assumedClusterSize`, which Cadre leaves at Optimystic's default of 2 because a party legitimately runs one or two nodes. (That option has a second consumer: it is also an input to the read-repair/reconcile corroboration floor above, unconditionally — not only the gate's fallback path.) But the gate's *confident* path compares a coordinator's declared set against the member's own derived cohort view, and that view is bounded by this number, so a member configured much higher can reject a smaller declared set as a downsize.
- **The breadth's companion policy is shared too (`CONTROL_CLUSTER_POLICY`, same file).** Breadth alone is unsatisfiable — a fixed 16-wide target needs `allowDownsize` + `sizeTolerance` to shrink to the party that exists — and the *approval* bar rides in the same object: how much of a cohort must approve a write before it commits. Cadre names no threshold at all, which is what selects Optimystic's `DEFAULT_SUPER_MAJORITY_THRESHOLD` (0.75) for both the coordinator and the cluster member. Production and the integration harness now pass the one shared constant rather than hand-copied literals, because a harness copy carrying `superMajorityThreshold: 0.51` is how a 2-of-3 commit could pass in tests and need 3-of-3 in a real party.
- **Whole-party breadth makes one connected-but-degraded member decisive, and it amplifies slowness per write.** Because every member is in every control cohort, the 0.75 approval bar at three nodes is `ceil(3 × 0.75) = 3` — unanimity — so a member that is connected but slow or silent counts against the bar rather than being routed around. Measured in `packages/integration-tests/src/scenarios/control-write-degraded-cohort-member.integration.ts` (single machine, localhost websockets, forced 3-peer cohort): a healthy trio commits an `authorizePeer`/`removePeer` in **~1 s**; one member whose inbound cluster RPCs are delayed **2 s** turns the same write into **~55 s**, because one control write makes ~27 inbound cluster RPCs and the delay is paid serially on each — a *small* per-RPC latency becomes a *large* per-write one; one member that never answers turns it into a clean failure (`Failed to get super-majority: N/3 approvals (needed 3, 0 rejections)`) after **~20 s**, one pend round of two 10 s `ClusterClient` response-deadline attempts, or **~40 s** when a second pend round runs. The failed write rolls back, is not queued for re-replication, and the next write commits normally (~1 s) — the degradation costs latency and availability, not consistency. **The exception is when the degraded node is itself the batch coordinator:** its own cluster vote is in-process and its degraded *inbound* handler is never dialled, so that write commits fast. This exception is **observed, not asserted** — it was measured during development (~0.25–0.5 s) but no test pins it, because coordinator assignment is also the read-routing seam and only the founding node holds the control trees' genesis-era blocks, so pinning the coordinator elsewhere fails every case with `Missing block` before the degradation is reached. The availability cost therefore depends on who coordinates, which in production is a key-proximity draw; the scenario pins the coordinator to a healthy node precisely to measure the worst branch deterministically. The *healthy* side of the same bar is measured without any forcing by `packages/integration-tests/src/scenarios/harness-party-control-cohort.integration.ts`: once real cohort discovery has converged on all three machines, a control write commits in **~0.7–1.0 s** every run, so unanimity at three nodes is a fragility about degraded members, not about the healthy path.
- **A stalled control write currently also blocks control *reads* on the same node** — they answer only once the write settles, instead of serving committed local state immediately. This is a defect, not a property of the design (cadre-core's write queue deliberately leaves reads unlocked); it is tracked as `tickets/fix/control-reads-blocked-by-stalled-write` and has a standing reproducer in the scenario above.
- **It is frozen when the libp2p node is created**, not re-read as the cadre grows. Changing it takes effect on the next restart. This is also why the control breadth is a constant rather than the live `CadrePeer` count: the control libp2p node is created before the `ControlDatabase` holding those rows exists, and membership is eventually consistent, so per-node derivation would reintroduce exactly the divergence the confident-path gate punishes.

### Strand Networks

Each strand is an independent Optimystic network with its own:
- Network namespace: `networkName = strand-${strandId}` (libp2p services are scoped under `/optimystic/strand-${strandId}` in `@optimystic/db-p2p`)
- Member list (for closed strands)
- Application schema
- Peer cohort (union of all member cadres)

**Strand membership schema.** Every strand applies the `Strand` membership/RBAC schema (`schemas/strand.qsql` — `Header`, `Invite`, `ConsumedInvite`, `CancelledInvite`, `Member`, `MemberPeer`, `Manager`) automatically, alongside the sApp DDL under `declare schema App { ... }`. The cadre-core `StrandDatabase` and the `@serfab/quereus-plugin-sereus` connectors (`connectToStrand` / `connectToStrandBrowser`) share **one** composition — `composeStrand` — so plugin registration, node wiring, the warm-restart catalog hydrate, and schema apply all live in a single place. `StrandDatabase` owns only the `Database` lifecycle and delegates the rest to `connectToStrand` with its injected libp2p node. Immediately after the catalog hydrate, `composeStrand` applies the `Strand` schema unconditionally (every strand has membership semantics) and then the sApp schema if one was supplied; the membership schema ships as an embedded `STRAND_SCHEMA` constant (kept byte-equivalent to `schemas/strand.qsql`) so it works on filesystem-less platforms, mirroring cadre-core's `CONTROL_SCHEMA`. This makes the membership tables present and their `verify()`-gated constraints active on every strand. It does **not** populate them: inserting the `Header` row and bootstrapping the founding `Manager`/`Member` and invite/peer flows is tracked by the lifecycle ticket `strand-membership-lifecycle-population`, so the change is additive and does not gate sApp (`App.*`) reads or writes.

### Cadre Node

A cadre node is a running instance of the `@serfab/cadre-core` library. Each node:

1. **Connects to the control network** using its PeerId and authorized bootstrap addresses
2. **Watches the `Strand` table** for changes (reactive pattern - which is a TODO for Optimystic so we'll have to poll for now)
3. **Starts/stops strand instances** as rows are added/removed
4. **Publishes a signed peer-address record** to its own `CadrePeer` row (`CadreNode.registerSelf`): its current dialable/relay multiaddrs (signaling `/p2p-circuit` first), an ed25519 `PublicKey` whose libp2p identity *is* its PeerId, a monotonic `UpdatedAt` freshness stamp, and a self-`Sig` over those fields. It re-publishes on relay-reservation/address change and on a TTL heartbeat. Any member can then **resolve** another member's current signaling address from its PeerId alone via `CadreNode.resolvePeerAddrs(peerId)` — which re-verifies the signature, checks the `PublicKey↔PeerId` binding and freshness, and applies a pluggable trust gate — so a NAT-to-NAT WebRTC dial can be negotiated without copy/paste.
5. **Publishes a signed device push token** to its own `DeviceToken` row (`CadreNode.registerDeviceToken(platform, token)`), modeled on the `CadrePeer` record: an FCM/APNs `Token`, a monotonic `UpdatedAt`, and a self-`Sig` verified at resolve time against the `CadrePeer.PublicKey` bound to the same PeerId. Because a control-network libp2p dial cannot reach an OS-suspended phone, a server peer instead **resolves** the phone's token via `CadreNode.resolveDeviceToken(peerId)` (membership + binding + self-sig + freshness + retired-stamp gated, returning `null` on any failure) and delivers a push-wake over the platform push channel. `clearDeviceToken()` removes the row on logout/invalidation. The first `DeviceToken` row, like `CadrePeer`, is owner-signed (insert/delete are owner-gated) over the whole row plus its one-off `StampId`, and `clearDeviceToken()` retires that stamp into `Revocation` in the same transaction — so the insert approval cannot re-seat the row afterward, and the retired-stamp gate above is what drops a live row on a node that converged on a replayed insert before the tombstone arrived (mirroring `listAuthorizedMembers` for `CadrePeer`). A member self-updates its own token thereafter. The push *sender* (server fan-out) and the RN registration call are downstream of this registry.

```mermaid
graph TD
    subgraph CN["Control Network Instance<br/>(libp2p + Optimystic + Quereus, CadreControl schema)"]
        SW["Strand Watcher"] -->|watches| ST["Strand table changes"]
    end
    SW -->|start/stop| SIM
    subgraph SIM["Strand Instance Manager"]
        SA["Strand A<br/>libp2p + Optimystic + App Schema"]
        SB["Strand B<br/>libp2p + Optimystic + App Schema"]
        SC["Strand C<br/>libp2p + Optimystic + App Schema"]
    end
    SIM --- SL["Storage Layer<br/>(shared — memory, file, or LevelDB)"]
```

## Node Profiles

Cadre nodes operate in one of two profiles, distinguished by their storage role:

> **Designed, not yet implemented:** The concentric storage-ring model described in this section (Ring Zulu participation beyond the on/off hint, Rings 0–3, keyspace partitioning, and capacity quotas) describes the **intended design**. The current implementation is the `arachnode-stub.ts` no-op stub (exported from `@serfab/cadre-core` but not yet wired into the runtime path). The only wired effect of profile selection today is the FRET `edge`/`core` choice plus a single Ring Zulu enable flag passed as a hint to the libp2p node (`strand-instance-manager.ts:202,210`). Treat the table and ring prose below as design reference. Tracked by `tickets/backlog/later/5-ring-zulu-storage-rings.md`.

| Profile | Arachnode | Typical Deployment | Ring Participation |
|---------|-----------|--------------------|--------------------|
| **Transaction** | Disabled | Mobile devices, intermittent connectivity | Transaction verification via FRET only |
| **Storage** | Enabled (Ring Zulu + Storage Rings) | Servers, NAS, always-on nodes | Full block storage with capacity quotas |

In the intended design, transaction-profile nodes skip Arachnode initialization entirely (no StorageMonitor, RingSelector, or RestorationCoordinator) for a lighter cold start, while storage-profile nodes initialize the full Arachnode subsystem including Ring Zulu and concentric storage rings. _Those Arachnode components do not exist yet_ — see the callout above. Currently profile selection only sets the FRET `edge`/`core` profile and the Ring Zulu enable hint.

### Strand Filtering

Mobile nodes typically run as part of a specific application and should not participate in all strands. The configuration includes an optional **strand filter**:

| Filter Mode | Behavior |
|-------------|----------|
| `all` | Participate in all strands in the control network (default for servers) |
| `sAppId:<id>` | Only participate in strands matching the specified sAppId |
| `strandId:<id>` | Only participate in a single specific strand |
| `none` | Control network only, no strand participation |

This allows a mobile app to embed a cadre node that only participates in the app's strand while the user's server nodes handle the full portfolio.

- **Ring Zulu (Transaction)**: Storage-profile nodes participate — transaction verification, ephemeral caching, forward to storage rings
- **Ring 3** (8 partitions) → **Ring 2** (4 partitions) → **Ring 1** (2 partitions) → **Ring 0** (full keyspace): Concentric storage rings. Storage-profile nodes join the appropriate ring based on capacity.

## Enrollment and Bootstrap

Adding a new node to a cadre involves a "cold start" problem: the new node needs control network data to validate connections, but can't get that data without first connecting. The **control network seed** solves this by pre-populating the new node's cache with enough authorization data to establish the first connection.

### The Cold Start Problem

When a new node joins a cadre:

1. **New node has empty control DB** — no `CadrePeer` entries, can't validate anyone
2. **Existing nodes enforce authorization in the DB layer** — CadreControl constraints reject unauthorized control writes; there is not yet a libp2p connection-gating layer
3. **NAT complicates dialing** — phones behind NAT can't receive incoming connections

The seed provides the minimal state needed to break this chicken-and-egg cycle.

### Control Network Seed

A seed contains everything a new node needs to join the control network:

```typescript
interface ControlNetworkSeed {
  // Identity - which control network to join
  partyId: string;

  // Authorization cache entries for peer validation
  peers: SeedPeer[];

  // Signature over { partyId, peers }
  signature: string;

  // ed25519 public key (base64url) used to verify `signature`
  signerKey: string;
}

interface SeedPeer {
  peerId: string;           // libp2p peer ID
  multiaddrs: string[];     // Dial hints (may be empty if NAT'd)
  isOwner: boolean;     // Hint: an owner-hosting peer to prefer dialing
  publicKey?: string;       // ed25519 public key (base64url) — set on owner peers (derived from the OwnerKey table, not used to gate the seed's own signerKey)
}
```

`SeedPeer` is the **cold-start projection** of a `CadrePeer` row: a seed pre-populates the peerstore so an unconnected node can make its first dials. Once connected, the authoritative, replicated form of the same mapping is the `CadrePeer` row itself, which is a signed **`PeerAddressRecord`**:

```typescript
interface PeerAddressRecord {
  peerId: string;       // libp2p peer ID (base58btc) — the CadrePeer row key
  publicKey: string;    // ed25519 (base64url) whose libp2p identity IS peerId
  addrs: string[];      // current dialable multiaddrs, signaling (/p2p-circuit) first
  updatedAt: number;    // epoch ms — strictly increasing freshness stamp per peer
  sig: string;          // ed25519 self-signature over (peerId, addrs, updatedAt)
}
```

The peer self-publishes and self-signs this record (the `CadreControl.CadrePeer` schema enforces the self-signature, monotonic `UpdatedAt`, and immutable `PeerId`/`PublicKey` on update); a resolver re-verifies it. Unlike a `SeedPeer` dial hint, a `PeerAddressRecord` is freshness-stamped and individually trust-checkable, so `resolvePeerAddrs` never hands back a stale relay reservation. The **owner node self-registers its own `CadrePeer` row at startup** (`registerSelf`, wired into `cadre start --owner` right after seed-bootstrap init), so every seed it mints already carries the owner's own dialable address as an owner peer — otherwise the seed would omit the owner (and thus any address for a receiver to dial it) until the TTL heartbeat first published the row. Trust in a seed rests on its `signerKey` being a known/pinned owner, not on the owner peer being present (see `SeedTrustPolicy`); self-registration furnishes the dial target, it does not pass a gate. The background heartbeat keeps the row fresh thereafter. A FRET-backed, coordinate-keyed liveness store remains future work (`tickets/backlog/fret-backed-peer-record-liveness.md`).

> **Convergence prerequisites and current status.** The replicated `CadrePeer` form described above replicates in the wiring, a party's control nodes now auto-connect, and a write made while alone now re-replicates on cohort growth — only the **delete-while-alone** path remains an open durability gap:
>
> - **The control tables are network-backed.** ✅ `ControlDatabase.initialize()` now makes `optimystic` the default vtab (`setDefaultVtabName('optimystic')` + `setDefaultVtabArgs({ transactor: 'network', … })`) and hydrates the catalog before applying `CONTROL_SCHEMA` — exactly as `connectToStrand` does for strand tables. The `declare schema CadreControl` tables (no per-table `using optimystic(...)`) therefore route to the Optimystic **network transactor**, so a control write replicates peer-to-peer (verified by `control-db-two-node-convergence.integration.ts`: a `CadrePeer` row written on A is observed on a connected B in ~1s). This required closing a transaction-semantics gap in the Optimystic vtab: a deferred `CHECK` referencing `committed.<Table>` (the `FormationUsage.Monotonic` anti-replay) now reads the pre-transaction snapshot via Quereus's `_readCommitted` flag, and the vtab now enforces secondary `unique` constraints (the single-use `StampId` / `MemberPrivateKey` anti-replay columns) — both landed in the `../optimystic` workspace under `control-db-network-backed`.
> - **The cohort auto-connects.** ✅ Each node runs an in-node `reconcileControlCohort` routine (`CadreNode`, wired into the post-start background work + a `.unref()`'d ~15s cadence + `self:peer:update`): it reads its known siblings (`listMembers`), classifies the owner members as a publicly-dialable **backbone** (always dialed), fills the remainder up to a bounded out-degree (`NetworkConfig.controlCohort.targetDegree`, default 6, deterministic peerId order), skips already-connected peers, and dials the rest best-effort via `resolvePeerAddrs` (signed `CadrePeer` record) with a libp2p peerStore cold-start fallback. This is what makes a party's control nodes form the FRET cohort without the test-only manual `dial()` the convergence scenario uses — proven by `control-cohort-auto-convergence.integration.ts` (B converges with zero manual control dials), and the reconcile dial being the *sole* connector — not the cold-start seed path, which necessarily forms the first connection in any two-node party — is proven end-to-end by `control-cohort-three-node-isolation.integration.ts` (a client-only node that listens on nothing, so the link is unambiguously one it opened, dials a sibling it learned about only through record replication). That scenario stops at "the link forms and the cohort converges" — the revision it finally observes could still have reached it through the owner — so `control-cohort-edge-carries-data.integration.ts` closes the last step: the client is severed from the owner (a test connection gater denies every further dial to it), the sibling authors a fresh `CadrePeer` revision while the client provably holds zero connections, and the client then observes that revision while every control connection it holds is the reconcile-formed one to that sibling — so the edge demonstrably *carries* control data, not merely exists (read direction; the write direction is implied by cohort seating, not separately asserted). Cold start is still brokered by the existing seed/`bootstrapNodes`/relay paths (the routine consumes that first connection, then maintains+extends the cohort from converged rows) — with the retry described in the next bullet when that first connection never lands. WebRTC/DCUtR upgrade-to-direct for sustained relay-only edge↔edge links remains future transport work (`rn-webrtc-transport`).
> - **Cold-start bootstrap retries.** ✅ `SeedBootstrapService.applySeed` dials the seed's owner peers exactly **once**, best-effort. When that dial fails (owner momentarily down, relay reservation not yet up, NAT traversal lost the race) the joining node has no connection *and* an empty `CadrePeer` table, so the sibling-enumerating pass above has nothing to work from — before `cold-start-control-redial` such a node was stranded permanently. `reconcileControlCohort` now takes a **cold-start branch** whenever it finds zero siblings: it re-dials the owner-flagged peers of every seed the node has applied, retained by `CadreNode` in its own **node-local bootstrap-peer store** (`bootstrap-peer-store.ts`, keyed peerId → the seed's multiaddrs + a `recordedAt` stamp) rather than read out of the shared libp2p peerStore, so the retry set is exactly what an owner-signed, trust-anchored seed nominated. Both seed intake paths feed it — the `CadreNode.applySeed` wrapper (which may run on a throwaway service) and the inbound `/sereus/seed/1.0.0` handler via `onSeedApplied`. Retries are **unbounded and unbacked-off**, at the reconcile cadence: the branch is gated by "no siblings yet", so it stops the instant the node is in the party, and a stranded node must keep trying. `ApplySeedResult` now reports `ownerDialsAttempted` / `ownerDialsFailed` so a caller can distinguish "seeded and connected" from "seeded and stranded" without overloading `success` (which still means "the seed was accepted"). The retry set excludes **self** (`createSeed` projects every `CadrePeer` row, so an owner applying a later seed finds itself in the owner list) and every address is **bound to the peer id it was retained under** before dialing — an address naming a different peer is dropped, one naming none has `/p2p/<id>` encapsulated — so a retry authenticates the peer it aims at rather than whoever answers. Proven by `control-cohort-cold-start-retry.integration.ts` (A refuses B's seed dial, vouches B afterwards, B re-dials itself back in and converges). **The retry set survives a restart on Node.** Nothing else on disk records that a seed was ever applied (`applySeed` writes no control row, and a `CadrePeer` row fills in only *after* a connection succeeds), so an in-memory-only set meant a restart erased the only addresses the node had and stranded it permanently — reachable by nothing more exotic than a container or phone-app relaunch, and *not* fixed by `cadre-cli start --seed` for the two paths that receive a seed at runtime (the `/sereus/seed/1.0.0` protocol, and `cadre-host`'s donation flow pushing to the node's `POST /seed` admin route; neither gets a `--seed` argument on the next start). `BootstrapPeerStore` is therefore the same shape as the trusted-owner anchor: cross-platform interface, ephemeral in-memory default, and a Node-only `FileBootstrapPeerStore` (atomic JSON snapshot per party under the node's **state directory** — `ResolvedConfig.nodeStateDir`, behind the subpath `@serfab/cadre-core/bootstrap-peer-store-file`) that `cadre-cli start` injects unconditionally — so any node the CLI runs keeps retrying across restarts, whatever form its identity is configured in (`identity.protobufKeyFile` / `keyFile` / `privateKeyHex`). `nodeStateDir` is resolved once in `resolveConfig`: an explicit `nodeState.dir` (or `CADRE_NODE_STATE_DIR`) wins, else it defaults to the directory holding the config file — decoupled from wherever the identity key happens to live, since dialing grants no authority and the addresses are not secret. That includes every `cadre-host`-spawned child: `HostProcessOrchestrator` now gives each managed node its own `identity.key` inside the node's own workdir (`<rootDir>/<containerId>/`, written once and reused on every re-spawn — `orchestrator/node-identity.ts`) and passes it as `--identity-protobuf`, and writes that same node's `cadre.json` into the same workdir — so the config-file-directory default still lands both stores there. A donated node's node-local state — identity, retained bootstrap dial targets, trusted-owner anchor — all lives in that workdir, and all of it is deleted with the workdir when the loan is terminated. Before that wiring landed, donated nodes were spawned with no identity at all: a fresh peer id per process, and both stores silently in-memory. The multi-tenant `@serfab/cadre-provider` Docker path carries the identical durability property via a different substrate: `DockerOrchestrator.createContainer` mounts a per-container **named Docker volume** (`cadre-<containerId>-data`, `volumeNameFor`) at `/data` — inspected-and-reused rather than recreated on every provision, so an image-upgrade recreate keeps the same volume and therefore the same identity — and the container's own `docker/entrypoint.sh` mints `cadre-peer.key` into that volume on first boot (`create_identity`, run *before* config generation so the generated `cadre.yaml`'s `identity:` block can name it) and exports `CADRE_KEY_FILE`/`CADRE_NODE_STATE_DIR` so `applyEnvironmentOverrides` re-applies them over the loaded config on every start — the env value stays authoritative and repairs a container whose `cadre.yaml` predates this fix. `CADRE_NODE_STATE_DIR` defaults to the same `/data` mount, so the bootstrap-peer store and trusted-owner anchor ride along on the identical volume and survive a container restart the same way the identity key does. `removeContainer` deletes the named volume alongside the container, so all of it dies with the tenant's lease — matching the `cadre-host` workdir-deletion behavior above. Load policy matches the anchor's: missing / corrupt / foreign-party file ⇒ cold start; present-but-unreadable ⇒ throw. Structurally junk entries (unparseable peer id, empty address list) are dropped on load, but **nothing here is re-verified and nothing here is trust-bearing** — only dial targets are persisted, the seed was signature-checked against the anchor before they were retained, and every address is re-bound to its peer id before the dial. Persistence is **one injectable seam, not one backend per platform**: `node-local-snapshot.ts` owns the shared machinery both node-local records use (the `{ version, partyId, entries }` envelope, the load policy above, per-entry validation, and the serialised full-snapshot write chain whose in-memory half updates synchronously), and the only platform-specific part is a `DurableSlot` — `load(): Promise<string | undefined>` / `save(text)` — that the embedding app supplies. `PersistentBootstrapPeerStore` / `PersistentTrustedOwnerStore` (cross-platform, exported from the default entry) are that machinery; `FileBootstrapPeerStore` / `FileTrustedOwnerStore` are those classes over a `FileDurableSlot`, which is the whole of what stays behind the Node-only subpaths. A slot MUST throw rather than return `undefined` when it exists but cannot be read: `undefined` means cold start, and a snapshot write over a misread record destroys it. **The browser and React Native now inject slots too.** The browser's is one key of the control database's `kv` store (`reference-app-web/src/lib/node-local-slots.ts`); React Native splits the two records across two backends by security property (`reference-app-rn/src/node-local-slots.ts`) — the trust-bearing owner anchor into the platform secure enclave (`expo-secure-store`, the same store the identity key lives in, ungated so the node comes up headless), and the dial hints into an app-private LevelDB database of their own, because multiaddr snapshots grow past SecureStore's ~2048-byte value limit while granting no authority. **NativeScript injects slots too** — both records share one `SqliteKVStore` (empty key prefix) over the `sereus-peer-identity` SQLite database that already holds the plaintext identity BLOB (`reference-app-ns/src/node-local-slots.ts`, wired in `cadre-phone.ts`); that app has no Keychain/Keystore integration, so splitting the anchor into a more tamper-resistant store must wait for the same hardening that moves the identity key. No platform is ephemeral by default any more. ⚠️ On both phone apps the record is durable but not yet *observable* across a relaunch: both records are party-scoped and neither app persists its party id (it is typed into Settings each launch), so a fresh id loads empty slots — closed by `feat-rn-persist-node-start-options`. ⚠️ The NativeScript app's anchor is durable but nothing in that app ever *writes* it: it wires no owner private key (so no genesis self-anchor) and has no invite-paste field (so no pinned owner keys), which under the default `anchoredTrustPolicy` means every seed it is handed is rejected — tracked as `feat-ns-invite-trust-pinning`. Its bootstrap-peer record does fill in, from `applySeed`.
> - **Write-while-alone durability (inserts/updates).** ✅ A write made while a node is alone (its block's cluster ≤1) commits **local-only** (no broadcast). `CadreNode` now detects this — the pragmatic proxy is `controlNode.getConnections().length === 0`, a sound lower bound for "alone" (the precise signal would be the block's `getClusterSize`, noted as a future tightening) — queues the affected row, and **re-issues it on the 0→≥1 control-connection growth edge** (a `connection:open` listener; single-flight drain). Self rows re-publish via the idempotent `registerSelf`/`registerDeviceToken` refresh; an owner's other-peer membership rows are re-touched via an owner-signed `UpdatedAt` bump (`ControlDatabase.reauthorizeCadrePeer`, driven by `SeedBootstrapService.reauthorizePeer` — the owner branch of `CadrePeer.AuthorizedUpdate`). On the first growth after start, an owner also reconstructs the queue by re-touching every `Sig`-null membership row it may have authored (covering writes from before this process started — `Sig`-bearing rows are the owning peer's to republish and are skipped). Re-touch is safe to over-apply (monotonic `UpdatedAt`; the schema rejects a replayed older record). Proven by `control-write-while-alone-convergence.integration.ts` (a `CadrePeer` row and a `DeviceToken` both written while alone converge to a connected reader). Landed in `control-write-ensure-replicated`.
> - **Delete-while-alone durability (open, security-relevant).** A `removePeer` (or `clearDeviceToken`, or the owner-signed `ControlDatabase.deleteStrand` / `deleteValidationKey`) that commits while alone physically removes the row locally, so it **cannot** be re-issued the way an insert/update can — a re-issued `delete … where PeerId = X` matches nothing once the row is gone, so the removal does not propagate, and a revoked peer may persist as a member elsewhere. The commit-alone is **logged loudly** and a best-effort re-issue is attempted (it only helps if the row is somehow still present), but full durability needs a schema **tombstone** (soft delete that IS re-issuable + reconstructable across restart) — tracked in `tickets/backlog/control-delete-while-alone-tombstone.md`. The `Revocation` row every guarded delete now writes alongside it (`removePeer`, `clearDeviceToken`, `deleteStrand`, `deleteValidationKey` — all four share one implementation, `ControlDatabase.deleteGuardedRow`) is exactly such a re-issuable insert, and readers already drop a `CadrePeer` row whose stamp it retires (`listAuthorizedMembers`) — but it is **not** yet queued by the write-while-alone re-issue path, so a removal that commits alone still does not propagate. Wiring it in is the cheapest lever that ticket has; note the re-issue must carry the tombstone's owner signature in its write context, since `Revocation.Authorized` re-checks it on every node.
>
> Reads are **pull-on-read**: `resolvePeerAddrs`/`isMember` do a single read with no wait, so callers converge by **polling/refresh** (the "periodic refresh until reactivity" below).

The seed is **cache pre-population**, not a separate database. After applying the seed, the node's normal query mechanisms (`select * from CadrePeer`) fetch authoritative state from peers, naturally merging with the seed data.

### Unified Node Behavior

After applying a seed, a node follows a simple unified algorithm regardless of network topology:

1. Populate peerstore with peers + multiaddrs from seed
2. Attempt outbound dials (best effort) — prefer peers flagged `isOwner` first
3. Once connected: begin control network sync (Optimystic), refresh via `select * from CadrePeer`
4. Periodic refresh (until reactivity): re-query CadrePeer, update local cache

The node doesn't need to know who will dial whom — it tries everything and accepts whatever works first.

### Enrollment Flow: Phone Adds Provider Drone

The most common case: a user on a NAT'd phone adds a provider-hosted node.

```mermaid
sequenceDiagram
    participant Ph as Phone (Owner, NAT'd)
    participant P as Provider API
    participant D as Drone (New)
    Ph->>P: 1. createContainer (plan, payment)
    P->>D: 2. Spawn container
    D->>P: createCadrePeer() → PeerId + multiaddr
    P->>Ph: 3. Return PeerId + multiaddr
    Note over Ph: 4. authorizePeer(drone) — sign & insert CadrePeer
    Note over Ph: 5. createSeed({peers:[{phone, addrs:[]}]}) — NAT'd, no addrs
    Ph->>P: 6. initializeNode(containerId, seed)
    P->>D: 7. Forward seed
    Note over D: 8. applySeed() → cache phone ✓, no dial hints → wait
    Ph->>D: 9. Dial drone (outbound, NAT-safe)
    Note over D: 10. Validate: phone in cache? ✓ → accept
    Ph<<->>D: Control Network Sync
    Note over D: 11. select * from CadrePeer → authoritative cache refresh
```

Key points:
- Phone is NAT'd → seed has no multiaddrs for phone → drone waits
- Phone dials drone (outbound from phone's perspective) → NAT-safe
- Drone validates phone against seed cache → connection accepted
- Normal sync populates authoritative state

### Enrollment Flow: Server Adds Phone

When a server (public IP) adds a phone to its cadre:

```mermaid
sequenceDiagram
    participant S as Server (Owner)
    participant Ph as Phone (New)
    S->>Ph: 1. Share invite out-of-band (QR/link)<br/>Contains: partyId, serverMultiaddr
    Note over Ph: 2. createCadrePeer() — generate keypair
    Ph->>S: 3. Dial server (using invite addr)<br/>Sends {peerId, inviteToken}
    Note over S: 4. Validate token<br/>5. authorizePeer(phone), insert CadrePeer
    S<<->>Ph: Control Network Sync
    Note over Ph: 6. Phone syncs full control DB
```

No seed needed — server is dialable, so phone just connects and syncs.

### Enrollment Flow: Server Adds Drone

When a server adds another provider-hosted node:

```mermaid
sequenceDiagram
    participant S as Server (Owner)
    participant P as Provider API
    participant D as Drone (New)
    S->>P: 1. createContainer
    P->>D: 2. Spawn container
    D->>P: createCadrePeer() → PeerId
    P->>S: Return PeerId + multiaddr
    Note over S: 3. authorizePeer(drone)<br/>4. createSeed({peers:[{server, addrs:[serverAddr]}]})
    S->>P: 5. initializeNode(seed)
    P->>D: 6. Forward seed
    Note over D: 7. applySeed() → cache server, has dial hints
    D->>S: 8. Drone dials server
    Note over S: 9. Validate: drone in DB ✓ → Accept
    S<<->>D: Control Network Sync
```

Seed includes `bootstrapAddrs` because server IS dialable. Drone initiates connection to server.

### When Is a Seed Needed?

| Instigator | Adding | Seed Needed? | Who Dials Whom? |
|------------|--------|--------------|-----------------|
| Phone (NAT) | Drone (public) | **Yes** — drone needs phone's CadrePeer in cache | Phone → Drone |
| Phone (NAT) | Phone (NAT) | **Yes** — both need each other; use relay addrs | Both → Relay |
| Server (public) | Phone (NAT) | **No** — phone can dial server directly | Phone → Server |
| Server (public) | Drone (public) | **Yes** — includes `multiaddrs` so drone can dial | Drone → Server |

The key asymmetry:
- **Instigator has public IP**: Seed includes `multiaddrs`, new node dials in
- **Instigator is NAT'd**: Seed has no `multiaddrs`, instigator dials out after seed is applied

### Seed Delivery Protocol

Seeds can be delivered through multiple mechanisms. For direct delivery when the new node is dialable, we define a libp2p protocol:

**Protocol ID**: `/sereus/seed/1.0.0`

```mermaid
sequenceDiagram
    participant I as Instigator (Owner)
    participant N as New Node (listening on /sereus/seed/1.0.0)
    I->>N: 1. Dial /sereus/seed/1.0.0
    I->>N: 2. Send SeedMessage {partyId, peers, signature}
    Note over N: 3. Validate: sig from peer in peers[]?
    Note over N: 4. Apply seed: set partyId, populate cache
    N->>I: 5. SeedAck {accepted: true}
    I<<->>N: Control Network Sync begins
```

**Message Types**:

```typescript
// Instigator → New Node
interface SeedMessage {
  partyId: string;                    // Control network to join
  peers: SeedPeer[];                  // Authorization cache entries
  signature: string;                  // Signed by an owner key
  signerKey: string;                  // Owner ed25519 public key (base64url)
}

// New Node → Instigator
interface SeedAckMessage {
  accepted: boolean;
  reason?: string;                    // Present if accepted=false
}
```

**Validation**:
- The `signature` is an ed25519 signature over `digest([canonicalJson({partyId, peers})], 'sha256')` — a canonical (recursively key-sorted, `undefined`-dropped, whitespace-free) serialization shared with cadre-host's update-manifest signing. Both signer and verifier route through the same `canonicalSeedPayload` builder so the signed bytes are independent of key insertion order
- New node verifies `signature` using `signerKey` (ed25519)
- `signerKey` must clear a **trust anchor that does not come from the seed body** — a signature only proves the seed is internally consistent, and both `signerKey` and the seed's own `isOwner` peer flags are attacker-supplied, so a forged self-asserting seed must not be able to vouch for itself. The receiver evaluates a `SeedTrustPolicy` against its *own* node-local trusted-owner anchor (`TrustedOwnerStore`, below) — **not** the replicated `CadreControl.OwnerKey` table — in priority order:
  - **Anchored** (default, `anchoredTrustPolicy`): the signer is trusted iff its key is in the receiver's node-local anchor (established out of band: genesis, invite pin, operator pin).
  - **Pinned out-of-band**: owner keys delivered outside the seed — carried by `CadreInvite.ownerKeys`, or pinned by operator config — let a not-yet-anchored invitee accept its first seed. A key accepted this way is persisted into the anchor, so later seeds from that owner need no pin.
  - **TOFU (opt-in)**: an interactive confirmation callback invoked on first sight of an unknown signer key; off by default. A confirmed key is likewise persisted into the anchor (as an `operator` pin), so the prompt is not repeated.
  - **Secure default**: a node with an empty anchor, no pinned keys, and no TOFU confirmation **rejects** the seed — including one signed by a key sitting in its replicated `OwnerKey` table.
- Owner identity is sourced from the `OwnerKey` table, **not** from the libp2p `peerId`. An Ed25519 PeerId embeds its public key, so each peer's ed25519 key is derived from its `PeerId` and a peer is marked `isOwner` iff that derived key is in `OwnerKey` — making multi-owner cadres representable and decoupling owner status from the transport identity.
- **Node-local trusted-owner anchor** (`TrustedOwnerStore`, `trusted-owner-store.ts`): the replicated `OwnerKey` table itself cannot ultimately anchor trust — a node whose *local* copy is still empty satisfies the table's genesis branch (which tests the pre-transaction owner count) and can seat its own key, and that row replicates into every peer's table. The table's authorization rules close escalation against an *already-populated* copy — a key that holds no owner row cannot enroll itself, a pair cannot enroll each other, and no owner row can be removed or re-pointed without a pre-existing owner's signature — but they cannot close the empty-copy genesis path, which is precisely why the anchor exists. Each node therefore also keeps a NON-replicated, per-party record of owner keys established out of band: founding genesis (`initializeSeedBootstrap` anchors the founder's own key), the invite's pinned `ownerKeys` at enrollment (`CadreNode.trustOwnerKeys` / `CadreNodeConfig.trustedOwners.pinnedKeys`), or operator pins (cadre-cli `--pin-owner-key` / `CADRE_OWNER_KEYS`). File-backed in the node's state directory on Node hosts (`ResolvedConfig.nodeStateDir` — `@serfab/cadre-core/trusted-owner-store-file`, same `node:fs` isolation as `key-store-file`), in-memory elsewhere; persistence rides the same injectable `DurableSlot` seam as the bootstrap-peer store above, with one intentional difference in policy — an anchor record that cannot be read *in full* is discarded entirely (trusting a subset of the keys a record claims would be a silent downgrade), where the peer store drops the bad entry and keeps the rest. That directory must be writable by the node's user: it defaults to the directory holding the config file, which some deployments mount read-only (the shipped systemd unit sets `CADRE_NODE_STATE_DIR=/var/lib/cadre` for exactly that reason). Two consumers now rest on this anchor, both fail-closed: the authorized-membership predicate (`CadreNode.isAuthorizedMember` — the wake and strand-addr gate), where a `CadrePeer` row counts only when its persisted voucher (`VouchOwner`/`VouchSig`) verifies against an anchored key; and seed trust, whose `SeedTrustContext.knownOwnerKeys` is the anchor's contents. Invites hand out the anchor's keys — and only those — as their pinned `ownerKeys`, for the same reason: the invitee anchors whatever arrives, so a replicated-only key must not ride an invite into a new node's anchor. An issuer with no anchor mints an invite with no `ownerKeys` rather than falling back to the table. The replicated `OwnerKey` table remains the replication mechanism and the source of the `isOwner` dial hint in seeds, **not** a trust anchor.
- **Control-network inbound connection gate** (`membership-connection-gater.ts`, defense-in-depth): the control node composes a membership gater onto any configured `network.connectionGater` — at the encrypted-connection checkpoint (authenticated PeerId known, no protocol negotiated yet) it refuses an inbound peer that is positively NOT an authorized member, so a known outsider is never even in the conversation with the control protocols. A libp2p gater decides per connection, not per protocol, so the policy admits whenever a legitimate stranger interaction could be riding the connection and lets the per-stream gates decide: an un-enrolled node (empty anchor or empty authorized set — a brand-new node must accept its seed, and the rows that authorize siblings arrive by replication over these very connections), an open enrollment window (`CadreNode.createInvite` opens one for the invite's validity; `openEnrollmentWindow` serves out-of-band flows), an **outstanding open invitation** (cross-party formation is stranger-facing by design), and the configured bootstrap/relay peers. The formation exemption is keyed on *expectation* of a stranger, not capability to serve one: it holds only while at least one unexpired, not-fully-consumed invitation is outstanding — a token this process minted or published, or a still-redeemable `FormationInvite` row the usage recorder can see (`StrandSolicitationService.hasOutstandingInvitation`). Merely registering the formation responder does **not** disarm the gate, so an app that registers eagerly at bring-up (`reference-app-rn`) and an initiator's `formStrand` both keep it live; the in-memory half of the answer dies with the process, so after a restart only persisted invites still hold it open. The stranger-open protocol allowlist — `/sereus/seed/1.0.0` and `/sereus/formation/1.0.0`, each carrying its own in-protocol trust check — is defined once in that module. Every ambiguous or failing state admits (fail-open) because the per-stream gates and read-time voucher predicate are the fail-closed layers; outbound dials are never gated; strand cohort nodes never get this gater (their peers are legitimately cross-party).
- **Per-stream control-DB gate** (`CadreNode.authorizeInboundControlStream`, the fail-closed layer behind the connection gate): every inbound stream on the four Optimystic control-DB protocols (`/optimystic/control-<party>/{repo,cluster,sync,block-transfer}`) is judged through `@optimystic/db-p2p`'s `authorizeInboundStream` seam, which on deny aborts the stream *before any frame is decoded* — the remote observes only a stream reset, and the connection survives. The predicate is deliberately synchronous and in-memory: it consults the **materialized** authorized-peer snapshot (refreshed on membership writes and on each control-cohort reconcile pass), never a live control-DB read, because serving such a read would itself require admitting the sibling's stream the read is deciding — mutual denial deadlock. It shares the connection gate's unconditional admissions (node not fully up, absent/empty trusted-owner anchor, configured bootstrap infra, empty snapshot — the replication cold start) but has **no stranger carve-outs**: during an enrollment window a stranger's *connection* is admitted so seed delivery can ride it, yet its repo streams are still refused — exactly the hole a connection-level decision cannot close. Consequence of the snapshot: a member added while a node was down is admitted by that node only after its next reconcile refresh — bounded staleness by design. The refresh is **driven by the write, not by the caller**: every committed `CadreControl.CadrePeer` row write goes through `ControlDatabase.mutateCadrePeer`, which notifies a single post-commit listener that `CadreNode.start()` wires to `refreshMembershipGate()` — so a member row written *below* the `CadreNode` membership wrappers (straight through `getSeedBootstrapService()`, or through a service constructed outside `CadreNode` entirely) admits its peer just as promptly as `authorizePeer` does, and the writer's own `await` already observes it. Refreshes coalesce: a burst of writes shares one membership read, and a caller that awaits one always sees a read that *began after* its own change. `refreshMembershipGate()` stays public for the two changes that write no local row and therefore raise no notification — a membership row that arrived by **replication** (otherwise picked up on the next reconcile pass) and a newly **anchored trusted-owner key**, which flips already-present rows into the authorized set (`applySeed` and the inbound seed handler's `onSeedApplied` both call it for exactly that reason). Proven end-to-end in `integration-tests` scenario `control-stream-authz` (member's raw pend/commit succeeds; an enrollment-window outsider's identical pend is refused with its connection intact and nothing written).
- A seed carries only peer-address hints (`peers[]`); warm-cache prepopulation with signed Optimystic log entries is deferred (see backlog `seed-warm-cache-prepopulation`)
- **Receiver hardening (within-membership DoS):** even a membership-gated peer could misbehave, so the inbound handler bounds two resources. Each stream read runs under `seedReadTimeoutMs` (default 10s) — a peer that opens a stream and never half-closes its write end is aborted rather than awaited forever — and concurrent inbound seed streams are capped by `maxConcurrentSeeds` (default 100), over which a non-accepting ack is returned without applying a seed. The cap is per-service, not per-remote-peer. The shared read/frame primitives (`control-stream.ts`, also used by push-wake) own the timeout-and-abort logic.
- **Sender hardening (untrusted delivery target):** the seed target is a *not-yet-trusted* node the instigator chose to dial during onboarding — more exposed than the membership-gated receiver above — so `deliverSeed` bounds the whole exchange (dial, write, ack read) with `seedDeliverTimeoutMs` (default 10s) and caps the ack it will buffer at the same 1MB `MAX_SEED_SIZE`. A per-attempt `AbortController` carries the deadline into both `dialProtocol` and the live stream, so neither the connect nor the ack read leaks when the target accepts the stream and then goes silent or streams junk. Not merely the same shape as the wake and strand-addr senders — the *same code*: `control-stream.ts`'s `withDeadline` (deadline + cancellation signal) and `exchangeFrame` (write one frame, half-close, read the response, reset the stream once on any failure) are shared by all three, each supplying only its dial options, request object, and response decoder.

**Alternative Delivery Mechanisms**:

| Mechanism | When Used | Notes |
|-----------|-----------|-------|
| Direct protocol | New node is dialable | Instigator dials, sends seed directly |
| Provider API | Provider-hosted node | `PUT /containers/:id/seed` via HTTPS — delivery only; the container must also have been *created* with its tenant's owner key pinned (below) |
| QR code / deep link | Mobile onboarding | Seed encoded in URL, opened by app |
| Environment variable | Container startup | `CADRE_SEED` contains base64-encoded seed |

All mechanisms deliver the same `SeedMessage` payload; only the transport differs.

**Delivery and trust are separate gates**, and a hosted node makes the split explicit. On the provider path the per-container bearer token (`CADRE_SEED_TOKEN`) decides whether `POST /seed` is *accepted for processing*; whether its contents are *honoured* is decided by the node's own `SeedTrustPolicy` against its node-local anchor — which is empty on a fresh container and which nothing replicated can fill. So a container-hosted node must be told at **create** time whose seeds to trust: `POST /containers` takes `pinnedOwnerKeys` (the tenant's own base64url owner key(s)), and the orchestrator passes them to the node as comma-separated `CADRE_OWNER_KEYS` — the same operator-pin path as cadre-cli's `--pin-owner-key`, and the same var cadre-host's donation flow uses. The pin flows strictly from one tenant's create request into that tenant's own container: there is deliberately **no provider-level default owner key**, since a provider-wide pin would let one tenant's owner seed another tenant's node. The first accepted seed anchors the key (`anchorAs`) into the node's trusted-owner store on the durable `/data` volume, so later seeds from the same owner need no pin and survive a restart. A container created with no pinned keys is provisioned normally (and the omission is logged) but will refuse every seed — recreate it with keys rather than trying to deliver one.

### Simple API

From the **instigator's** perspective:

```typescript
// 1. Authorize the new peer
await cadreNode.authorizePeer(newNodePeerId, newNodeMultiaddrs);

// 2. Generate seed for the new peer
const seed = await cadreNode.createSeed();
// Includes: partyId, all authorized peers, our multiaddrs if dialable

// 3. Deliver seed (choose based on context)

// Option A: Direct protocol (if new node is dialable)
await cadreNode.deliverSeed(newNodeMultiaddr, seed);

// Option B: Via provider API
await provider.initializeNode(containerId, seed);

// Option C: Encode for out-of-band delivery
const encodedSeed = cadreNode.encodeSeed(seed);  // base64
// Share via QR, link, etc.

// 4. If we're NAT'd and new node can't dial us, we dial them
if (!weHavePublicIp) {
  await cadreNode.connectToPeer(newNodeMultiaddr);
}
```

From the **new node's** perspective:

```typescript
// 1. Receive seed (one of these, depending on delivery mechanism)

// Option A: Listen for direct delivery
cadreNode.on('seed', async (seed) => {
  await cadreNode.applySeed(seed);
});

// Option B: From environment (container startup)
const seed = process.env.CADRE_SEED
  ? decodeSeed(process.env.CADRE_SEED)
  : null;
if (seed) {
  await cadreNode.applySeed(seed);
}

// 2. Start node - automatic connection handling
await cadreNode.start();
// Node now:
// - Accepts connections from peers in cache
// - Dials any peers with known multiaddrs
// - Syncs once connected
```

### Helper Functions for Common Scenarios

The Seed Bootstrap API includes helper functions for common enrollment patterns:

**Server/Phone adds Drone (via provider API)**:
```typescript
// Owner receives drone info from provider API
const droneInfo = await provider.createContainer(plan);

// One call: authorize + create seed
const { seed, encodedSeed } = await cadreNode.addDrone({
  dronePeerId: droneInfo.peerId,
  droneMultiaddrs: droneInfo.multiaddrs
});

// Send seed to provider for drone initialization
await provider.initializeNode(droneInfo.containerId, encodedSeed);
```

The same `addDrone` helper backs the [cadre-host node-donation flow](cadre-host.md#node-donation-the-primary-role) (step 3): the requester calls it against a node donated by a home host instead of a cloud provider, and delivers the resulting `encodedSeed` over the host's `/grants` surface.

**Server invites Phone (QR/link flow)**:
```typescript
// Server creates invite
const { invite, encodedInvite } = await serverNode.createInvite(
  'secret-token',  // Optional token
  3600000          // Expires in 1 hour
);
// Share encodedInvite via QR code or link

// Phone receives invite and dials
const invite = phoneNode.decodeInvite(encodedInvite);
await phoneNode.dialInvite(invite);
// Phone is now connected, sends join request with token

// Server accepts phone
await serverNode.acceptPhone(
  { phonePeerId: phonePeerId, token: 'secret-token' },
  invite
);
```

**Phone adds Phone (NAT-to-NAT via relay)**:
```typescript
// Owner phone adds new phone with relay support
const { seed, encodedSeed } = await ownerPhone.addPhoneWithRelay(newPhonePeerId);
// Seed includes relay addresses for the new phone to dial through

// Share encodedSeed out-of-band
// New phone applies seed and connects via relay
```

## Strand Lifecycle

### Reactive Strand Management

Cadre nodes watch the control network's `Strand` table for changes. When a strand is added, each node:

1. Creates a new libp2p node via `@optimystic/db-p2p` with `networkName = strand-${strandId}` (protocols scoped under `/optimystic/strand-${strandId}`)
2. Loads the strand's sApp schema via declarative schema
3. Bootstraps into the strand's cohort
4. Begins participating in transactions

```mermaid
flowchart LR
    INS["INSERT INTO Strand (...)"] -->|watch event| SW1["Strand Watcher"] --> START["Start Instance<br/>libp2p + Optimystic + sApp Schema"]
    DEL["DELETE FROM Strand (...)"] -->|watch event| SW2["Strand Watcher"] --> STOP["Stop Instance"]
```

### Strand Mode: Bootstrap vs Networked

Each strand instance is started in one of two modes (`StrandMode`), which selects the default transactor wired into the optimystic plugin:

| Mode | Default Transactor | When Used |
|------|--------------------|-----------|
| `networked` (default) | `network` — issues transactions through the strand's libp2p cohort | Multi-peer participation; the normal strand lifecycle |
| `bootstrap` | `local` — executes transactions against host-local raw storage with no peer round trips | Solo-node startup (e.g. first-launch, single-device cadre) where the cohort isn't reachable yet but the strand still needs to apply schema and accept DML |

In `bootstrap` mode the same `IRawStorage` instance handed to `createLibp2pNode` is also passed to the optimystic plugin via `rawStorageFactory`, so DML executed through the local transactor lands on the host's persistent backend (e.g. file system on Node, MMKV on React Native) instead of an in-memory store. Sharing the single instance — rather than constructing a second `IRawStorage` over the same id/prefix — keeps the libp2p and database read paths consistent and avoids cache divergence. The mode is fixed for the lifetime of a `StrandDatabase`; transitioning requires restarting the strand.

When a strand is launched without an explicit mode — the control-discovered (`handleStrandAdded`) path, or an `addStrand` caller that omits it — `CadreNode` auto-selects the mode from `CadrePeer` membership in the control network: `bootstrap` when no peer rows other than self exist (solo cold-start), `networked` once the cohort has other members. Membership presence drives the mode even when a peer's strand addrs are not yet known, so a cohort with unresolvable peers still comes up `networked` (`deriveCohortMembers` in `strand-cohort.ts`).

Both launch and teardown are **one event per instance**, keyed off whether `StrandInstanceManager` currently tracks the id. `launchStrand` returns the running instance untouched when one already exists — so the ordinary founding order (`addStrand` then `publishStrand`) emits a single `strand:started` even though this node's own `StrandWatcher` rediscovers the row it just published — and `detachStrand` stops nothing and emits no `strand:stopped` when no instance is tracked, so a node that published a strand's row but never ran it locally (an owner publishing on behalf of the party) stays silent when the row is later removed. A genuine stop-then-start cycle is two instances and emits the full pair each time.

The strand node's `bootstrapNodes` discovery list, however, is **not** taken from `CadrePeer.Multiaddr` — that field carries each node's *control*-network address, and a strand runs as its own libp2p instance on a separate port **with its own transport peerId** (derived from the cadre identity key + strandId, `strand-transport-key.ts`), so a control address names a different peer entirely and never joins the strand mesh. Cadre *authority* stays on the control node's identity key — the derived key is pure transport — and the distinct peerId is what lets a control node and its strand nodes share one circuit relay without colliding (the relay keys reservations by peerId). Instead `CadreNode.resolveCohortSeed(strandId)` resolves strand-network addresses **on demand** over the control mesh (see [Strand-Address Resolution](#strand-address-resolution)). Because the control network is single-party, this bootstraps **this party's own co-cadre nodes** onto a strand; cross-party strand discovery is a separate mechanism (strand formation / `MemberPeer`). When no connected sibling yet runs the strand the seed is empty and the strand starts and waits — self-healing on the next resume/check-in pass, which re-runs the resolution.

### Strand-Address Resolution

A strand is its own libp2p network on a separate port, so a node needs a sibling's **strand-network** multiaddr to seed the strand mesh — but the only address a `CadrePeer` row stores is the sibling's **control**-network address. Strand addresses are therefore resolved on demand with a native control-network RPC, `STRAND_ADDR_PROTOCOL = /sereus/strand-addr/1.0.0` (`strand-addr-protocol.ts`), modeled directly on the push-wake protocol (4-byte length-prefixed JSON frames, one request → one response per stream, shared `control-stream.ts` primitives).

- **Request/response.** `StrandAddrRequest { strandId, delegatePeerId? }` → `StrandAddrResponse { strandId, multiaddrs }`. The receiver (`StrandAddrService`, registered by `CadreNode.start` alongside the wake service) gates every request on `CadrePeer` membership — the same **v1 authorization** as wake: the control network already restricts membership to this party's cadre peers, so a non-member is refused with an empty list and no further signature is required. It then returns `getStrandMultiaddrs(strandId)`: the strand instance's live, signaling-first multiaddrs, or `[]` when the strand has no live node (hibernating / quiescing / never participated). Membership is not unconditional trust, so the receiver bounds a misbehaving own-cadre node exactly as wake/seed do — a per-read `readTimeoutMs` (default 10s, abort-on-timeout) and a `maxConcurrent` cap (default 100) — both via `control-stream.ts`.
- **Delegate announce.** The optional `delegatePeerId` is the derived transport peerId the requester's own strand-`X` node runs as (`strand-transport-key.ts`). When present, the receiver — after the same membership gate — records a short-lived, in-memory **delegate admission grant** for that peerId (`delegate-admission.ts`: 30-minute TTL, replace-per-(announcer, strand), capped per member and globally with soonest-expiry eviction). The grant is consulted only by the receiver's connection gate (`admitInboundControlConnection`), which is what lets a party control node running the circuit-relay server accept a member's NAT'd strand node's relay reservation — an otherwise-unknown peerId — while still refusing strangers; the per-stream gate (`authorizeInboundControlStream`) still denies a delegate every control-DB protocol. The client sets the field on the launch/resume seed pass (targets = connected siblings **plus** relays parsed from configured and live `/p2p-circuit` addrs, so the grant lands before the strand's `libp2p.start()` dials the reservation) and refreshes it from the control-cohort reconcile pass, throttled to half the grant TTL per (relay, strand). A dedicated `ops/` relay does not speak this protocol and needs no grant — it has no membership gate.
- **Client union.** `CadreNode.resolveCohortSeed(strandId)` reads `CadrePeer` membership (`deriveCohortMembers`), keeps the peerIds it already holds an open control connection to (they can answer now, and dialing by peerId reuses the live connection), and calls `collectStrandAddrs`, which RPCs each concurrently and returns the **deduplicated, signaling-first union** of their answers — best-effort, so a failed/timed-out/empty sibling is skipped, never fatal. Self is excluded. A NAT'd sibling reachable only via relay is dialed over its circuit-relay (`/p2p-circuit`) connection (`runOnLimitedConnection: true`); the returned strand multiaddr must itself be dialable on the strand network (deep per-strand NAT relay reachability is tracked separately).
- **Asymmetric bootstrap.** The first node up runs the strand solo (empty seed → `bootstrap` mode) and *answers* the RPC for it (`getStrandMultiaddrs` checks only for a live node, not the mode); a later sibling RPCs it, gets its live strand address, and dials in. When no connected sibling runs the strand yet, the seed is empty and the strand waits — self-healing because the hibernation resume / check-in path re-runs `resolveCohortSeed` and re-applies a fresh seed.

### Strand Formation

When forming a new strand with another party, a native cadre-core formation transport (`strand-formation-protocol.ts`, protocol id `/sereus/formation/1.0.0`) negotiates provisioning. It mirrors the non-deprecated seed-bootstrap service (length-prefixed JSON frames over libp2p streams) and replaces the deprecated `strand-proto`. The `StrandFormationManager` drives it from the `cadre-core` interfaces, carrying the caller's **real** invitation token + `StrandFormationDisclosure` and **both** parties' real cadre peer addresses end-to-end:

- **`StrandFormationManager`**: Responder side wires the inbound `FormationListener` to `DisclosureValidator` (identity), `FormationUsageRecorder` (token), and `StrandProvisioner` (provisioning); initiator side validates the responder's result via `FormationResponseValidator`. `ControlFormationUsageRecorder` (`control-formation-recorder.ts`) is the DB-backed `FormationUsageRecorder`. It follows the **provision-then-record** model: the host pre-creates the (closed) strand owner-signed and mints a `FormationInvite` **bound to it** via the invite's `StrandId` column (signed into the row-bound authorization). When an invitee redeems a bound invite, the recorder resolves that pre-existing host strand (`resolveStrand`) and writes exactly **one** `FormationUsage` consent row against it (record-only — no new `Strand` insert), returning the host strand id **and its `MemberPrivateKey`** (the closed-strand read-gating secret) back through the protocol for delivery to the validated invitee. A bound invite whose named host strand has **not yet converged** on this responder (`resolveStrand` → `missing`) is rejected cleanly — no usage row, no disclosure — instead of recording consent against a non-existent strand (which would fail the deferred `FormationUsage.StrandExists` CHECK at commit and drop the result frame). An unbound invite (`StrandId` null) takes the responder-provisions path: a DB-backed recorder mints a fresh open strand **and** records its one `FormationUsage` consent row **atomically** (`provisionAndRecord` → `ControlDatabase.redeemInvitation`), so the unbound redemption is single-use exactly like the bound path; only when no DB recorder is wired does it fall back to the `StrandProvisioner` (or a structural placeholder), which carry no single-use accounting. Every consent row carries the host strand's one-off `StrandStampId`, so it authorizes one specific **`Strand` row**, not a strand id forever; the schema additionally pins each path to its shape — a bound invite may record usage only against its own named strand, and a consent-seated strand must be open, keyless, from an unbound invite, and the first-ever seating of its id — see the control-layer item under [Strand Membership Bootstrap](#strand-membership-bootstrap).
- **`StrandSolicitationService.registerResponder(node)`**: Registers the libp2p node to handle incoming formation requests
- **`StrandSolicitationService.formStrand(invitation, disclosure, node)`**: Initiates strand formation over the real protocol
- **`CadreNode` high-level API**: `createOpenInvitation()`, `formStrand()`, `encodeInvitation()`, `decodeInvitation()`

Joiner consent is carried on the wire and stored, not merely implied by the initiator having dialed: `StrandSolicitationService.formStrand` mints the redemption's single-use nonce, generates the membership keypair, and signs a `'consent'` digest over (token, nonce, its own public key, the canonical disclosure text) with that keypair before the contact message goes out. The responder verifies it — and that the key matches the peer id the initiator claims — then writes the key and signature into `FormationUsage.PeerKey` / `PeerSig`. Storing the signature rather than consuming it transiently is what lets any later reader of the control database re-verify the row on its own (`verifyFormationConsent`), which is the property `strand-formation-e2e.integration.ts` Phase 4 asserts over a real two-party network.

Cadre-disclosure timing is enforced: the responder reveals its own party id + cadre addresses — and, for a bound (closed) strand, that strand's membership key — only after the token and disclosure validate; a rejection discloses none of them. The initiator's `FormationResponseValidator` (built-in structural default) rejects a responder that omits its disclosed identity/cadre or returns an empty/non-responder-created strand.

Formation timeouts are **nested so every layer can fail and report before the layer above it gives up**: outside approval hook (10s, `formation-approval.ts`) < responder provisioning (12s `provisionTimeoutMs`, of which the last 2s is a settle grace) < initiator await-response (15s) < whole session (30s). Provisioning is real work — a DB write plus, for a `ValidationUrl`-bearing invite, an outbound HTTP call — so it does **not** share the per-wire-step budget (`stepTimeoutMs`, 5s) used for a bare frame read/write; a responder whose provisioning overruns replies `approved: false, reason: 'Formation provisioning timed out'` rather than dropping the stream. Configured budgets that would leave no room under the session timeout are clamped to `sessionTimeoutMs - stepTimeoutMs`.

An overrunning provisioning is **aborted**, not merely abandoned: the work budget (`provisionTimeoutMs` minus the settle grace, which is carved **out** of the budget so the ladder above is untouched) expiring aborts the signal threaded through to the recorder, which checks it before issuing its `FormationUsage` insert and so **leaves the invite unspent** — the joiner can retry the same token. The grace covers the opposite case: work that had already written cannot be un-written (`FormationUsage` is append-only), so provisioning that settles inside the grace is **adopted** and reported as a real approval instead of a timeout over a spent invite. Because the default work budget (10s) now equals the approval hook's own 10s timeout, a dead hook races `'Formation approval unavailable, retry'` against `'Formation provisioning timed out'`; both are retryable and both leave the invite unspent, so the race is benign.

A redemption that loses the use-number race is not sent back for a fresh approval:
`ControlDatabase.withUseNumberRetry` re-presents the identical approver sign-off under a new use
number, so the approval hook above is asked **once per join, never once per write attempt**. Two
joins landing on the *same* node never reach that retry — the local write queue serializes them
and each reads a use number the other has already committed — so the retry exists for the writers
that queue does not reach: another node of the cadre, or another `Database` handle over the same
store. Only a retry that runs out — the invite has no seat left — reaches
`StrandFormationManager.provisionAsResponder`'s catch-all as `InvitationExhaustedError`, reported
to the joiner as the same `'Invalid token'` a spent invite would give.

```mermaid
sequenceDiagram
    participant A as Party A (Responder)
    participant B as Party B (Initiator)
    Note over A: Strand pre-created; FormationInvite<br/>bound to it (StrandId) created
    Note over B: Receives invitation out-of-band
    B->>A: formStrand(token, disclosure)
    Note over A: Validate token, validate identity,<br/>resolve bound strand, record FormationUsage
    A->>B: Response with strand info + membership key
    Note over A,B: Both add to Strand table →<br/>triggers node participation
```

### Strand Membership Bootstrap

Three independent consent/RBAC layers coexist; do not conflate them:

1. **Control / cadre layer** (`CadreControl.*` in the shared control DB): `Strand`, `FormationInvite`/`FormationUsage`, `OwnerKey`, `CadrePeer`. Governs which cadre operates a strand and cadre-operator consent to *form* it. The control-layer `Strand.MemberPrivateKey` is the closed-strand read-gating secret; the `MemberKeyClosedOnly` CHECK enforces that it is null on an open strand (`Type='o'`), so only a closed strand (`Type='c'`) may carry one. It is stored **unencrypted** and replicated to every node of the party by design — see [Closed-strand member keys — accepted residual risk](#closed-strand-member-keys--accepted-residual-risk).
   A `Strand` row may be seated two ways: owner-signed, or **by consent** — no signature *on the `Strand` insert itself*, authorized purely by the existence of a `FormationUsage` row. Unsigned does not mean unattested: that usage row carries the joining peer's own signature over the `'consent'` digest (`PeerSig`, verified against the row's `PeerKey` by `PeerConsented`), so the seating still traces to a key nobody but the joiner holds. The consent branch is deliberately narrow: the usage row must name the strand row's one-off `StampId` (`FormationUsage.StrandStampId`, matched on the `(id, stamp)` pair by both `Strand.AuthorizedInsert`'s consent branch and `FormationUsage.StrandExists`), the invite must be **unbound** (a bound invite is record-only, and only against its own named host strand — `FormationUsage.Authorized`), the seated strand must be **open and keyless**, and a strand id may be consent-seated **once, ever, and never after any removal of that id** — `FormationUsage` is append-only, so the first redemption's surviving record permanently forecloses a second unsigned seating of that id, and every removal files a `Revocation` tombstone naming the removed row's id (`RowKey`), which the consent branch refuses ever after, however the id was originally seated. A removal also retires the row's stamp into `Revocation`, closing that specific consent record's branch.
   Re-joining a removed strand id is therefore **owner-gated**, not invite-driven: the owner re-seats the id signed (fresh stamp, fresh signature) and issues a **bound** invite the returning party records consent against. A spare use of an old invitation can never re-form an id that consent already seated — and the legitimate unbound path never re-uses an id anyway (each redemption mints a fresh 128-random-byte id). Invite tokens live in plaintext in the replicated control database, so these CHECK constraints — not token secrecy — are the authorization boundary.
   Removal sticks for owner-only ids too: the once-ever rule keys off a *surviving* `FormationUsage` row, and an owner-signed seat writes none — so on its own it could not foreclose an id seated purely owner-signed and then removed. The tombstone's `RowKey` is that removal's trace: the consent branch refuses any id ever named by a `Strand` tombstone, whatever invite uses remain. Each guarded table's `RevocationRecorded` CHECK requires the tombstone accompanying a delete to name that exact row, so a removal cannot file a misnamed one; a *standalone* tombstone (no accompanying delete) is owner-attested only. The trade-offs and the convergence caveat are in the constraint comments in `schemas/control.qsql`.
   Party-wide removal is the owner-signed node operation `CadreNode.unpublishStrand` (→ `ControlDatabase.deleteStrand`): it removes **this party's** `Strand` row only — other parties in the strand keep their own rows and the strand network carries on — and every node of the party stops its instance once its watcher observes the missing row (the caller's own node converges immediately), except a node whose `strandFilter` never admitted the strand — it never observes the removal and keeps its instance running until stopped locally. It is distinct from `CadreNode.stopStrand`, the local-only stop that leaves the row intact to be rediscovered on the next restart or poll. Unpublishing a closed strand destroys the row's `MemberPrivateKey` with it — stored nowhere else, so the party's ability to admit members to that closed strand is irreversibly gone. Removal is control-plane only: each node closes its `StrandDatabase` but retains the strand's local durable storage, so a closed strand's content stays readable on disk to anyone holding the data directory — erasing the local copy would be a separate purge step. A removal committed while alone is subject to the delete-while-alone durability gap described under [Control Network Seed](#control-network-seed) ("Convergence prerequisites and current status"). The sibling-side stop — a removal issued on one machine actually stopping the instance on another — is proven end-to-end by `packages/integration-tests/src/scenarios/strand-unpublish-sibling-convergence.integration.ts` (also the first proof that a control-plane delete becomes visible to a sibling reader at all); the issuing node's own convergence and the filter-excluded caveat are unit-covered by `packages/cadre-core/test/strand-unpublish.spec.ts`.
2. **Strand RBAC layer** (`Strand.*` inside each strand DB, applied from `schemas/strand.qsql` by `composeStrand`): the authoritative per-strand membership/RBAC — `Header`, `Invite`/`ConsumedInvite`/`CancelledInvite`, `Member`, `MemberPeer`, `Manager`, `Revocation`.
3. **sApp layer** (`App.*`): application-data RBAC declared by the sApp schema, gated by its own `verify()`-bound CHECK constraints.

`composeStrand` only *applies* the layer-2 schema; the first runtime *writer* is the **founder bootstrap** (`strand-membership-writer.ts`). The **founder** — the party that provisioned and published the strand (the responder in formation, the creator in host/solo paths; the same party that calls `CadreNode.publishStrand`) — runs a one-time bootstrap at bring-up. A **joiner** writes nothing and receives these rows via Optimystic sync.

- **Plumbing**: an explicit `founder?: boolean` flows `CadreNode.addStrand(StrandConfig)` → `launchStrand` → `StrandInstanceManager.startStrand` → `buildStrandRuntime` → `StrandDatabase`. The bootstrap runs in `StrandDatabase.initialize()` *after* `connectToStrand` returns (schema is applied by then), gated on `founder === true`. The control-discovered join path never sets `founder`, so a discovering peer only syncs. A throw during bootstrap propagates out of `initialize()` so `buildStrandRuntime`'s rollback tears the half-built strand down.
- **Open strand (`Type='o'`)**: insert `Header` only — `Member`/`Manager`/`Invite` are `OnlyClosed`.
- **Closed strand (`Type='c'`)**: insert `Header(Type='c')`, then the founding `Member`, then the founding `Manager`, in that order (the deferred `OnlyClosed` checks on Member/Manager see the committed closed `Header`). The founding `Member.Key` and `Manager.MemberKey` are *derived from* the control-layer `MemberPrivateKey` via the **key bridge** (`strandMemberKeyPair`): the base64-protobuf libp2p ed25519 key is decoded and run through `ed25519KeyPairFromLibp2p`, yielding a base64url `{ privateKeyB64, publicKeyB64 }` whose `publicKeyB64` is the founding member/manager key. The first-row inserts use the schema's bootstrap branch, so they need **no** signature. That branch is narrow: `Member.Authorized` waives the signature only while `count(Member) <= 1`, and `Manager.Authorized` only on an **insert** (`old.MemberKey is null`) in the founding state — at most one `Manager`, at most one `Member`, and that `Member` row is this manager. Header→Member→Manager order is therefore load-bearing, not merely conventional: a Manager-first seeding path is rejected at commit.
- **Idempotency**: every write is insert-if-absent (guarded by a `select count(1) from Strand.<T>`), so a founder restart / re-`addStrand` / `resumeStrand` is a no-op and never double-inserts or trips `InsertOnly`.
- **Signing idiom (for the later signed flows)**: two idioms coexist in `schemas/strand.qsql`.
  - The **membership/RBAC tables** (`Member`, `MemberPeer`, `Manager`, `Revocation`) use the same **domain-tagged, multi-field, single-use** digest the control layer uses: every approval leads with a `('Strand.<Table>', '<action>')` pair, then the row's key fields, then the row's `StampId` — see [Single-use approvals: stamps + tombstones](#single-use-approvals-stamps--tombstones) below. `signStrandApproval(parts, privateKeyB64)` is the matching signer (the same variadic-digest framing as the control layer's `buildAuthorizationMessage`).
  - `Invite`/`ConsumedInvite` still verify a **single digest over a `'|'`-joined payload** (`verify(digest(payload), signature, pubkey, 'ed25519')`), signed by `signStrandPayload(payload, privateKeyB64)` and verified off-engine by `verifyStrandPayload`. Both tables are insert-only with a fresh primary key per row (`InviteKey`), so they need no stamp and no action tag: an invite approval has exactly one row it can ever seat.

  `Header.Engine`/`EngineVersion` are pinned constants (`STRAND_ENGINE` = `quereus`) — a real engine-selection seam is future work.

#### Single-use approvals: stamps + tombstones

Every `Member`, `MemberPeer`, and `Manager` row carries a `StampId` — 256 bits of CSPRNG output minted fresh per row incarnation (`generateStrandStampId`). Every signed approval over such a row covers the table name, the action, the row's key fields, **and** that stamp. Re-inserting a "same" row mints a new stamp, so a captured approval names a stamp that will never exist again.

Deletion retires the stamp permanently. `Strand.Revocation` (primary key `(TableName, StampId)`) is the tombstone table: every delete must file the matching tombstone **in the same transaction** (each guarded table's deferred `RevocationRecorded` check on delete), and every insert refuses a stamp already tombstoned (`NotRevoked`). `Revocation` itself is guarded by `Immutable` (no update, no delete — retirement is permanent), `RowIsGone` (a stamp may only be retired once its row is actually gone, which also confines `TableName` to the three guarded tables), and `Authorized` (the tombstone carries a `digest('Strand.Revocation', 'retire', TableName, StampId)` signature verified against a **committed** `Member` row).

The signed digest per rule, one variadic digest arg per element:

| Rule | Signed digest |
|---|---|
| Member add-by-manager | `'Strand.Member','add',new.Key,new.StampId` |
| Member remove-by-manager | `'Strand.Member','remove',old.Key,old.StampId` |
| Member self-departure | `'Strand.Member','leave',old.Key,old.StampId` |
| MemberPeer self register | `'Strand.MemberPeer','add',new.MemberKey,new.PeerId,new.StampId` |
| MemberPeer self remove | `'Strand.MemberPeer','remove',old.MemberKey,old.PeerId,old.StampId` |
| MemberPeer manager remove | `'Strand.MemberPeer','manager-remove',old.MemberKey,old.PeerId,old.StampId` |
| Manager promotion | `'Strand.Manager','add',new.MemberKey,new.Generation,new.StampId` |
| Manager self-resignation | `'Strand.Manager','resign',old.MemberKey,old.StampId` |
| Manager removal-by-another | `'Strand.Manager','remove',old.MemberKey,old.StampId` |
| Revocation tombstone | `'Strand.Revocation','retire',new.TableName,new.StampId` |
| Invite cancellation | `'Strand.CancelledInvite','cancel',new.InviteKey` |

`Strand.CancelledInvite` is the one row in that table with no `StampId` element: like `Invite`/`ConsumedInvite` it is insert-only and its primary key **is** the invite key, so a replayed insert collides on the primary key and the approval has exactly one row it can ever file.

`Generation` is signed as a **number**, not a string: the crypto plugin's digest framing is type-tagged, so integer `1` and text `'1'` produce different digests — pinned end-to-end (TS signer ⇔ SQL `digest` over the INTEGER column, plus both mismatch directions) by case (e) of `cadre-core/test/digest-variadic-parity.spec.ts`.

Every capture-and-replay this closes is pinned as rejected in `cadre-core/test/strand-approval-replay.spec.ts` — promotion, manager removal, resignation, admission, revocation, self-departure, and peer registration, each replayed against a re-seated row and each paired with the legitimate operation it was derived from. Coverage is single-node only: the convergence hazard noted on `Strand.Revocation` in the schema — a node that has not yet seen a tombstone still accepts the replayed add, and the resurrected row coexists with the tombstone after merge — has no test.

This closes `bug-strand-manager-authority-antireplay`: an approval is bound to one table, one action, and one row incarnation, and cannot be replayed once that incarnation is gone. Two consequences worth knowing: filing a tombstone is a *member* action — `Revocation.Authorized` verifies a delete's tombstone against a committed `Member` row — so revoking, clearing a peer binding, or resigning all require the acting manager to also be a member; `Manager.MemberExists` enforces exactly that on every insert, so no promotion a node accepts can seat a manager holding those powers unable to use them. ⚠️ **Still open:** `MemberExists` is a per-transaction check over locally visible rows, so a partitioned pair — one node promoting X, another removing X's `Member` row — can each pass locally and merge into a `Manager` row with no `Member` row behind it; same convergence class as the `MinOneManager` caveat below. And `Revocation` is append-only and never pruned, so it grows with membership churn.

#### Invite → join handshake (closed strands)

After the founder bootstrap, a non-founding party becomes a `Member` of a closed strand through the signed invite handshake, all in `strand-membership-writer.ts`:

- **`issueInvite(db, { managerKeyPair, expiration? })`** — a manager mints a fresh, single-use invite. A new ed25519 invite keypair is generated; its **public** key becomes `Invite.Key` (base64url, so the engine's `verify()` consumes it directly), and the payload `Key || '|' || coalesce(Expiration,'')` is signed **twice**: once with the manager key (→ `ManagerSignature`, proving a manager issued it — `Invite.InviteValid` requires a matching `Manager` row) and once with the invite private key (→ `InviteSignature`, proving the issuer actually holds the invite secret). The invite **private** seed is returned to be handed to the invitee out-of-band (in production via the formation/seed channel) and is never persisted in the strand. An optional `Expiration` (epoch-ms) is canonicalized through the shared `canonicalDatetime` helper (a `select datetime(?)` round-trip) so the signed segment byte-matches the `datetime`-coerced column the deferred CHECK sees — a hand-rolled ISO string would not verify.
- **`consumeInvite(db, { inviteKey, invitePrivateKey, memberKey, nowMs? })`** — the invitee redeems the invite to seat its `Member` row. `Member.Authorized`'s invite branch needs a `ConsumedInvite` row, while `ConsumedInvite`'s `MemberExists` needs the `Member` row — a circular dependency resolved by inserting **both in one explicit transaction** (`beginTransaction`/`commit`) so the deferred (subquery-bearing) checks see both rows at commit. This mirrors `ControlDatabase.redeemInvitation` (Strand + FormationUsage in one txn). The `ConsumedInvite` insert carries an `InviteSignature` over `InviteKey || '|' || MemberKey`, proving possession of the invite private key; the `Member` insert needs no member signature (its admission **is** the matching `ConsumedInvite`). **Expiry is enforced** by the deferred `ConsumedInvite.NotExpired` check (`I.Expiration is null or I.Expiration > context.Now`): the writer supplies `context.Now` as a `canonicalDatetime`-canonicalised string (the same transform `issueInvite` uses for `Expiration`, so both sides of the lexical `>` are byte-identical canonical datetimes — intentionally **not** the ISO `Now` the control layer passes), pinned via the optional `nowMs` in tests. A null `Expiration` never expires; an at-or-past expiry rolls the whole transaction back, leaving neither row.
- **`cancelInvite(db, { managerKeyPair, inviteKey })`** — a manager kills an outstanding invitation permanently. Files one `Strand.CancelledInvite` row carrying a manager signature over `digest('Strand.CancelledInvite', 'cancel', new.InviteKey)`; the digest binds the exact invite key, so an approval minted for one invitation cannot cancel another. `CancelledInvite.Authorized` reads `committed.Manager` (the same reason `Member`/`MemberPeer`/`Revocation` do — the check defers to commit), so a manager seated in the *same* transaction cannot cancel. One row, one statement — no explicit transaction. **Insert-if-absent**: a repeat cancellation logs and returns rather than throwing on the primary key. Cancellation is what makes removal a re-entry gate: `ConsumedInvite.NotCancelled` blocks the consumption insert, and `Member.Authorized`'s invite branch needs a same-transaction fresh `ConsumedInvite` row, so a cancelled invitation rolls the whole join back. Un-cancelling is impossible (`CancelledInvite.Immutable`) — re-inviting a party means a fresh `issueInvite`. Removal does **not** cascade into cancellation: an invitation names no invitee, so nothing matches a departing member against it (tracked as `feat-strand-invitee-bound-invites`).
- **`listOutstandingInvites(db, nowMs?)` → `OutstandingInvite[]`** — the enumeration side of `cancelInvite`: the invitations still redeemable, as `{ inviteKey, expiration }`. `Invite` is insert-only and carries no state column, so "outstanding" is not a property of the row — it is the `Invite` set minus the `ConsumedInvite` keys, minus the `CancelledInvite` keys, minus anything already expired at `nowMs` (default `Date.now()`; tests pin it). All three exclusions mirror gates a consume would hit anyway (`ConsumedInvite`'s primary key, `NotCancelled`, `NotExpired`), and expiry uses the same strict `>` against a `canonicalDatetime`-canonicalised now, so expiry is exclusive exactly as on-engine. Reads via **unfiltered scans** with the key comparison in JavaScript, for the same reason `registerMemberPeer`'s guard does: `ConsumedInvite`/`CancelledInvite` have the single column `InviteKey` as their primary key, so any where-equality on it is a full-primary-key predicate the optimystic module serves as a point lookup that can miss on a networked strand.
- **`addMemberByManager(db, { managerKeyPair, memberKey })`** — the sibling direct-admit branch of `Member.Authorized`: a manager signs `digest('Strand.Member', 'add', new.Key, new.StampId)` and seats a member with no invite involved (for a party already trusted out-of-band).

Once the founder exists, every admit runs past the schema's `count(Member) <= 1` bootstrap branch, so these paths genuinely exercise signature verification rather than the count shortcut.

**Single-use layering.** The per-strand member join is single-use via `ConsumedInvite`'s primary key (`InviteKey`) — a distinct layer from the control network's `FormationUsage` single-use, which gates strand *formation* (cadre-operator consent), not member join. The optimystic vtab transactor enforces primary-key uniqueness on `INSERT` (a duplicate-PK insert is rejected with `UNIQUE constraint failed: ConsumedInvite.InviteKey`, not silently overwritten), so a replayed invite is rejected: the second consume rolls back whole, leaving the first consumer's `ConsumedInvite` row and admitting no second `Member`. Pinned by `cadre-core/test/strand-membership-invite.spec.ts` → *a double consume of the same invite is rejected*.

#### EnrollmentService strand-DB backing

`EnrollmentService` (`enrollment.ts`) exposes the Member Registration API (`registerMember`, `validateMemberRegistration`) over pluggable `MemberVerifier` + `MemberRegistry` seams. `strand-member-registry.ts` provides the concrete strand-`Database`-backed implementations that turn those seams into real `Strand.*` writes:

- **`StrandMemberVerifier`** — `verifyMember` checks the joiner's self-proof over `memberRegistrationPayload` (`strandId || '|' || memberKey`, binding the proof to the strand) via `verifyStrandPayload`; `isAuthorizedToJoin` returns true when a `ConsumedInvite` already bears the member key or `listOutstandingInvites` reports at least one still-redeemable `Invite` — i.e. one that is neither already consumed, nor cancelled by a manager, nor expired. All three exclusions mirror gates the actual write would hit (`ConsumedInvite`'s primary key, `NotCancelled`, `NotExpired`), so the pre-flight never reports a door the constraints will slam; a raw `Invite` count would over-report on all three. It remains only a "door is open" pre-flight — the binding/single-use/cryptographic/expiry gates are all enforced by the deferred `Strand.*` constraints at write time. The `ConsumedInvite` short-circuit is deliberately *not* revocation-aware (a revoked member still bears its stale consumption row, so this returns true for a party that can no longer actually join) — harmless for the same reason: the on-engine constraints are the real gate, and the invite branch requires a *fresh* consumption row.
- **`StrandMemberRegistry`** — admits the member through the writer primitives, selected by a `StrandAdmission`: `{ mode: 'invite', inviteKey, invitePrivateKey }` → `consumeInvite` (the invitee-side flow), or `{ mode: 'manager', managerKeyPair }` → `addMemberByManager` (the manager-side flow). `isMemberRegistered` is a `select count(1) from Strand.Member where Key=?`. Supplied `peerIds` are **not** yet written as `MemberPeer` rows — that signed peer path is the next ticket; a non-empty `peerIds` is logged and the member is still seated.

This makes `EnrollmentService.registerMember` perform the actual per-strand join handshake against the strand's tables rather than returning "MemberRegistry not configured". Each registry/verifier instance is scoped to one strand's connected `Database`.

#### MemberPeer registration + manager rotation

The remaining two founder-reachable writers in `strand-membership-writer.ts` let a member bind its own nodes and let admins rotate the RBAC set:

- **`registerMemberPeer(db, { memberKeyPair, peerId })`** — a member records which network node (`PeerId`) acts on its behalf. The member **self-signs** `digest('Strand.MemberPeer', 'add', new.MemberKey, new.PeerId, new.StampId)` with its own key; `MemberPeer.Authorized` verifies that signature against `coalesce(new.MemberKey, old.MemberKey)` — i.e. the member key itself — so a peer can only be registered by the very member it belongs to (no manager is involved). A deferred `MemberExists` additionally requires the `Member` row to already exist, so a peer for a non-member is rejected at commit. The write is **insert-if-absent** so a re-register on restart is a no-op (a restart-safe re-register should succeed quietly rather than throw the platform's duplicate-PK rejection); a member may register multiple **distinct** `PeerId`s (multi-device), each its own row. The existence guard deliberately does **not** seek the composite PK `(MemberKey, PeerId)`: an equality on both key columns is reported as fully handled by the optimystic module and served as a point lookup, which is not reliably served on a networked strand (a miss re-inserts a duplicate). It instead filters on the **leading** key column only — a partial PK match the module declines to handle, so the SQL engine applies it over a scan — and re-compares both columns in JavaScript, leaving correctness dependent only on the scan returning a superset of matching rows.
- **`removeMemberPeer(db, params)`** — clear a peer binding, either by the owning member itself (`remove`-tagged, verified against the row's own member key) or by a manager cleaning up after a revocation (`manager-remove`-tagged, verified against a `committed.Manager` row). `MemberPeer` rows do **not** cascade when their member is revoked, so a removed member's bindings survive as orphans; `listMemberPeers` enumerates them and this writer clears them. The manager branch is deliberately not gated on the member already being gone. Cleanup is an explicit follow-up call by the revoking manager, never a cascade inside `revokeMember`.
- **`revokeMember(db, { managerKeyPair, memberKey })` / `leaveStrand(db, { memberKeyPair })`** — remove a `Member` row, by a manager (`remove` tag, verified against `committed.Manager`) or by the member itself (`leave` tag, self-signed). Both file the row's tombstone in the same transaction. `MinOneMember` refuses a delete that would empty the member set; `NotAManager` refuses removing a member that still holds a `Manager` row (resign first, or do both in one transaction).
- **`addManager(db, { byManagerKeyPair, newManagerKey })`** — an existing manager promotes a member to `Manager`. Every `Manager` row carries a `Generation` (the founder is seated at 0), and the promotion branch of `Manager.Authorized` accepts only an authorizer of **strictly smaller** generation, verifying `digest('Strand.Manager', 'add', new.MemberKey, new.Generation, new.StampId)` against a `Manager` row matching `context.ManagerKey`. The writer reads the authorizer's own generation, seats the new manager at that value + 1 (the schema enforces only the strict ordering, not adjacency), and signs the generation as a **number** — the generation is inside the signed digest, so a captured promotion is pinned to the generation it was issued for. When the authorizer has no `Manager` row at all, the writer falls back to generation 1 and issues the insert anyway, deliberately letting the **schema** be the rejector. The strict ordering is what closes same-transaction takeover: the deferred check runs against the **post-insert** row set, so sibling rows inserted in the same transaction are visible as "existing" managers — but the minimum-generation row of any inserted set cannot find an authorizer among its siblings, so that authorizer must pre-date the transaction. This subsumes the self-promotion exclusion (`A.MemberKey <> new.MemberKey`, kept for local clarity) and kills mutual pairs and rings of any length. Generation is lineage, **not** privilege — all managers have identical powers. `Manager.MemberExists` (checked on every insert) requires the promoted key to already hold a `Member` row; see the sibling `admitManager` below for admitting a not-yet-member key and promoting it in one atomic step.
- **`admitManager(db, { byManagerKeyPair, newManagerKey })`** — admits `newManagerKey` as a `Member` AND promotes it to `Manager`, atomically, for a key that is not in the strand yet (`addManager` alone only promotes an existing member). Both writes run in ONE transaction because `Manager.MemberExists` is deferred and reads the LIVE `Member` table, so the sibling `Member` insert satisfies it at the shared commit; a rejection of either half rolls both rows back. No new authority is granted — both halves are signed by the same manager, over the two distinct action-tagged digests `addMemberByManager` and `addManager` already use separately. The promoting manager must itself pre-date the transaction (the direct-admit branch of `Member.Authorized` reads `committed.Manager`), so a manager seated by an `admitManager` call cannot chain into admitting the next one in the same transaction.
- **`removeManager(db, { byManagerKeyPair, targetManagerKey })`** — delete a `Manager` row, either an **admin** removing a different manager (the removal branch) or a manager **resigning itself** (former-manager self branch). The two branches sign **distinct** digests — `'Strand.Manager','resign',old.MemberKey,old.StampId` for the self branch, `'Strand.Manager','remove',old.MemberKey,old.StampId` for the removal branch — so a resignation approval cannot be redirected into a removal or vice versa; the caller selects the case purely by which keypair it passes (a different manager vs. the target's own). Either way the row's stamp is retired into `Revocation` in the same transaction. The removal branch deliberately carries no generation condition: deletes are safe once inserts are, and a generation gate would wrongly block a later-generation manager removing an earlier-generation one.

**Manager-removal hazards.** The optimystic bootstrap-mode transactor now evaluates deferred (subquery-bearing) `CHECK` constraints on `DELETE` as well as `INSERT` (`optimystic-deferred-check-not-enforced-on-delete`, backlog, landed), so `Manager.Authorized` — deferred — is enforced on delete: a signer that is neither an existing manager nor the target itself is rejected, pinned by a passing (no longer KNOWN GAP) test in `strand-membership-peer-rotation.spec.ts`. The old bootstrap-bypass hazard is **closed**: `Manager.Authorized`'s bootstrap branch is now gated to inserts (`old.MemberKey is null`) at `Generation = 0`, so a delete that drops the count toward 1 is authorized like any other, and a new deferred `Manager.MinOneManager` (`check on delete`, `count(Manager) >= 1`) rejects any delete that would leave the strand with zero managers. The same-transaction **mutual-promotion takeover is also closed** by the `Generation` ordering (see `addManager` above): two keys that sign each other's promotion — or any longer vouching ring — cannot all sit strictly above their authorizers, so at least one row fails and the whole transaction (including any founder-evicting deletes riding in it) rolls back; pinned by the `Manager.Generation ordering` suite in `strand-membership-peer-rotation.spec.ts`. `Manager` also carries `NoUpdate` — rows are insert+delete only, so a resignation signature (which proves only that `old.MemberKey` consented) can never be reused to re-point the row at an attacker-chosen key. A sole manager hands off **add-then-resign**; a same-transaction delete-and-replace is rejected. ⚠️ **Still open:** `MinOneManager` counts only rows visible to one transaction, so concurrent removals on partitioned nodes can still converge to zero. Invariants and remaining gaps are stated in plain terms in [`docs/strands.md` → Who May Administer a Closed Strand](strands.md#who-may-administer-a-closed-strand).

#### End-to-end coverage

Beyond the per-writer component specs (`cadre-core/test/strand-*`), the closed-strand membership lifecycle is exercised end-to-end across **two real `CadreNode`s** over libp2p in `integration-tests/.../strand-membership-closed-strand-e2e.integration.ts`. Both nodes attach the same directly-constructed closed `StrandRow` (`Type='c'`, `MemberPrivateKey` minted via `generateStrandMemberKey`) in `networked` mode with a manual strand-level dial; the founder (`founder:true`) bootstraps `Header`/`Member`/`Manager` while the joiner (`founder:false`) writes nothing on bring-up. The scenario then drives — and asserts accept **and** reject for — invite issue/consume, `registerMemberPeer`, `addManager`, and a final `App.Items` signed write by the newly-admitted member (tying the layer-2 `Strand.Member` admission to layer-3 sApp RBAC: the same key that joined the strand signs the sApp write). The writer-driven accept/reject cases in this first test run against the **founder's** strand DB (the authoritative DB where bootstrap seated the constraint-backing rows), which is what buys their accept/reject *breadth* cheaply. Cross-node visibility of the founder's `Strand.*` bootstrap rows on the joiner is **gated** (a throwing `waitUntil`, 15 s budget against sub-second measured convergence) in the shared `bringUpClosedStrand` helper — the earlier best-effort probe is gone, and a timeout there is now a convergence defect rather than a logged skip. Two networked-transactor quirks surfaced. A full **composite-PK point lookup** (`MemberPeer where MemberKey = ? and PeerId = ?`) is not reliably served: the scenario reads the singleton row directly rather than seeking it, and `registerMemberPeer`'s existence guard no longer issues such a lookup at all (see above), so the scenario now also asserts that a **re-register of the same `(MemberKey, PeerId)` is a quiet no-op on a networked strand** — the case that used to duplicate. That assertion now **executes green**: the bring-up failure it used to hit (the blocked `control-db-convergence-optimystic-p2p` issue) has cleared. The second quirk: rejected writes assert only `throws` (no post-state rollback), per the deferred-constraint-rollback gap — so any count assertion must precede the first rejected write in the scenario.

**Device-record removal, networked.** A second test in the same file gives `MemberPeer` *removal* the same two-node treatment, each test bringing up its own strand via the shared `bringUpClosedStrand(label)` helper. It admits a plain member through the real invite flow, has it register two devices (one of them the joiner node's actual strand peer id), then walks: `listMemberPeers` as a networked enumeration → **self removal** of one device (sibling survives; the matching `Strand.Revocation` tombstone is asserted present) → **revocation of the member**, after which its remaining device record survives as an orphan → the **manager cleanup loop** (`listMemberPeers` then one `removeMemberPeer` per id) that clears it → a **restart-safe re-clear** of the already-cleared binding, which must resolve quietly. Self removal deliberately precedes the revocation: `Revocation.Authorized` verifies the tombstone filer against `committed.Member`, so a revoked member can no longer file one. Cross-node assertions here are now **gated outright** — the joiner is required to see the two rows appear, and then required to see each removal propagate; the old observe-then-require skip path is gone. The final step is a rejected bare `Strand.Revocation` insert naming a **live** row's stamp, pinned to `/RowIsGone/`: that constraint is the mechanism that turns a zero-row delete into a loud commit failure rather than a silent success, and it stands in for the point-lookup miss itself, which is nondeterministic and has no fault-injection seam. The JavaScript "still present after delete" re-check inside `removeMemberPeer` sits *behind* `RowIsGone` and therefore remains unexecuted; concurrent removal/registration races are also untested (see the `NOTE:` in `strand-membership-writer.ts`).

**The join, authored on the second node.** A third test in the same file inverts the first two: rather than buying accept/reject breadth against the founder's DB, it proves the second node is a genuine participant. The founder issues an invite (the invite secret is handed to the joiner side directly, modelling out-of-band delivery to the invitee); once that `Strand.Invite` row is gated visible on the joiner, the **joiner** runs `consumeInvite` against its **own** database — so `ConsumedInvite.InviteExists`/`ValidUsage`/`NotExpired`, which all read the founder-authored `Strand.Invite` row, resolve from the second node over the network. The join's remaining deferred checks are local or negative by construction and are *not* proven networked here: `Member.Authorized`'s invite branch wants a same-transaction `ConsumedInvite` plus that InviteKey's absence from `committed.ConsumedInvite`, `NotCancelled` scans an empty `CancelledInvite`, and `MemberPeer.MemberExists` reads the `Member` row the joiner itself just authored. The resulting `Member` + `ConsumedInvite` are asserted locally (the writer's transaction committed, so no wait) and then **gated as visible from the founder** — the headline assertion: a membership write authored on the joiner reaches the founder. It continues with `registerMemberPeer` on the joiner binding its own real strand peer id, and a signed `App.Items` insert by the newly-admitted key, each likewise gated to converge back. The single rejected write comes last (a wrong-invite-key `consumeInvite` on the joiner), keeping the file's rejection floor. Note what "converge" means throughout this file: a read on either node resolves one coordinator peer per block, so when that resolves to the *authoring* node the other node's `select` is a remote call against the author's storage and nothing needs to live locally. These tests assert **visibility**, which is the property an application observes; **physical** replication is proven separately by a fourth test in the same file, which writes only on the founder and then reads the joiner's raw block store directly (never its database, so the probe cannot itself pull a block in) — see [`docs/cadre-consistency.md`](cadre-consistency.md) for what that measures and for the backfill gap it exposes (`backlog/debt-strand-no-backfill-of-pre-membership-blocks`). Genuinely *concurrent* membership writes from two nodes remain untested — the sequence here is strictly ordered (founder issues → joiner consumes).

**Manager actions, authored on the second node.** A fifth test extends the third from *joining* on the second node to *administering* from it. The founder promotes a joiner-seated member M to manager; from there `issueInvite`, `addMemberByManager`, `addManager`, `revokeMember` and the manager arm of `removeMemberPeer` all run against the **joiner's** database, each resolving M's founder-authored `Manager` row over the network. That covers both flavours of manager-list read the schema uses, which are different reads of the same row and are asserted to agree: the **live** `Manager` table (`Invite.InviteValid`, `Manager.Authorized`'s promotion branch) and the **pre-transaction snapshot** `committed.Manager` (`Member.Authorized`'s direct-admit and manager-remove branches, `MemberPeer.Authorized`'s manager branch). Generations are asserted along the appointment chain (founder 0 → M 1 → M's promotee 2), pinning the strict-ordering rule end-to-end across two nodes. The rejected writes come last, per the file's rejection floor, and include a seated **member** — not merely a stranger — being refused an invite issuance, which is the case that distinguishes the `Manager` lookup from a membership check. Not covered by any test: `removeManager`, `cancelInvite`, `admitManager` and `leaveStrand` still run founder-side only.

### Strand Hibernation

A party may participate in many strands (potentially hundreds), but most are inactive at any given time. Maintaining live libp2p connections for all strands wastes resources. The hibernation system manages strand instance lifecycle based on activity:

**Strand States:**

| State | Description | Strand-network resources |
|-------|-------------|--------------------------|
| `active` | Actively transacting, recent activity | Full libp2p node + `StrandDatabase` running |
| `idle` | No recent activity (lightweight status flag) | Still fully running — node + DB retained. Connection trimming while idle is a planned refinement, not yet implemented |
| `hibernating` | Long-term inactive | **Released** — libp2p node stopped, `StrandDatabase` closed, zero strand-network connections/transports/DB handles. Instance identity + metadata retained for rehydration |

**Activity-Based Transitions:**

```mermaid
stateDiagram-v2
    active --> idle : idle timeout (configurable)
    idle --> active : incoming activity
    idle --> hibernating : extended idle + backoff
    hibernating --> active : wake signal (rebuild node + DB)
```

**Idle vs. Hibernating Behavior:**
- `idle` is currently a lightweight status flag: the strand keeps its libp2p node and `StrandDatabase` fully running. Trimming connections while idle ("minimal connections") is a planned refinement, not yet implemented.
- `hibernating` releases the strand's resources: `CadreNode.handleStrandHibernate` quiesces the strand via `StrandInstanceManager.quiesceStrand` (stops the libp2p node, closes the `StrandDatabase`), so it holds no open strand-network connections, transports, or DB handles. The instance record — strand id, sApp info, member key, latency hint — is retained so the strand can be rehydrated.
- Waking a hibernating strand rebuilds it: `handleStrandWake` re-resolves the cohort discovery seed and mode (a strand may have grown `bootstrap → networked` since launch) and calls `StrandInstanceManager.resumeStrand`, which reconstructs the libp2p node + `StrandDatabase`. The rebuild reuses the **retained launch config**, so the woken strand comes back under the *same* peerId it had before hibernating — relay reservations and peer-store entries recorded under that peerId stay valid. Only a full `stopStrand` drops the retained config; a later launch under the same strand id then derives its identity afresh (pinned by `test/strand-instance-manager-hibernation.spec.ts` → `resume transport identity`).

**Wake Mechanisms:**
1. **Local wake** (implemented): application activity (`recordStrandActivity`) on a hibernating strand, or an explicit `wakeStrand()` call, rehydrates it. Overlapping wake triggers are coalesced by `HibernationManager` so only one runtime is rebuilt.
2. **Check-in wake** (implemented): while hibernating, a self-rescheduling check-in timer fires on an **exponential backoff** — the base `checkInInterval` multiplied by `checkInBackoffFactor` after each idle check-in, capped at the per-hint `checkInMaxInterval` (the concrete "minutes → hours → days" ceiling). Each tick invokes `CadreNode.handleStrandCheckIn`, which **resumes** the strand, holds it live for a bounded window (`checkInWindowMs`) so its strand network can reach cohort peers and the app can drive reads, then **re-hibernates** if nothing surfaced (escalating the next delay) or stays `active` if activity landed (backoff resets on the next hibernation). The manager awaits each check-in before scheduling the next, so a slow check-in never overlaps. Because Optimystic syncs **pull-on-read** and exposes no cheap repo-level "pull pending" hook (`IRepo` is get/pend/commit/cancel only), the check-in realizes "query the cohort for pending activity" as this resume-as-reachability cycle — using machinery that exists and never reporting a false "synced" — rather than a bespoke strand head/version probe. A lighter same-cadre control-network pre-check that avoids a full resume is a future optimization (see backlog).
3. **Push wake** (implemented): another cadre peer — e.g. an always-on server that participates in a strand and sees new activity — signals a hibernating peer over the **control network** (the only network a hibernating peer keeps connected) to bring a strand online. The transport is a native libp2p request/response protocol on the control node, `WAKE_PROTOCOL = /sereus/strand-wake/1.0.0` (`strand-wake-protocol.ts`), modeled on the seed protocol: 4-byte length-prefixed JSON frames, one request → one ack per stream. The request is `WakeRequest { strandId, reason? }` and the reply `WakeAck { accepted, status?, reason? }`. The receiver (`StrandWakeService`, registered by `CadreNode.start`) gates every request on **authorized** membership (`CadreNode.isAuthorizedMember(remotePeerId)`): the sender's `CadrePeer` row must carry a voucher (`VouchOwner`/`VouchSig`) that verifies against an owner key in the receiver's node-local trusted-owner anchor — a replicated address row alone is NOT membership, so an outsider that self-genesises an owner key and publishes its own rows still cannot wake a sleeping node. No further signature is carried on the wake itself: the voucher-anchored membership is the authorization, and a wake is low-risk (it only causes the receiver to come online for a strand it already participates in). On a valid wake the receiver routes through the same wake path as a local wake (`wakeStrand → resumeStrand`), so resume coalescing prevents a push-wake racing a concurrent check-in. Membership is not unconditional trust, so the receiver also bounds a misbehaving own-cadre node the same way seed delivery does: each inbound read runs under `readTimeoutMs` (default 10s, abort-on-timeout) and concurrent inbound streams are capped by `maxConcurrent` (default 100, over which a non-accepting ack is returned without invoking the wake path) — see the seed protocol's *receiver hardening* note; both share `control-stream.ts`. The sender API is `CadreNode.pushWake(targetPeerId, strandId, reason?)`, which resolves the target's signed control-network address from its `CadrePeer` record (`resolvePeerAddrs`, signaling/relay first so NAT'd peers are reachable via their circuit-relay address) and dials the protocol. **Who** triggers push-wake automatically (a server fanning wakes to hibernating peers on activity) and the **direct-dial-then-platform-push** fallback are owned by the server fan-out (`push-fanout.ts`, implemented — see mechanism 5). The **mobile FCM/APNs receive** half (a suspended phone cannot keep the control network up, so its wake arrives over the platform push channel) has shipped — see mechanism 5.
4. **Imperative lifecycle** (implemented, platform-agnostic): for a mobile `BackgroundRunner` that drives lifecycle from OS app-state and push events rather than the internal timers, `CadreNode` exposes imperative entry points onto the same state machine. `hibernateStrand(strandId)` / `hibernateAll()` force-hibernate now — bypassing `idleTimeout + hibernateTimeout` on background entry — by cancelling the strand's pending idle/hibernate **and** check-in timers (so no stray timer resurrects a strand the runner means to keep down) and running the standard `onHibernate` path; realtime strands are skipped. `serviceWake(strandId, opts?)` runs the check-in cycle (wake → bounded `checkInWindowMs` window → re-hibernate-if-idle) on demand for a push-delivered wake, coalescing per-strand and sharing one runtime build with a racing push-wake via `HibernationManager` wake coalescing, and returning a branchable `ServiceWakeResult` rather than throwing. `running` / `controlConnected` getters give headless callers a synchronous readiness snapshot (the pollable form of the `control:connected`/`control:disconnected` events). The RN runner that consumes these — an `AppState`-driven `BackgroundRunner` (`packages/reference-app-rn/src/background-runner.ts`) that force-hibernates on background entry, drops to a hibernating state on the real `control:disconnected` edge, and runs an epoch-guarded, bounded resume (surfacing `resuming`/`degraded` to the UI) on foreground return — has shipped.
5. **Mobile push-wake receive + server fan-out** (implemented): a suspended app keeps no network up, so a wake for a hibernating phone arrives over the platform push channel (FCM on Android, APNs on iOS) rather than the control network. The server's fan-out (*who* to wake and *when* — `PushFanoutService`, `push-fanout.ts`) decides the wake and resolves the target phone's token via `DeviceToken` (`resolveDeviceToken`) and hands a **data-only** message `{ type:'strand-wake', strandId, reason }` to the platform-push **sender** (implemented): a `PushNotifier` (interface in `packages/cadre-core/src/push-notifier.ts`, built by the credential- and transport-injected `createPushNotifier` router in `push-node.ts`) that delivers over **FCM HTTP v1** (`push-notifier-fcm.ts`: cached OAuth2 access token from an RS256 service-account JWT, `POST …/v1/projects/{projectId}/messages:send`, high-priority `data` message) or **APNs HTTP/2** (`push-notifier-apns.ts`: cached ES256 provider JWT, `POST /3/device/{token}`, `apns-push-type: background`, `apns-priority: 5`, `content-available`), returning failures as values and mapping a permanently-invalid token (FCM 404 `UNREGISTERED`/400-on-token, APNs 410 `Unregistered`/400 `BadDeviceToken`) to `unregistered: true` so the fan-out can expire the stale row. Credentials are **provisioned per spawned node end-to-end**: `cadre-host` resolves FCM/APNs secrets from its secret store (re-read on every node respawn — no raw key persisted) and `cadre-provider` resolves them per tenant from config, each writing the raw-`PushCredentials` `push` block into that node's config (host → `cadre.json`; provider → the `CADRE_PUSH` env var); `cadre-cli` — the Node host — reads those credentials and constructs the `PushNotifier` from `@serfab/cadre-core/push-node`, injecting the instance into `CadreNodeConfig.push.notifier` so `CadreNode.start` builds the fan-out. Push is opt-in (no creds ⇒ no block ⇒ no fan-out), private keys are never logged, and per-tenant credentials are isolated (one tenant's creds never reach another tenant's node); **on-device validation** (real token, correct bundle id, sandbox-vs-production match) and the Firebase/Apple credential creation itself remain human/infra prerequisites. The FCM/APNs modules are Node-only (`node:crypto`/`node:http2`) and stay out of the RN/browser bundle because they (and the `createPushNotifier` router) live behind the `@serfab/cadre-core/push-node` subpath, and the cross-platform `cadre-core` entry re-exports only the `PushNotifier` *interface* — a Node host builds a notifier from that subpath and injects the instance into `config.push.notifier`. The shared payload contract now lives in cadre-core (`strand-wake-payload.ts`: `STRAND_WAKE_TYPE` + `StrandWakePayload`), imported by both the sender and the RN receiver. On the phone, an `expo-notifications` background notification task (registered via `expo-task-manager` in `index.js`, native wiring in `push-wake-native.ts`) parses the payload and — while backgrounded — ensures the node is up, awaits a bounded control connection, then drives one `serviceWake(strandId, { windowMs })` cycle and lets the strand re-hibernate. A push that arrives while foregrounded routes instead to a plain `wakeStrand` + `recordStrandActivity` (the user is viewing the strand; the AppState `BackgroundRunner` owns lifecycle). Token lifecycle: on node start the phone calls `getDevicePushTokenAsync`, maps `ios→apns`/`android→fcm`, and publishes via `registerDeviceToken` (re-published on rotation via `addPushTokenListener`, cleared via `clearDeviceToken` on logout). iOS silent push is **best-effort** — APNs coalesces/drops background pushes under low-power — and Android Doze defers data messages without a battery-optimization opt-out, so the check-in wake (mechanism 2) remains the backstop; the library choice (Expo first-party modules over bare-RN headless JS / `notifee`), App Store review notes, FGS-vs-data-message tradeoff, and the human prerequisites (`google-services.json`, paid APNs creds, on-device validation) are documented in the ticket review handoff.

   **Fan-out trigger + policy** (`PushFanoutService`, `push-fanout.ts`): `CadreNode.start` constructs the service only when `config.push` is present (the `PushNotifier` is **injected** — the Node host builds it from the `@serfab/cadre-core/push-node` subpath and passes the instance in `config.push.notifier`, so the Node-only `node:http2`/`node:crypto` modules never enter a cross-platform node's graph); without `config.push` the node behaves exactly as before. The **v1 trigger is explicit**: `CadreNode.notifyStrandActivity(strandId, reason?)` is the imperative seam an always-on host/relay/sApp calls when it observes activity, and `recordStrandActivity` additionally drives it — so whatever already pulls-on-read on the server's strand also fans out, no new contract. (A *passive* Optimystic-level detector — fan-out with zero application involvement — is **deferred**: `IRepo` exposes no commit/block-received hook, the same constraint behind the blind check-in resume; it is an enhancement over the explicit trigger, not a correctness gap.) On `notify(strandId)` the service: gates on participation (`getStrand` undefined ⇒ no-op), debounces per strand (`debounceMs`, default 10 s) and coalesces concurrent triggers into one in-flight pass, enumerates `listMembers()` excluding self, skips any peer within the per-`(peer,strand)` cooldown (`cooldownMs`, default 5 min — the anti-spam guarantee), then **wakes each survivor direct-first**: `pushWake` (a *resolved* `WakeAck` — even `accepted:false` — means the control path reached the peer, so **no** platform push, avoiding a double-wake) and, only on a dial/transport **rejection** (the phone is suspended), falls back to `resolveDeviceToken` → `notifier.send`. An `unregistered` send marks the token dead (skipping its next resolve→send) and calls `CadreNode.expireDeviceToken(peerId)` — an owner node deletes the `DeviceToken` row, a non-owner node logs that a re-registration is needed. The cooldown/debounce/dead-token state is **in-memory and acceptably lossy** (a restart at worst re-sends one duplicate, and `serviceWake` is idempotent); **cross-strand coalescing** into a single push is **not** done in v1 (each strand-wake names its own `strandId`); both are documented limits. The whole path is best-effort and never throws to the trigger — the check-in wake (mechanism 2) is the backstop for any dropped push.

**sApp Latency Hints:**

Applications can provide latency hints in the strand header that influence hibernation behavior:

The check-in column shows the **base** interval (first check-in after hibernating) and the **cap** the exponential backoff escalates toward:

| Hint | Idle Timeout | Check-in (base → cap) | Use Case |
|------|--------------|-----------------------|----------|
| `realtime` | Never hibernate | N/A | Messaging, live collaboration |
| `interactive` | 5 minutes | 30 seconds → ~1 hour | Active apps, transactions |
| `background` | 1 minute | 5 minutes → ~6 hours | Social feeds, notifications |
| `archive` | 10 seconds | 1 hour → ~3 days | Rarely accessed data |

## Network Isolation

Each strand operates as a completely isolated libp2p network. This isolation is achieved through:

1. **Network name scoping**: Each strand uses `networkName = strand-${strandId}` which results in protocol prefix `/optimystic/strand-${strandId}` for libp2p services (identify, cluster, repo, sync) within `@optimystic/db-p2p`
2. **Separate libp2p node**: Each strand instance runs its own libp2p node with independent connection management and its **own transport peerId**, deterministically derived from the cadre identity key + strandId (`strand-transport-key.ts`). Cadre authority remains the control node's identity key; the per-strand peerId is transport-only, and is what allows control and strand nodes to hold reservations on one shared circuit relay (which keys clients by peerId) without stealing each other's relayed streams
3. **Independent DHT**: Each strand's FRET overlay is scoped to its `networkName`
4. **Separate storage namespace**: Each strand's Optimystic data is partitioned by strand ID

- **Control Network** (`/optimystic/control-<party-id>`): peers = only this party's cadre nodes; data = CadreControl schema
- **Strand Network A** (`/optimystic/strand-<uuid-a>`): peers = Cohort A (Party 1, 2, 3); data = sApp A schema
- **Strand Network B** (`/optimystic/strand-<uuid-b>`): peers = Cohort B (Party 1, 4); data = sApp B schema
- ... and so on for each strand

No cross-network communication. Each network has its own connection pool, gossipsub mesh, FRET routing table, and cluster coordination.

## Provider Integration

Cloud providers can host cadre nodes on behalf of users. The provider never has access to user keys—nodes generate their own libp2p identity and are authorized via signed messages.

> **`@serfab/cadre-host` is a second implementation of this same donate-a-node contract.** Where a cloud provider hosts nodes in Docker containers, [`@serfab/cadre-host`](cadre-host.md#node-donation-the-primary-role) hosts them as OS-managed child processes on a home machine and donates them to the cadres of the operator's trust circle. It implements the same `Orchestrator` interface and the same provision → peer-info → seed → terminate flow shown below — it is a sibling **donor**, **not** a cadre founder. As with a provider, the recipient's device is the authority and the host never holds owner keys.

### Provider Flow

```mermaid
sequenceDiagram
    participant U as User (Phone)
    participant P as Provider API
    participant C as Provider Container
    U->>P: 1. Request container (payment + pinnedOwnerKeys)
    P->>C: 2. Spawn container
    C->>P: createCadrePeer() → PeerId
    P->>U: 3. Return PeerId + multiaddr
    Note over U: 4. authorizePeer (add to local control DB)<br/>5. createSeed()
    U->>P: 6. PUT /containers/:id/seed
    P->>C: Forward seed
    Note over C: applySeed() (populate cache)
    U->>C: 7. Dial container (outbound, NAT-safe)
    U<<->>C: Control Network Sync
    Note over C: Watch Strand table
```

Provider only sees: container ID, network traffic, opaque seed. Provider never has: owner keys, strand data.

### Durable Container Identity

A hosted node's peer id must survive a container restart — a re-keyed node is a stranger to the cadre
that authorized it, and its owner has to re-authorize it by hand. `DockerOrchestrator` therefore gives
each container a **named** Docker volume of its own (`cadre-<containerId>-data`) mounted at `/data`,
rather than the image's anonymous `VOLUME ["/data"]`:

- **Created once, reused after.** `ensureVolume` inspects before creating, so recreating a container
  under the same provider container id — an image upgrade — re-attaches the same state and therefore
  the same identity. Only a volume the failing attempt itself created is rolled back; a pre-existing
  one is left alone rather than destroyed.
- **The node mints its own key inside it.** `docker/entrypoint.sh` runs `enroll create` into `/data`
  before generating `cadre.yaml`, and exports `CADRE_KEY_FILE` / `CADRE_NODE_STATE_DIR` to the started
  child. The env values are re-applied over the loaded config on every start, so they stay
  authoritative and repair a container whose `cadre.yaml` was generated before this wiring existed.
  The key never crosses the provider/tenant boundary.
- **Node-local stores ride along.** `CADRE_NODE_STATE_DIR` defaults to the same `/data` mount, so the
  bootstrap-peer store and the trusted-owner anchor persist on the identical volume — see
  [Control Network Seed](#control-network-seed) → "Cold-start bootstrap retries".
- **It dies with the lease.** `removeContainer` reads the container's mounts from a live inspect,
  force-removes the container, then removes that named volume — matching how `cadre-host` deletes a
  donated node's workdir on termination.

### Relay Integration

For NAT'd nodes to be reachable, they include circuit relay addresses in seeds:

```typescript
// Phone gets its relay-routed address
const relayAddr = await cadreNode.getRelayAddress();
// e.g., /dns4/relay.provider.com/tcp/4001/p2p/<relay>/p2p-circuit/p2p/<phone>

// Include in seed when adding another NAT'd node
const seed = await cadreNode.createSeed();
// seed.peers[0].multiaddrs = [relayAddr]
```

When both nodes are NAT'd (e.g., phone adding another phone), the seed includes relay addresses so the new node can dial through the relay:

```mermaid
sequenceDiagram
    participant P1 as Phone 1 (Owner)
    participant R as Relay
    participant P2 as Phone 2 (New)
    Note over P1: Seed includes relay addr:<br/>/dns4/.../p2p-circuit/p2p/&lt;phone1&gt;
    P1-->>R: Connected to relay
    P2->>R: Dial relay (from seed addr)
    R->>P1: Circuit relay connection
    P1<<->>P2: Control Network Sync
```

Once multiple nodes with public IPs exist in the cadre, the control network becomes more resilient and less dependent on relays.

## Deployment Configurations

### Minimal (Single Phone)

- **Phone** as sole cadre node: transaction-only profile, connectivity via relay when behind NAT, participates in all strands (limited by battery/connectivity)
- Limitations: no redundancy (phone offline = party unreachable), no archival storage, relay-dependent for inbound connectivity

### Standard (Phone + Cloud Node)

- **Phone** (transaction-only, has owner keys) ↔ **Cloud Node** (storage profile, always online, public IP, archival storage)
- Benefits: redundancy (either can serve control network), storage capacity for strand data, cloud node as bootstrap for new nodes/peers

### Enterprise (Multi-Node Mixed)

- **Phone + Laptop** (transaction-only) · **Cloud ×3** (storage/backup) · **On-prem NAS ×2** (primary storage)
- High availability (multiple always-on nodes), geo-distributed storage, key material secured on mobile, scales to many strands

## Package Structure

The cadre system is implemented across several packages:

```mermaid
graph TD
    CC["<b>@serfab/cadre-core</b><br/>Core library, platform-agnostic<br/>CadreNode, control network, strand lifecycle,<br/>enrollment API, seed bootstrap, profiles"]
    CLI["<b>@serfab/cadre-cli</b><br/>CLI wrapper for servers"]
    MOB["<b>Mobile integration</b><br/>React Native / NativeScript"]
    CTR["<b>Container runtime</b><br/>Docker entrypoint, health checks,<br/>provider enrollment"]
    HOST["<b>@serfab/cadre-host</b><br/>Self-hosted basement-PC deployments<br/>— see cadre-host.md"]
    CC --> CLI
    CC --> MOB
    CC --> CTR
    CC --> HOST
    CC -.->|depends on| DEP["@optimystic/db-p2p · @quereus/quereus<br/>@optimystic/fret"]
```

## Key Data Structures

### CadreNode Configuration

```typescript
interface CadreNodeConfig {
  // Node identity (see "Node Key Material & the KeyStore Seam" below).
  privateKey?: PrivateKey;        // Direct keypair injection (legacy path)
  keyStore?: KeyStore;            // Pluggable secure store; mutually exclusive with privateKey
  identityKeyId?: string;         // Slot id in keyStore (default 'cadre/identity')

  // Control network connection
  controlNetwork: {
    partyId: string;              // UUID of the party/control network
    bootstrapNodes: string[];     // Multiaddrs to join control network
  };

  // Node profile
  profile: 'transaction' | 'storage';

  // Strand filtering (which strands to participate in)
  strandFilter?:
    | { mode: 'all' }                           // All strands (default for servers)
    | { mode: 'sAppId'; sAppId: string }        // Only strands for specific app
    | { mode: 'strandId'; strandId: string }    // Single specific strand
    | { mode: 'none' };                         // Control network only

  // Storage configuration (only for storage profile)
  // Uses the provider pattern for cross-platform support (Node.js, React Native, etc.)
  storage?: {
    provider: IRawStorage | ((strandId: string) => IRawStorage);  // Storage instance or factory
    quotaBytes?: number;          // Maximum storage to use
  };

  // Network configuration
  network: {
    listenAddrs?: string[];       // Addresses to listen on
    announceAddrs?: string[];     // Addresses to advertise — accepted but NOT YET APPLIED (no upstream db-p2p option; warns at start)
    // Circuit relays to reserve a slot on, as `<dial addr>/p2p/<relayPeerId>`.
    // Sugar for a `/p2p-circuit` entry in listenAddrs: `relay-addrs.ts` resolves the
    // two into one listen list (adding `/ip4/0.0.0.0/tcp/0` when listenAddrs is unset),
    // which is what makes libp2p dial the relay and hold the reservation. A relay named
    // here also becomes a delegate-announce target, so this node's strand nodes can
    // reserve on it too. A malformed entry throws at start.
    relayAddrs?: string[];
    enableRelay?: boolean;        // Enable circuit relay (default: true for storage profile)
    transports?: Libp2pTransports; // Custom libp2p transports (default: TCP + relay)
  };

  // Hibernation configuration
  hibernation?: {
    enabled: boolean;             // Whether to hibernate idle strands
    defaultLatencyHint?: 'realtime' | 'interactive' | 'background' | 'archive';
  };
}
```

### Node Key Material & the KeyStore Seam

A cadre node holds two sensitive keys at rest: the libp2p **peer/node identity**
key, and the **owner** signing key. In the single-key reference model the
owner key is *derived from* the identity key (`ed25519KeyPairFromLibp2p` —
libp2p's 64-byte Ed25519 raw key carries the 32-byte seed the crypto plugin
treats as the owner private key), so the node's PeerId and its owner key
are one keypair. Protecting the identity therefore protects the owner key.

`@serfab/cadre-core` stores key material behind a backend-agnostic **`KeyStore`**
interface (`key-store.ts`), so a platform-secure backend (iOS Keychain / Android
Keystore) can be plugged in without cadre-core taking any platform dependency.
The canonical stored form is the libp2p **protobuf bytes** of the private key.

```typescript
interface KeyStore {
  get(keyId: KeyId): Promise<Uint8Array | undefined>; // undefined = empty slot (NOT an error)
  set(keyId: KeyId, keyMaterial: Uint8Array): Promise<void>;
  delete(keyId: KeyId): Promise<void>;                // idempotent
  list(): Promise<KeyId[]>;                            // keyIds only — never material
}
```

Key contract points:

- **`get` returns `undefined` for a missing slot** and only *throws* on
  access-denied / backend failure (`KeyStoreAccessError`, carrying the `keyId`
  but never material). This distinction lets the load-or-create path generate a
  fresh key on a genuinely empty slot while refusing to clobber an existing but
  currently-unreadable key (e.g. a cancelled biometric prompt) — avoiding silent
  identity loss.
- Reference backends ship for non-mobile nodes and tests: **`InMemoryKeyStore`**
  (exported from the package root, dependency-free) and **`FileKeyStore`**
  (one file per slot, best-effort `0o600`). `FileKeyStore.set` is crash-atomic —
  it writes a sibling temp file, fsyncs it, then atomically renames it over the
  slot, so a crash mid-write leaves either the complete old bytes or the complete
  new bytes, never a torn/unloadable slot. `FileKeyStore` imports `node:fs` and
  is therefore exported from the subpath `@serfab/cadre-core/key-store-file` so
  the cross-platform default entry never pulls a Node-only edge into RN/browser
  bundlers.

**Identity resolution order** (performed once early in `CadreNode.start()`, before
any libp2p/network bring-up, into a private resolved field):

1. Both `keyStore` and `privateKey` set → configuration error (fail closed).
2. `keyStore` set → `get(identityKeyId ?? 'cadre/identity')`:
   - bytes present → `privateKeyFromProtobuf(bytes)` (corrupt bytes surface an
     error rather than regenerating);
   - empty → `generateKeyPair('Ed25519')`, persist `privateKeyToProtobuf(key)`,
     then use it;
   - `get` rejects → propagate (do **not** generate — that would orphan the key).
3. `privateKey` set → use it (legacy behavior).
4. Neither → libp2p generates an ephemeral key (legacy behavior).

Owner genesis stays **app-controlled**: cadre-core resolves and protects the
identity, then exposes the derived owner pair via
`CadreNode.getIdentityOwnerKey()` (available after `start()`); the hosting app
drives `ensureOwnerKey(pub)` + `initializeSeedBootstrap(priv)` itself rather
than cadre-core silently running genesis. A future separate-owner slot
(`ownerKeyId`) is anticipated but not yet built.

#### Mobile secure backend (`SecureStoreKeyStore`)

The React Native reference app (`reference-app-rn`) backs the seam with
**`expo-secure-store`** (`src/secure-key-store.ts`): iOS **Keychain**
(`kSecClassGenericPassword`) and Android **Keystore**-encrypted SharedPreferences.
The phone node's identity (and the owner key derived from it) therefore lives
in the platform enclave rather than the plaintext LevelDB the app used before.
`cadre-phone.ts` constructs the store and passes it as `keyStore` — cadre-core's
load-or-create path does the rest. Bridging details the backend handles:

- **Bytes ↔ text.** SecureStore stores strings; material is base64-encoded on
  `set`, decoded on `get` (lossless for the protobuf bytes).
- **KeyId → SecureStore key.** SecureStore keys allow only `[A-Za-z0-9._-]`, so a
  logical keyId (e.g. `cadre/identity`) is base64url-encoded under a `sereus.ks.`
  prefix — deterministic and collision-free.
- **`list()` via index.** Neither enclave can enumerate keys, so a reserved
  `sereus.ks.__index` entry holds a JSON array of logical keyIds. Material is
  written before the index (a crash leaves an orphaned-but-readable slot, never an
  index entry pointing at missing material); index writes are serialized.
- **Access vs absence.** A thrown `getItemAsync` (e.g. a cancelled biometric
  prompt) surfaces as `KeyStoreAccessError`; a `null` return becomes `undefined`.
  Only `undefined` triggers regeneration, so a transient access failure never
  orphans the real identity. For a **gated** slot (`requireAuthentication: true`) a
  `null` read is additionally disambiguated via the unauthenticated `sereus.ks.__index`
  marker — keyId present in the index ⇒ was-written-but-now-unreadable ⇒
  `KeyStoreAccessError` (fail-closed); absent ⇒ genuinely empty ⇒ `undefined`. For
  an ungated slot (today's default) `null` always means `undefined`, unchanged.

**Gating.** The identity slot defaults to **no `requireAuthentication`** (the node
must come up headless / in the background — push-wake and the background runner —
and a biometric-set change would invalidate a gated entry). iOS accessibility is
`AFTER_FIRST_UNLOCK` so the slot is readable while locked after first unlock.
Biometric gating remains *available* (`requireAuthentication: true` +
`SecureStore.canUseBiometricAuthentication()`), but enabling it additionally
requires an `NSFaceIDUsageDescription` string in `app.json` and is **unsupported
under Expo Go**.

**One-time migration.** On upgrade, if the secure slot is empty and the old
plaintext LevelDB identity DB (`sereus-peer-identity`) holds a key, the app lifts
it into the enclave once (then clears the plaintext copy), so the device keeps its
PeerId/owner across the upgrade. A failed legacy read falls through to fresh
generation (logged, never logging key material).

**Reinstall & recovery behavior:**

| Platform | After app uninstall/reinstall |
| --- | --- |
| **iOS** | Keychain items **persist** by default → identity/owner survive; the node resumes with the same PeerId. |
| **Android** | Uninstall wipes the app's SharedPreferences → the Keystore-encrypted entries are **lost**; the node generates a new identity on reinstall. |

- **Biometric invalidation.** Entries written with `requireAuthentication: true`
  are invalidated when the device's biometric set changes (new fingerprint /
  re-enrolled Face ID). Per Expo's API, a subsequent read then resolves `null`
  (indistinguishable, at the entry level, from an empty slot) rather than throwing.
  The unauthenticated `__index`-marker guard now makes an invalidated gated slot
  **fail closed** (`KeyStoreAccessError`, no silent regeneration over the real
  identity), so biometric gating is safe to enable once an `NSFaceIDUsageDescription`
  string is present in `app.json`. The identity slot nonetheless stays ungated by
  default because it must come up headless / push-woken (no prompt available).
- **Recovery.** A node that has lost its enclave entries (Android reinstall,
  biometric invalidation, device loss) does **not** recover the old key. It
  re-enrolls from another cadre node via the existing invite/seed flow
  (`applySeed` with the inviting cadre's owner keys pinned — see
  [Enrollment and Bootstrap](#enrollment-and-bootstrap)), receiving a fresh
  identity. The settings screen surfaces the node's **owner
  public key** (base64url) precisely so it can be shared for that (re-)pairing.

#### Closed-strand member keys — accepted residual risk

The KeyStore seam above covers the **node identity** (and the owner key derived
from it). It deliberately does **not** cover the closed-strand
`Strand.MemberPrivateKey`, which stays **plaintext in the control database**
(`control-schema.ts`, `schemas/control.qsql`; minted by `generateStrandMemberKey`,
delivered to the initiator in `FormationProvisionResult.memberPrivateKey`).

This is a recorded threat-model decision (2026-07), not an oversight:

- **Why plaintext.** The control DB is an Optimystic database replicated to *all
  of a party's own cadre nodes*. That replication is what makes cadre nodes
  **fungible** for closed strands — any node holds the member key, so any node can
  serve or participate in the strand, including nodes added to the cadre after the
  strand exists. There is no cadre-wide shared-secret infrastructure today; the
  `KeyStore` seam and its RN secure-store backend are strictly **per-device**.
- **Residual risk accepted.** A stolen/rooted device exposes the member private
  keys of every closed strand in that party's control DB, granting the attacker
  read access to those strands as that member.
- **Why acceptable for now.** The exposure is bounded by the same app-storage
  boundary (mobile LevelDB) that already holds the rest of the control DB's strand
  data, so protecting only this column is partial hardening. The
  higher-value, hard-to-rotate keys (peer identity + derived owner/authority) are
  already enclave-protected. Member keys are per-strand, intentionally replicated,
  and rotatable by re-forming the strand.
- **What would change the call.** Any hardening that preserves fungibility
  (envelope-encrypting the column under a per-cadre key held in each node's
  enclave) first requires **cadre-wide secret distribution** — provisioning one
  key into every node's enclave, including late joiners — which does not exist and
  has no second consumer yet. Revisit when either a second consumer appears for
  cadre-wide secrets, or the threat model changes (e.g. shipping to devices where
  app-storage compromise is expected). Alternatives that bind a strand to one
  device's enclave were rejected: they break node fungibility.

See [`docs/strands.md`](strands.md#closed-strand-member-key-handling) for the
same decision in strand terms.

### Strand Instance State

```typescript
interface StrandInstance {
  strandId: string;
  status: 'starting' | 'active' | 'idle' | 'hibernating' | 'stopping' | 'stopped' | 'error';

  // App information (from strand header, verified by signature)
  sAppInfo: {
    Id: string;                // Public key of app author
    Version: string;
    Schema: string;            // The declarative schema DDL
    Signature: string;         // Author's signature over schema
  };

  // Runtime components (only when active/idle)
  libp2pNode?: Libp2p;
  database?: Database;

  // Membership info (for closed strands)
  memberKey?: string;
  memberPrivateKey?: string;

  // Activity tracking
  connectedPeers: number;
  lastActivity: Date;
  nextCheckIn?: Date;             // For idle/hibernating strands

  // Latency hint (from app or override)
  latencyHint: 'realtime' | 'interactive' | 'background' | 'archive';
}
```

### Cross-Platform Storage Setup

The storage provider pattern decouples cadre-core from any specific storage backend, enabling the same code to run on Node.js servers, React Native mobile apps, and in test environments.

#### Node.js (Servers, CLI)

```typescript
import { CadreNode } from '@serfab/cadre-core';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';

const node = new CadreNode({
  // ...
  storage: {
    provider: (strandId) => new FileRawStorage(`/data/sereus/${strandId}`),
    quotaBytes: 10 * 1024 * 1024 * 1024  // 10 GB
  }
});
```

#### React Native (Mobile)

```typescript
import { CadreNode } from '@serfab/cadre-core';
import { RNRawStorage } from '@optimystic/db-p2p-storage-rn';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';

const node = new CadreNode({
  // ...
  profile: 'transaction',
  strandFilter: { mode: 'sAppId', sAppId: 'com.example.myapp' },
  storage: {
    provider: (strandId) => new RNRawStorage(strandId)
  },
  network: {
    transports: [webSockets(), circuitRelayTransport()],
    listenAddrs: []  // RN nodes typically cannot listen
  }
});
```

#### In-Memory (Testing)

```typescript
import { CadreNode } from '@serfab/cadre-core';
import { MemoryRawStorage } from '@optimystic/db-p2p';

const node = new CadreNode({
  // ...
  storage: {
    provider: () => new MemoryRawStorage()
  }
});
```

#### Available Storage Implementations

| Package | Environment | Class | Description |
|---------|-------------|-------|-------------|
| `@optimystic/db-p2p` | All | `MemoryRawStorage` | In-memory, for testing only |
| `@optimystic/db-p2p-storage-fs` | Node.js | `FileRawStorage` | File system persistence |
| `@optimystic/db-p2p-storage-rn` | React Native | `LevelDBRawStorage` | LevelDB-backed persistence |
| `@optimystic/db-p2p-storage-web` | Browser | `IndexedDBRawStorage` | IndexedDB persistence |

The `provider` field accepts either an `IRawStorage` instance (shared across all strands) or a factory function `(strandId: string) => IRawStorage` (recommended—creates isolated storage per strand). The factory pattern ensures each strand's data is partitioned, simplifying cleanup and preventing cross-strand interference.

### React Native Polyfills

React Native (Hermes engine) requires polyfills for several Web/Node.js APIs that libp2p, multiformats, and Optimystic depend on. These must be loaded before any library code in the app entry point. The full polyfill inventory — including global API shims (crypto, structuredClone, EventTarget via `event-target-polyfill`, Promise.withResolvers, etc.) and Metro module aliases for Node.js built-ins (os, crypto, stream, buffer, net/tls empty stubs) — is documented in:

- [Reference App: Polyfills](reference-app-rn.md#polyfills) — working implementations in `packages/reference-app-rn/polyfills/`
- [@optimystic/db-p2p README: React Native](https://github.com/gotchoices/optimystic/blob/master/packages/db-p2p/README.md#react-native) — polyfill checklist for any RN consumer of db-p2p

### Reference apps (cadre on edge platforms)

Three reference apps exercise the **same** cadre/strand stack on edge platforms —
each brings up a `CadreNode` (transaction profile), joins its control network, and
runs a chat sApp strand, on a different JS runtime. They are cadre references, not
transport-only demos:

| App | Platform | Storage | Coverage |
|-----|----------|---------|----------|
| `packages/reference-app-rn` | React Native / Hermes (phone) | `LevelDBRawStorage` | control network + open chat strand; seed apply; WebSocket/relay transports; Maestro e2e (drone fixture + sidecar) |
| `packages/reference-app-ns` | NativeScript / V8 (Android) · JSC (iOS) | SQLite (`db-p2p-storage-ns`) | control network + open chat strand; seed apply; WebSocket/relay transports; **reuses the RN Maestro e2e** (only the app id differs) |
| `packages/reference-app-web` | Browser | `IndexedDBRawStorage` | control network + **signed** open chat strand (schema-signature gate); solo owner self-genesis; **consent/invitation strand formation** (closed strands) + `CadreControl` authorization-gate ("RBAC") observability; WebSocket/relay/WebRTC transports |

The browser app ([reference-app-web/README.md](../packages/reference-app-web/README.md))
drives the full **consent/invitation formation path** end-to-end — it is the
first reference to call `createOpenInvitation` / `encodeInvitation` (responder)
and `decodeInvitation` / `formStrand` + closed-strand `addStrand` (initiator) —
and surfaces the `CadreControl` authorization gates (owner keys, formation
invites/usage, strand membership type + member-key presence) on its Diagnostics
page, including a live owner-gate probe that shows an unauthorized control
write being rejected. Becoming **dialable** for formation requires a circuit-relay
reservation (resolved from a runtime relay manifest, like the ICE manifest); a
tab with no relay configured stays solo and surfaces a clear "not dialable" error
rather than failing silently. Live two-party cross-cohort convergence (a message
written in one tab converging to the other through a shared closed strand) needs a
relay fixture + a dialable second cadre and is the reference's remaining deferred
e2e tier. Its polyfill surface
is much smaller than RN — modern browsers provide `crypto.subtle`, `EventTarget`,
`ReadableStream`, etc. natively, so only `os`/`net`/`tls`/`stream`/`buffer` need
Vite aliases (never a `crypto` shim). cadre-core pulls in `@optimystic/db-p2p`'s
main entry (which statically imports `@libp2p/tcp`), but supplying an explicit
browser transports array means `tcp()` is never instantiated, so no TCP transport
reaches the bundle's runtime.

The NativeScript app ([reference-app-ns.md](reference-app-ns.md)) is the RN app's
functional twin on a **third JS engine** — V8 (Android) / JSC (iOS) — proving the
stack is not Hermes-specific. Its polyfill surface sits between RN and the browser:
NS 8.8+ provides `crypto.getRandomValues`/`randomUUID`/`subtle.generateKey` and
`TextEncoder` natively (unlike Hermes), but still needs `crypto.subtle.digest`,
`TextDecoder`, `structuredClone`, web streams, `Promise.withResolvers`, timer
`.ref()/.unref()`, `Buffer`, `CustomEvent`, and `Intl.PluralRules` shims, plus a
webpack resolver that mirrors RN's Metro config (`react-native`/`browser`
conditions → db-p2p `rn.js`, the `@libp2p/crypto` browser rewrite, and `node:`
stripping). Its automated e2e **reuses** the RN drone fixture, HTTP sidecar, and
Maestro flows verbatim (only `MAESTRO_APP_ID` changes); the one NS-specific risk —
whether Maestro's `id:` matcher resolves NS `automationText` (Android
`contentDescription` / iOS `accessibilityIdentifier`) — is verified out-of-band via
Maestro Studio, with Appium as the documented fallback.

## References

### Internal Documentation

- [Arachnode Architecture](arachnode.md) - Storage ring system (planned)
- [Strand Management](strands.md) - Strand concepts and negotiation
- [Bootstrap Protocol](strand-proto.md) - Formation protocol details
- [API Specification](api.md) - Cadre peer authorization API
- [Cadre Consistency Model](cadre-consistency.md) - Design exploration: async Right-is-Right + transactional Sync for the control network

### Schemas

- `schemas/control.qsql` - CadreControl schema for control network
- `schemas/strand.qsql` - Strand schema for membership management

### Existing Implementations

- `@gotchoices/optimystic/packages/db-p2p` - libp2p node creation with Optimystic integration
- `packages/strand-proto` - Bootstrap session management (**deprecated**; the formation transport is now native in `cadre-core`'s `strand-formation-protocol.ts`)
- `packages/cadre-core` - Core cadre node library
- `packages/cadre-cli` - CLI wrapper for cadre nodes
- `packages/cadre-provider` - Reference provider service for hosting cadre nodes
- `ops/docker/libp2p-infra` - Container infrastructure for relay/bootstrap nodes

---

## Implementation Status

### `@serfab/cadre-core` (Complete)

- **CadreNode**: Main entry point with `start()`/`stop()` lifecycle, event emission, control network management
- **StrandWatcher**: Poll-based monitoring of `Strand` table with configurable filters (`all`, `sAppId`, `strandId`, `none`)
- **StrandInstanceManager**: Per-strand libp2p node creation with isolated storage paths, sApp schema application, and ed25519 schema signature verification on strand start
- **Schema Verification**: `signSchema()`, `verifySchema()`, `assertSchemaSignature()` — ed25519 signature verification of sApp schemas gating strand join. **Enforced by default (fail-closed)**: the `requireSignedSchemas` node policy defaults to `true`, so an unsigned schema is rejected (`'missing signature'`, distinct from `'invalid signature'`) before any libp2p node or schema DDL is brought up. The policy may be relaxed only by explicit opt-out (`requireSignedSchemas: false`) for dev/test with unsigned demo schemas (e.g. `reference-app-rn`).
- **EnrollmentService**: `createCadrePeer()` for Ed25519 keypair generation
- **KeyStore seam**: backend-agnostic `KeyStore` interface (`get`/`set`/`delete`/`list`, `KeyStoreAccessError`) with `InMemoryKeyStore` (root export) and `FileKeyStore` (subpath `@serfab/cadre-core/key-store-file`) reference backends. `CadreNode` resolves its identity through it (`keyStore` + `identityKeyId`, mutually exclusive with `privateKey`) and exposes the derived owner pair via `getIdentityOwnerKey()` — see [Node Key Material & the KeyStore Seam](#node-key-material--the-keystore-seam). The platform-secure (`expo-secure-store`) mobile backend lands in a dependent ticket.
- **Seed Bootstrap API**: `createSeed()`, `applySeed()`, `deliverSeed()`, `encodeSeed()`/`decodeSeed()`, helper functions (`addDrone`, `createInvite`, `acceptPhone`, `addPhoneWithRelay`)
- **Member Registration API**: `registerMember()`, `validateMemberRegistration()` with pluggable verifier/registry interfaces
- **Strand Solicitation API**: `createOpenInvitation()`, `formStrand()` with full `strand-proto` SessionManager integration via `StrandFormationManager`; outside approval of a redemption (an invite's `ValidationUrl`) lives in the formation-approval client (`createHttpFormationApprover()`), not in the solicitation service, and is called from `ControlFormationUsageRecorder` — the component that performs the write, so the nonce that is signed is the nonce that is inserted — see [`docs/api.md`](api.md)
- **Hibernation**: Activity-based lifecycle with latency hints (`realtime`, `interactive`, `background`, `archive`), configurable timeouts, exponential backoff check-in
- **Profile Configuration**: Transaction vs storage mode selects the FRET profile (`edge`/`core`) and toggles the Ring Zulu hint passed to the libp2p node (`strand-instance-manager.ts:202,210`). _The concentric storage-ring / keyspace-partitioning / capacity-quota subsystem is **not implemented** — `arachnode-stub.ts` is a no-op stub (exported but currently unused). See [Node Profiles](#node-profiles) and `tickets/backlog/later/5-ring-zulu-storage-rings.md`._

### `@serfab/cadre-cli` (Complete)

- CLI commands: `cadre start`, `cadre status`, `cadre enroll`, `cadre strand`, `cadre validation-key`
  - `cadre strand list|remove` is the operator surface for the `Strand` table. `list` reports what this node is running (`cadre strands` remains as an alias for `cadre strand list`). `remove <strandId>` is `CadreNode.unpublishStrand`: an owner-signed delete of THIS party's row, which every node in the party observes on its next watcher poll and stops its own instance for — except a node whose `strandFilter` excluded the strand, which never observes the removal — other parties in the strand are unaffected. It reads the row before writing, so an unpublished strand reports "nothing to do" (exit 0) instead of a silent no-op, and a **closed** strand (`Type='c'`) is **refused without `--yes`** — that row carries the party's membership key, stored nowhere else, so removing it forecloses ever admitting another member to the strand. The refusal exits non-zero and is structured under `--json`. Successful removals warn that the effect is party-wide and that a removal committed while the node has no control connections is local-only (the "Delete-while-alone durability" convergence gap above)
  - `cadre validation-key add|remove|list` is the operator surface for the `ValidationKey` table above — the approver keys this party trusts to sign off on redemptions of a `ValidationUrl`-bearing invitation. Owner-signed, so it needs a config whose identity key is an enrolled `OwnerKey`. `add` and `remove` read the enrolled set before writing, so a repeat enrollment reports "already enrolled" instead of a raw constraint failure, and a removal can say whether anything was there — and warn when it emptied the set, which leaves every outstanding validation-gated invitation unredeemable until a key is enrolled (rotation is add-then-remove, in that order). A key that is not a base64url-encoded **32-byte Ed25519 public key** is refused before any write (`requireEd25519PublicKeyB64`, shared with the `OwnerKey` genesis insert `ControlDatabase.ensureOwnerKey`), so a typo'd or truncated paste fails at the terminal with a message naming the problem instead of enrolling a key that can never validate an approval. The check is shape-only — 32 bytes that are not a point on the curve are accepted here and fail later at signature verification like any other wrong key. The raw table writers (`insertOwnerKey`, `insertValidationKey`) stay unguarded on purpose: they are the low-level replication/test seam, and every operator-facing path reaches them through a guarded caller.
  - `cadre status` reads **live runtime** from the running node's health `/status` endpoint (`--health-host`/`--health-port`, env `CADRE_HEALTH_PORT`): it reports the live `running`/`peerId`/`multiaddrs`/strand counts when a node answers, clearly distinguished from the static "Configuration" summary. A missing config is non-fatal (the live query still runs); when no node is reachable it says so (and exits non-zero, code `3`) rather than asserting `running: false`.
  - `cadre enroll register` is an **offline signature verification** — it checks that the supplied owner signature is valid over the enrollment vouch digest `digest('Cadre.Enrollment', 'vouch', peerId)` (via `verifyPeerAuthorization` — domain-tagged, so an enrollment vouch cannot double as any table approval) and does **not** contact the control network or register the peer. Membership is granted by the running owner node (`cadre start --owner`), which self-registers and authorizes peers.
- YAML/JSON config with environment variable overrides
- Systemd service file with security hardening, graceful shutdown

### Container Runtime (Complete)

- Docker image based on node:22-alpine with entrypoint script
- Health check endpoints (`/health`, `/ready`, `/status`)
- Provider integration: enrollment token, status reporting, metrics, seed delivery
- Docker Compose template with volume and network configuration

### `@serfab/cadre-provider` (Complete)

- Provider API: container CRUD, billing plans/status, seed delivery, peer info
- Billing integration: usage metering, Stripe-ready hooks, quota enforcement
- Orchestration: Docker orchestrator, mock orchestrator, pluggable interface

### `@serfab/cadre-host` (Founder role complete; donor `DonationService` landed, `/grants` routes in progress)

Self-hosted cadre node manager for basement-PC deployments — sibling of `@serfab/cadre-provider` (multi-tenant Docker hosting). Its primary role is **node donor**: a second `Orchestrator` implementation of the same donate-a-node contract as the provider (see [Provider Integration](#provider-integration)), hosting nodes as OS-managed child processes and donating them to the cadres of the operator's trust circle — the recipient's device stays the authority, and the host holds no owner keys. Running the host's *own* personal cadre — the **founder** role, with an owner node + trust circle + NAT — is opt-in (`ownCadre.enabled`, default off). See [cadre-host.md](cadre-host.md) for persona, package boundary, and security posture.

- **CLI** (`cadre-host`): `install`, `start`, `status`, `uninstall`, `ui`; `grant issue|list|revoke` (node-donor); `invite`, `trust list|revoke`, `nat status|test|ddns|settings` (opt-in founder).
- **Node donation (donor role, primary)**: a **grant-token** gate (`GrantService` / `GrantStore` / loopback `/grants-admin` / `cadre-host grant`) authorizes who may request a node, long-lived and reusable up to a quota. The orchestrator pins the requester's owner public key into the spawned child (`createContainer` → `CADRE_OWNER_KEYS` → cold-start pinned-key trust policy) so it trusts the requester-signed seed, and the `donations.json` store persists the host-only `seedToken`. The `DonationService` lifecycle (provision → peer → seed → terminate) has landed and is proven end-to-end against two real `cadre-cli` children (`cadre-host-node-donation.integration.ts`); the grantee-facing `/grants` HTTP routes that expose it and the `bin/host.ts` wiring are still being added. The request surface is loopback-only in v1 (per-donated-node WAN reachability deferred to `backlog/feat-cadre-host-wan-grant-reachability`).
- **Installer**: interactive + `--non-interactive` wizard, Ed25519 identity generation (mode 600), `host.config.json` / `nat.json` seeding, per-platform service-host registration (`systemd --user` on Linux, `LaunchAgent` on macOS, NSSM-managed `CadreHost` on Windows), best-effort browser open and first enrollment invite.
- **HostProcessOrchestrator**: spawns cadre nodes as native child processes with PID-liveness, port allocator (health/metrics/p2p/admin), state store, and log rotation; survives orchestrator restart (children stay running, are re-adopted). Owns the **owner-node lifecycle** — `ensureOwnerNode`/`restartOwnerNode` spawn the admin's owner node (`cadre-cli start --owner --admin-port <p> --identity-protobuf …`) and expose its loopback admin endpoint.
- **Owner-node delegation**: the manager holds no in-process `CadreNode`; `OwnerNodeClient` (an HTTP client of the node's `127.0.0.1:<adminPort>` admin channel) backs both the trust-circle and NAT `CadreNodeLike` shapes and pushes NAT-resolved invite addresses. Unreachable-node failures map to `node_unavailable` (→ 503). This keeps the manager out of the control network entirely (control-plane separation).
- **Trust-circle auth**: Ed25519-signed invite tokens with TTL, persistent store, revoke, list members (over the admin channel; degrades to the local labels file when the node is down); mounted at `/auth/*`.
- **NAT layer**: UPnP/NAT-PMP port mapping, external-IP probe, reachability tests, DuckDNS DDNS provider with updater, secrets via keytar (with file-store fallback); pushes invite addresses to the owner node on change; mounted at `/nat/*`.
- **Local UI server**: Fastify on `127.0.0.1:<uiPort>` (loopback only) with Origin/Host guard against DNS-rebind, SSE event bus at `/api/events`, settings store, `/api/status`, `/api/nodes/:id/{logs,stop,start,restart}`, `/api/settings`; serves the Svelte 5 SPA from `dist/ui/`.
- **Update service**: notify-by-default with opt-in auto-apply, signed manifest fetch from `releases.serfab.io/cadre-host/latest.json`, Ed25519 signature verification, npm-channel apply with service-host restart; `/update/*` routes.

### Testing

- **`@serfab/cadre-core`**: unit tests for CadreNode, StrandWatcher, StrandInstanceManager, EnrollmentService, StrandSolicitationService, schema verification, types. Integration tests for seed bootstrap and strand formation protocol.
- **`@serfab/cadre-host`**: 281 unit + smoke tests across orchestrator, installer (including service-host stubs per platform), trust-circle, NAT (UPnP, reachability, DDNS, secrets), update service, and local-UI server routes / origin-guard / SSE bus.
- **`packages/integration-tests`**: real-libp2p scenarios for basic connectivity, strand creation, multi-party sync/workflows, seed bootstrap, deliver-seed cross-network, enrollment e2e, strand-formation e2e, websocket chat, convergence stress. Cadre-host scenarios (`cadre-host-*.integration.ts`) boot a real `Installer` + `createLocalUiServer` against an ephemeral loopback port via the `createTestCadreHost` harness in `src/harness/test-cadre-host.ts` and drive bootstrap, origin guard, SSE delivery, orchestrator lifecycle, trust-circle (against a real `CadreNode`), and update-notify (against a loopback signed-manifest fixture). Because every scenario runs *compiled* cadre output (a spawned `cadre-cli` child, or an in-process import of `@serfab/cadre-host`/`@serfab/cadre-core` from `dist`), the suite's vitest `globalSetup` (`src/global-setup.ts`) first asserts each of those packages' `dist` is newer than its `src` — see "Testing / CI" in [`docs/STATUS.md`](STATUS.md).

