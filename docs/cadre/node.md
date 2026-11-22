# The cadre node

A cadre node is one running instance of `@serfab/cadre-core`: the `CadreNode` class, or the edge node built over it for phones and browsers. This document covers what a started node does, the options that configure it, and what it keeps on its machine. Read it when embedding `@serfab/cadre-core`, or when configuring a node that another program (`cadre-cli`, `cadre-host`, a provider) runs.

Related: [cadre-core API guide](../api.md) · [Adding and removing machines](membership.md) · [Who a node trusts and admits](control-security.md) · [Strands: model and lifecycle](../strands/lifecycle.md) · [Relays](../network/relay.md) · [React Native](../platforms/react-native.md) · [browser](../platforms/browser.md)

## What a node does

A started node runs one libp2p node for the party's control network, under the node identity key, and one more for each strand it runs, each under a key derived from the identity key and the strand id (`strandTransportKey`). A machine therefore has a stable and distinct peer id in every strand, which only the holder of the identity key can compute.

The node's duties, each with the document that owns the mechanism:

1. **Replicates the whole control database** ([Control database replication](control-replication.md)).
2. **Stays connected to the party's other nodes**, dialing every always-on node and a bounded number of the others ([Cohort auto-connect](control-convergence.md#cohort-auto-connect), [Cold-start retry](control-convergence.md#cold-start-retry)).
3. **Decides who may connect and what they may ask for** ([The connection gate](control-security.md#the-connection-gate), [Per-stream protocol guard](control-security.md#per-stream-protocol-guard)).
4. **Verifies control rows against owner keys it trusts out of band** ([The trusted-owner anchor](control-security.md#the-trusted-owner-anchor)).
5. **Publishes its own signed address record**, so the party's other nodes can find it from its peer id ([The node's address record](#the-nodes-address-record)).
6. **Watches the party's strands and starts or stops them.** The strand watcher reads the `Strand` and `JoinedStrand` tables on each change and launches the strands the [strand filter](#strand-filtering) admits ([Reactive strand management](../strands/lifecycle.md#reactive-strand-management)).
7. **Admits new machines and answers other parties.** Any member node can redeem a [cadre invitation](membership.md#cadre-invitations) for a newcomer, and a node answers [formation](../strands/formation.md#who-answers-formation) requests for the party.
8. **Hibernates idle strands and wakes them**, when hibernation is enabled ([Strand hibernation and wake](../strands/hibernation.md)).
9. **Publishes a device push token**, on a phone (`CadreNode.registerDeviceToken`), so an always-on node can wake it by push ([Push wake](../strands/hibernation.md#push-wake)).
10. **Relays connections for the party's other machines**, when its relay server is on ([Relays](../network/relay.md)).

### The node's address record

`CadreNode.registerSelf` writes this node's dialable addresses, public key, whether it is always on and a timestamp to its own `CadrePeer` row, signed with the identity key. The node publishes again when its addresses change and on a heartbeat of half the record's 15-minute maximum age (`peer-record.ts`). A node that holds no owner key cannot insert its own row: it waits for the row an owner or the admitting member wrote to arrive by replication, and refreshes it from then on.

`CadreNode.resolvePeerAddrs(peerId)` returns another node's addresses only if the stored public key matches the peer id, the signature verifies, the record is fresh and the caller's trust policy accepts it; otherwise it returns an empty list.

The addresses an embedder supplies through `CadreNode.setInviteAddresses` or `network.inviteAddressResolver` may omit the `/p2p/<peerId>` suffix; the node appends its own (`normalizeDialAddrs`).

### Discovered strands

A strand row that no app on this machine has claimed with `addStrand` is recorded in `CadreNode.getDiscoveredStrands()` and announced once per session as `strand:discovered`. Claims are held in memory only, so after a restart every stored strand is announced again. The [API guide](../api.md) says how an app subscribes without missing the first announcement and what `stopStrand` does to a claim.

A failed launch leaves nothing tracked: `getStrand(id)` returns `undefined`, and the watcher retries with a doubling delay capped at five minutes. A launch that can never succeed is not retried: an id unusable as a [storage scope key](#storage-scope-keys), or [a schema the strand cannot take](../strands/app-schema.md#a-schema-that-can-never-apply-here-is-not-retried).

### Strand instance state

`CadreNode.getStrand(id)` and `getStrands()` return a `StrandInstance` per running strand, whose fields the [API guide](../api.md) describes. Its `status` values are explained in [States](../strands/hibernation.md#states), and its `sAppInfo` is absent on a [storage replica](#storage-replicas).

## Node classes

`nodeClass` is required and says what kind of machine this node runs on. `device` is a phone, a laptop or a browser tab running an app: connected some of the time, and running only the strands its app uses. `server` is an always-on node: a `cadre-cli` process on a server or a home machine, a cadre-host child, or a provider's container.

The class decides nothing by itself. It is the **preset** for four separate decisions — the node's **roles** — each of which a deployment can set on its own through the optional `roles` block:

| Role | What it decides | `device` | `server` |
|---|---|---|---|
| `alwaysOn` | Whether this machine declares that it stays running and reachable | `false` | `true` |
| `overlayTier` | The FRET resource tier of the control node and every strand node | `edge` | `core` |
| `reactivity` | Whether the node may carry other subscribers' [change notifications](../strands/app-schema.md#change-notifications) | `forwarder` | `forwarder` |
| `strandCohortMember` | Whether the node holds and signs the blocks of the strands it runs | `true` | `true` |

A role left out of `roles` takes its preset's value. A misspelled role name, or a value outside a role's own set, is refused when the node is constructed rather than resolving quietly to the preset. So `roles: { alwaysOn: true }` on a `device` changes that one decision and leaves the other three at the device defaults.

Two of the four are the same under both presets, for different reasons. `reactivity` is `forwarder` because that is what every node already does; whether a phone should forward is an open question that this option exists to let a deployment test. `strandCohortMember` is `true` because a machine that stores what it uses is the right default for a party's handful of strands; `false` is for a strand too large for every machine to store, such as a vote with thousands of phones ([A node that holds no strand blocks](#a-node-that-holds-no-strand-blocks)).

### What always on turns on

| What it affects | `alwaysOn: false` | `alwaysOn: true` |
|---|---|---|
| Optimystic's Arachnode subsystem (ring membership, block restoration from other holders) | off | on |
| Relay server, when `network.enableRelay` is unset | off | on |
| Strands no local app has claimed, when `hostUnclaimedStrands` is unset | announced only | run as [storage replicas](#storage-replicas), unless the node holds no strand blocks |
| How the party's other nodes dial it | up to the cohort's target degree | always |
| In seeds and invitation replies | listed | listed as a preferred peer |

The first three are local settings, and `network.enableRelay` and `hostUnclaimedStrands` each override one of them. The last two follow from what the node publishes in its [address record](#the-nodes-address-record): the party's other machines read that declaration and treat the machines that make it as the ones that stay reachable ([Cohort auto-connect](control-convergence.md#cohort-auto-connect)). That declaration is all they read — neither the class nor any other role is replicated — and [the control schema](control-schema.md#limits-and-accepted-tradeoffs) describes the column that stores it.

Every node stores the control database: it keeps its blocks in whatever `storage.provider` returns ([Storage](#storage)). Whether it also stores the blocks of each strand it runs is `strandCohortMember`'s decision alone; nothing else, class included, decides it.

### A node that holds no strand blocks

With `strandCohortMember: false`, every strand node the machine builds is an Optimystic **client** (`servesBlocks: false`). It runs the strand — reads, writes, membership, change notifications — and stores none of its blocks: it asks `storage.provider` for no per-strand store, and its reads and writes go to a coordinator among the strand's serving machines. The control network is unchanged and still replicates to every machine of the party.

What keeps a client out of the strand's clusters is what it does not register. A client offers none of Optimystic's four storage protocols, so every other machine classifies it from its identify list as not serving and leaves it out of every cluster, and the client classifies itself the same way. A sleeping phone is therefore never on the path of another machine's save, which is what a strand with thousands of phones needs. Optimystic's `docs/internals.md` → "Client nodes" is the reference for what such a node builds, what it ignores and what a write costs.

What follows for the strand's other mechanisms:

- **No first-sync gate.** A client's database is published as soon as it opens: it is in no cluster, so a write with no serving machine reachable fails rather than committing alone, and there is no fork to prevent ([Joining: no writes before the first sync](../strands/formation.md#joining-no-writes-before-the-first-sync)).
- **No `StrandPeer` row.** The party's row set means "the machines that serve this strand", which a serving sibling's offline queue waits for; a client's row would hold that queue forever. [Binding the party's machines](../strands/membership.md#binding-the-partys-machines) says what the missing row costs, including the open defect that a party key replacement cannot bind a client under the new key.
- **No block catch-up and no storage replicas.** A client has no blocks to push to a newly connected peer, and `hostUnclaimedStrands` defaults to `false` on it whatever `alwaysOn` says; an explicit `true` beside the role is refused when the node is constructed.
- **Commits are never followed to full replication.** The record of a client's commit lives on the machine that coordinated it, so `strand:commit-held` never fires on a client ([A commit's durability](../strands/writes.md#a-commits-durability)).
- **Change notifications are received, never originated.** A client applies no commits, so it announces none; it still registers watches and forwards under its `reactivity` role, and a watch's wake can lag one round of cohort gossip until its registration reaches the machine that announces a commit.
- **Membership is unchanged, but a client hears of a removal late.** A client seats its own binding in a closed strand and keeps the revoked-peer gate, reading the membership rows remotely. That gate is woken by a change its own storage takes in, which a client has none of, so a removal made elsewhere reaches it only on the gate's backstop.

A client cannot open a strand's database with no serving machine reachable, and cannot found a strand alone; such a launch waits and retries instead of failing ([A launch with nobody to answer waits](../strands/lifecycle.md#a-launch-with-nobody-to-answer-waits)).

## Strand filtering

`strandFilter` decides which of the party's strands this node may run. The strand watcher checks it for every strand row, including strands the party joined from another party.

| Filter | The node runs |
|---|---|
| `{ mode: 'all' }` | Every strand of the party. The default. |
| `{ mode: 'sAppId', sAppId }` | Strands whose sApp id equals `sAppId`. |
| `{ mode: 'strandId', strandId }` | The one strand with that id. |
| `{ mode: 'none' }` | No strands: the control network only. |

Under an `sAppId` filter, a strand whose sApp id the node does not know yet is admitted provisionally. The id comes from the app's claim, or on a storage replica from the strand's own `Strand.Header` once it has replicated (`CadreNode.getSAppId`). The watcher then stops the strand if it belongs to another app.

`cadre-cli` takes the same filter in its config file ([cadre-cli README](../../packages/cadre-cli/README.md)).

### Storage replicas

Whether a node runs a strand its filter admits and no app on the machine has claimed is a separate option, `hostUnclaimedStrands`, which is on by default on a node whose [`alwaysOn` role](#node-classes) is on. On a [node that holds no strand blocks](#a-node-that-holds-no-strand-blocks) it is off by default and an explicit `true` is refused, since a replica stores and serves blocks.

With it on, the node launches every admitted strand as a **storage replica**: the strand's own libp2p node, block store and `Strand` membership schema, with no sApp configuration and no `App` schema. A replica stores and serves the strand's blocks and runs nothing an app supplied. An always-on machine thereby keeps a copy of every strand of its party, so a lost phone loses nothing that had reached that machine.

- **A replica is always a joiner.** Founding writes the sApp into `Strand.Header`, so a node with no sApp cannot found.
- **A replica takes part in closed-strand membership like any other machine of the party.** It keeps the revoked-peer gate and seats its own machine binding ([Binding the party's machines](../strands/membership.md#binding-the-partys-machines)).
- **It is still announced as discovered**, once, and stays in `getDiscoveredStrands()` until an app claims it.
- **An app on the same machine can claim a running replica.** `addStrand` or `foundStrand` applies the app's schema to the live database over the same libp2p node and store, so nothing is fetched again and the peer id and connections are kept.
- **A strand joined from another party is hosted once the join is published party-wide** in the `JoinedStrand` table, and stopped when that row is removed ([What a joiner's node remembers](../strands/keys.md#what-a-joiners-node-remembers)).

With it off, the node announces the strand and launches nothing until an app claims it. `cadre-cli` does not expose the option, so on an always-on `cadre-cli` node the strand filter is the only way to host fewer strands.

## Configuration

`CadreNodeConfig` and `NetworkConfig` in [`packages/cadre-core/src/types.ts`](../../packages/cadre-core/src/types.ts) are the reference: each option's comment states its contract. This section lists the groups a reader sets and their defaults; each group's name links to the document that describes it. Three options are required: `controlNetwork.partyId`, `controlNetwork.bootstrapNodes` (which may be empty) and `nodeClass`.

| Group | Options | Default when omitted |
|---|---|---|
| [Party](membership.md) | `controlNetwork.partyId`, `.bootstrapNodes` | Required. Bootstrap addresses are dialed after the control database is up. |
| [What the node is and does](#node-classes) | `nodeClass`, `roles` | The class is required; each role takes its preset's value |
| [Identity](#node-key-material-and-the-keystore) | `keyStore`, `identityKeyId`, `privateKey` | A new key each start |
| [Trust before first sync](control-security.md) | `trustedOwners`, `seedTrustPolicy`, `claim` | Empty in-memory anchor; `anchoredTrustPolicy()`; not [claimable](membership.md#claiming-a-node) |
| [Node-local stores](#node-local-state) | `bootstrapPeers`, `enrolledMachines`, `strandNetworkState`, `joinedStrands` | In memory, lost on exit |
| [Block storage](#storage) | `storage.provider` | An in-memory store per network |
| [Which strands run](#strand-filtering) | `strandFilter`, `hostUnclaimedStrands`, `strandWatchInterval` | `all`; on when always on; 300 000 ms |
| [Schema policy](../strands/lifecycle.md) | `requireSignedSchemas` | `true`: an unsigned sApp schema is refused |
| [Replication](control-replication.md#replication-cluster-size) | `strandClusterSize`, `strandBackfill`, `controlBackfill` | 4; on; on ([Catching up a new machine](control-replication.md#catching-up-a-new-machine)) |
| [Joining a strand](../strands/formation.md) | `strandFirstSync` | Gate always on; timeouts from `strand-first-sync-gate.ts` |
| [Closed strands](../strands/membership.md) | `strandRevocationEnforcement`, `strandMembershipReconciliation` | Both on |
| [Offline writes](../strands/writes.md#offline-mode) | `strandOffline` | No offline mode |
| [Change notifications](../strands/app-schema.md#change-notifications) | `strandReactivity` | Off |
| [Hibernation](../strands/hibernation.md) | `hibernation` | Disabled; latency hint `interactive` |
| [Push delivery](../strands/hibernation.md#push-wake) | `push` | None |
| [Network](#network-options) | `network` | Per option |

`strandWatchInterval` is not a polling period. The watcher runs when the tables change, and this value is the longest it goes without re-reading when it hears no change.

A Node.js embedder that wants everything durable sets the identity, the node-local stores and a storage provider. This example is adapted from `packages/cadre-cli/src/commands/start-node.ts`:

```typescript
import { CadreNode } from '@serfab/cadre-core';
import { FileKeyStore } from '@serfab/cadre-core/key-store-file';
import { FileTrustedOwnerStore } from '@serfab/cadre-core/trusted-owner-store-file';
import { FileBootstrapPeerStore } from '@serfab/cadre-core/bootstrap-peer-store-file';
import { FileEnrolledMachineStore } from '@serfab/cadre-core/enrolled-machine-store-file';
import { FileStrandNetworkStateStore } from '@serfab/cadre-core/strand-network-state-file';
import { nodeDefaultTransports } from '@serfab/cadre-core/node-default-transports';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';

const stores = new Map<string, FileRawStorage>();
const provider = (scope: string): FileRawStorage => {
	let store = stores.get(scope);
	if (!store) {
		store = new FileRawStorage(`${dataDir}/${scope}`);
		stores.set(scope, store);
	}
	return store;
};

const node = new CadreNode({
	keyStore: new FileKeyStore(stateDir),
	controlNetwork: { partyId, bootstrapNodes: [] },
	nodeClass: 'server',
	storage: { provider },
	network: { listenAddrs: ['/ip4/0.0.0.0/tcp/4001'], defaultTransports: nodeDefaultTransports },
	trustedOwners: { store: await FileTrustedOwnerStore.open(stateDir, partyId), pinnedKeys: [ownerKey] },
	bootstrapPeers: { store: await FileBootstrapPeerStore.open(stateDir, partyId) },
	enrolledMachines: { store: await FileEnrolledMachineStore.open(stateDir, partyId) },
	strandNetworkState: { store: await FileStrandNetworkStateStore.open(stateDir, partyId) },
});
await node.start();
```

### Network options

One `network` block configures the control node and every strand node, because they share one machine and one link.

| Concern | Options | What to know |
|---|---|---|
| Listening | `listenAddrs` | Omitted: `/ip4/0.0.0.0/tcp/0`. `[]` means the node cannot listen. The control node binds each entry as written; each strand node binds the same entry with its port set to 0. |
| Advertising | `appendAnnounceAddrs`, `announceAddrs`, `inviteAddressResolver` | Control node only. `appendAnnounceAddrs` adds an address. `announceAddrs` replaces the whole advertised set, including an address earned from a relay. The resolver changes only the addresses put in invitations. |
| Being reached through a relay | `relayAddrs`, `requireRelay` | Each entry is a relay's dial address ending in its peer id. `requireRelay` defaults to `true`: `start()` fails if the first reservation fails. Set `false` on a node that must start with no network. |
| Serving as a relay | `enableRelay`, `relayServerInit`, `unauthorizedRelayReservationCap` | On by default when the node is always on. The cap (default 8) limits reservations granted to peers not yet recognised as members. |
| Transports and crypto | `transports`, `defaultTransports`, `noiseCrypto` | Omitted: TCP and circuit relay, with WebSocket added when a listen entry names `/ws` and WebRTC when one names `/webrtc`. React Native and browsers must supply `transports`. |
| WebRTC ICE | `stunUrls` | Comma-separated `stun:` URLs, replacing the ones derived from `relayAddrs` (each Sereus relay answers STUN on port 3478). Read only by a node that has a WebRTC transport. |
| The link | `linkRoundTripMs`, `cohortQueryTimeoutMs`, `connectionMonitor` | 3500 ms; derived from it (7000 ms); a 30 s ping deadline at a 35 s interval. |
| Admission | `connectionGater` | Composed with the node's own gates: a deny from either side denies. |
| Control cohort | `controlCohort` | Target degree 6; a reconcile pass at least every 120 000 ms. |

`linkRoundTripMs` is a declaration about the link, not a timeout. Every dial and reservation deadline is derived from it, and every machine of a party should declare the same value ([Dial budgets are counted in round trips, not milliseconds](../network/deadlines.md#dial-budgets-are-counted-in-round-trips-not-milliseconds)).

A Node.js host that sets `relayAddrs` should also pass `defaultTransports: nodeDefaultTransports` from `@serfab/cadre-core/node-default-transports`; [Reservations are requested explicitly](../network/relay.md#reservations-are-requested-explicitly) gives the reason. That subpath is also the only thing that can give a Node host WebRTC, which is why a `/webrtc` listen entry is accepted only from a node that passed `defaultTransports`, and why the host loads the transport itself through `loadNodeWebrtcTransport` ([Direct connections over WebRTC](../network/relay.md#direct-connections-over-webrtc)).

### Configuration errors that fail `start()`

`start()` refuses each of these configurations:

- **Both `keyStore` and `privateKey` set**, or a key store that refuses the identity read ([Identity resolution order](#identity-resolution-order)).
- **`claim` beside `trustedOwners.pinnedKeys` or `seedTrustPolicy`.** A node has one source of trust at cold start.
- **An injected node-local store opened for a different party** than `controlNetwork.partyId`.
- **A malformed `relayAddrs`, `announceAddrs` or `appendAnnounceAddrs` entry**, or a listen address no configured transport can bind: `/quic-v1` or `/webtransport` without a matching `transports` entry, and `/webrtc` on a node that passed neither `transports` nor `defaultTransports` (a `cadre-cli` node asks for it with `network.webrtc` instead).
- **A `linkRoundTripMs` that is not a finite number above zero.**
- **A relay in `relayAddrs` that grants no reservation** (`RelayReservationFailedError`), unless `requireRelay` is `false`.

## Node key material and the KeyStore

A node holds one secret key that it cannot work without: its libp2p identity key, which determines its peer id. A machine that a person made an owner also holds an owner key, in a slot of its own (`cadre/owner`). The embedding app creates and loads that key, never `CadreNode`, and the two key pairs are independent ([Owner keys](owner-keys.md)).

cadre-core reads and writes key material through the `KeyStore` interface (`packages/cadre-core/src/key-store.ts`): `get`, `set`, `delete` and `list` over named slots holding bytes. A platform plugs in its own backend (iOS Keychain, Android Keystore, a file, IndexedDB), so cadre-core takes no platform dependency. A key is stored in its libp2p protobuf encoding.

### What `get` must return

`get` returns `undefined` for a slot that has never been written. It throws, normally `KeyStoreAccessError`, when the slot exists but cannot be read: access denied, a cancelled unlock prompt, a backend fault, or a value that is not key bytes.

The distinction prevents identity loss. If a backend reported an unreadable slot as empty, the node would generate a new identity over the real one, and the machine would come up under a peer id its party has never admitted.

### Identity resolution order

`CadreNode.start()` resolves the identity once, before any network activity:

1. `keyStore` and `privateKey` both set: configuration error.
2. `keyStore` set: `loadOrCreateIdentityKey(keyStore, identityKeyId)`, where the slot defaults to `cadre/identity`. An empty slot gets a new Ed25519 key, stored before use. Undecodable bytes and a `get` that throws are errors.
3. `privateKey` set: that key is used.
4. Neither: libp2p generates a key that lasts until the process exits.

`loadOrCreateIdentityKey` is exported from the package root because an app may need its identity before it constructs a node. An app must call it and not reimplement it: a copy that handled a read failure differently could generate a second identity.

### What else is kept in the KeyStore

The key store is the one place every platform already keeps secrets, so two kinds of small secret records are filed there beside the keys. A backend must accept `/` in a slot id and values of a few hundred bytes, and `list` returns these ids too.

- **Joined-strand records**, under `cadre/joined-strand/<party>/<strand id>`: strands this node joined from another party and has not yet published to the party-wide `JoinedStrand` table. A closed strand's record carries its read secret ([What a joiner's node remembers](../strands/keys.md#what-a-joiners-node-remembers)).
- **Strand-move records**, under `cadre/strand-move/<party>`, written by the edge node when an app leaves a party it founded ([Moving the app's strands](apps.md#moving-the-apps-strands)).

An embedder that passes `privateKey` has no key store, so its joins are kept in memory and the node warns at the first one, unless it injects `joinedStrands.store`, a `KeyStoreJoinedStrandStore` over any durable `KeyStore`.

A closed strand's read secret and the party's membership key for it are not protected by the key store. They are rows of the control database, stored in plain form by decision ([Accepted residual risk](../strands/keys.md#accepted-residual-risk)).

### Backends

| Backend | Where | Notes |
|---|---|---|
| `InMemoryKeyStore` | Package root | Nothing survives the process. For tests and throwaway nodes. |
| `FileKeyStore` | `@serfab/cadre-core/key-store-file` (Node.js only) | One file per slot, mode `0600`, replaced atomically so a crash leaves the old bytes or the new ones. |
| `SecureStoreKeyStore` | `@serfab/cadre-rn/key-store` | The platform secure store ([Where node state is kept](../platforms/react-native.md#where-node-state-is-kept)). |

`FileKeyStore` and the other file-backed classes are separate subpath exports because they import `node:fs`, which React Native and browser bundlers cannot resolve.

## Node-local state

A node keeps a few records for itself that are never replicated and are filed per party. They exist because the control database cannot supply them: each is needed before the control database is readable, or describes this machine alone.

| Record | Why it must survive a restart | Trust-bearing |
|---|---|---|
| Trusted-owner anchor | It is the only record of which owner keys this machine trusts. A node that loses it accepts no seed until it is given owner keys again. | Yes |
| Cold-start dial targets | The addresses an applied seed named, and those of machines this node added. Nothing else records that a seed was applied until a connection succeeds, so losing them strands a node that was seeded but had not yet connected. | No: addresses only, each bound to its peer id before the dial |
| Enrolled-machine count | The control node declares its block-repair yardstick when it is built, before the membership rows can be read. | No: a hint, recomputed once the database is up |
| Strand network state | Each strand node's saved FRET routing table, so a restarted machine can redial a strand's peers ([Saved network state and redial](../network/strand-addressing.md#saved-network-state-and-redial)). | No: FRET verifies each entry on import |

Each record has a store interface, an in-memory default, and a `Persistent…` class that keeps it durably. A node configured with no stores forgets all four when it exits.

### The DurableSlot seam

The only platform-specific part of a persistent store is a `DurableSlot` (`node-local-snapshot.ts`): `load()` returns the slot's text or `undefined`, and `save(text)` replaces it. A new platform writes a slot over its storage and opens the stores over it:

```typescript
import {
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
	PersistentStrandNetworkStateStore,
	PersistentTrustedOwnerStore,
} from '@serfab/cadre-core';

const trustedOwners = await PersistentTrustedOwnerStore.open(anchorSlot, partyId);
const bootstrapPeers = await PersistentBootstrapPeerStore.open(peersSlot, partyId);
const enrolledMachines = await PersistentEnrolledMachineStore.open(countSlot, partyId);
const strandNetworkState = await PersistentStrandNetworkStateStore.open(networkSlot, partyId);
```

`load` has the same rule as `KeyStore.get`: return `undefined` only for a slot that was never written, and throw when the slot exists but cannot be read. Every write replaces the whole record, so a failed read reported as `undefined` would destroy an intact record on the next save.

What a store does with a slot it cannot use differs by record:

- **A missing slot, unparsable text, or a record for another party** loads as empty in every store. Holding nothing until the node is seeded again is safer than acting on foreign or damaged state.
- **A slot that throws on read** fails `open`, except for the enrolled-machine count, which logs it and loads as empty, because a missing repair hint must not stop a node from starting.
- **One unusable entry** discards the whole trusted-owner anchor, because trusting part of the keys a record claims is a silent security downgrade. The dial targets and the strand network state drop the entry and keep the rest, because they may be a stranded node's only route back to its party.

### Where each record is kept

The table lists every per-machine record, keys and block stores included, for `cadre-cli` and the three app platforms in this repository. The platform documents own the detail behind their columns: [React Native](../platforms/react-native.md#where-node-state-is-kept), [NativeScript](../platforms/nativescript.md#where-node-state-is-kept) and [browser](../platforms/browser.md#storage).

| Record | `cadre-cli` | React Native (`createPhoneNode`) | NativeScript app | Browser app |
|---|---|---|---|---|
| Identity key | File named by `identity.keyFile` | Secure store | `kv` table of the SQLite database `sereus-peer-identity` | `kv` store of the IndexedDB database `sereus-strand-control` |
| Owner key | `owner.keyFile`, default `owner.key` | Secure store | Same table | Same store |
| Trusted-owner anchor | `trusted-owners.<party>.json` | Secure store, own slot | Same table | Same store |
| Dial targets, machine count, strand network state | `bootstrap-peers`, `enrolled-machines` and `strand-network` files beside the anchor | LevelDB database `sereus-node-local` | Same table | Same store |
| Joined-strand records | In memory | Secure store | Same table | Same store |
| Saved start | Not used | `sereus-node-local` | Same table | Same store |
| Block stores | `storage.path/<scope>` | LevelDB database `sereus-<scope>` | SQLite database `sereus-<scope>` | IndexedDB database `sereus-strand-<scope>` |

- **`cadre-cli` keeps its files in the state directory**: `nodeState.dir` (or `CADRE_NODE_STATE_DIR`), defaulting to the directory that holds the config file. It also holds the claim record `claim.json` ([cadre-cli README](../../packages/cadre-cli/README.md)).
- **`cadre-host` and provider nodes are `cadre-cli` processes** that hold no owner key. `cadre-host` gives each node a directory of its own and deletes it with the node ([Hosted nodes](../hosting/cadre-host.md#hosted-nodes)). A provider mounts a named Docker volume at `/data` and deletes it with the container ([Durable container identity](../hosting/provider.md#durable-container-identity)).
- **`cadre-cli` never joins a strand from another party itself**, so its in-memory joined-strand records are always empty.
- **NativeScript and the browser keep everything, keys included, unencrypted in one database**, because neither has a more tamper-resistant store.
- **The saved start** is the [edge node](#the-edge-node)'s record of its last start options. It is one per app, not per party, because it names the party every other record is filed under.

## Storage

`storage.provider` supplies the raw block stores (`IRawStorage`) that the control database and each strand's database are kept in. It is either a function from a scope key to a store, or a single store. Use the function form: it gives each strand and each party its own store, so one strand's data can be removed, and it is the only form that can serve more than one party.

### Storage scope keys

cadre-core calls the provider once per **scope** and passes a **scope key**:

| Scope | Key | Minted by |
|---|---|---|
| A strand | The strand id | The node that founded the strand, which may be another machine |
| The control database | `control-` followed by the lowercase hex of the party id's UTF-8 bytes | `controlStorageScope(partyId)` in `storage-scope.ts` |

**A scope key is opaque and already safe as a name.** Every key stays within `[a-z0-9._-]`, so it can be placed directly in a file path or a database name. The set has no uppercase letters because Windows and macOS file names ignore case. Do not parse a key; `controlStorageScope` and `isControlStorageScope` mint and recognise the control key.

**The control scope is per party.** Two parties on one device ask for two keys and must get two stores. A node started for one party over the other's store would read that party's owners and machines as its own.

A party id is arbitrary text, so the control key encodes it. A strand id arrives by replication from whichever node founded the strand, so it is checked instead: `assertStrandScopeKey` runs at every strand launch and refuses an id that is not a safe name of at most 128 characters or that starts with `control-`. The refusal is `InvalidStrandIdError`, and the watcher does not retry that strand.

### When the provider is called

The provider is called once per scope per runtime: for the control scope once per `CadreNode.start()`, and for a strand once per launch. cadre-core keeps the returned store while that runtime lives, so a wake from hibernation reuses it and its warm cache.

After `stopStrand`, or a `stop()` followed by `start()`, the provider is called again for the scope and must return a store over the same durable data, as the same object or a new one. cadre-core never closes what the provider returned; closing the handle is the embedder's job once the node has stopped.

### The storage cache

A cold start of a control database or a strand reads the same few blocks many times over, so cadre-core wraps every provided store in Optimystic's write-through cache through one helper, `wrapStorageWithCache` in `packages/quereus-plugin-sereus/src/cached-storage.ts`. `MemoryRawStorage`, and a store with its own read cache such as React Native's `LevelDBRawStorage`, pass through unwrapped.

The cache is correct only if every write to a backend goes through it. An embedder therefore provides one store per path and runs one process per store: two store objects over one directory or database would each have a cache that misses the other's writes. Call sites in this repository wrap every store with `wrapStorageWithCache` and release it with `disposeStorageCache`; the module comment gives the rules.

### Available storage implementations

| Package | Class | Environment |
|---|---|---|
| `@optimystic/db-p2p` | `MemoryRawStorage` | Any. Nothing persists; for tests. |
| `@optimystic/db-p2p-storage-fs` | `FileRawStorage` | Node.js |
| `@optimystic/db-p2p-storage-rn` | `LevelDBRawStorage` | React Native, over `rn-leveldb` |
| `@optimystic/db-p2p-storage-ns` | `SqliteRawStorage` | NativeScript |
| `@optimystic/db-p2p-storage-web` | `IndexedDBRawStorage` | Browser |

A backend whose open call is asynchronous (IndexedDB, SQLite) cannot be returned directly, because the provider is synchronous. `lazyRawStorage` from `@serfab/cadre-core/edge-node` wraps an asynchronous opener in a store that opens on first use.

## The edge node

An app on a phone or in a browser tab does not construct `CadreNode` itself. It calls `createEdgeNode(platform)` from `@serfab/cadre-core/edge-node`, which builds, starts, stops and rebuilds the node over the app's key store and storage. It is a subpath export so that server programs never load it. The [API guide](../api.md) lists its calls; handlers registered with `on` stay subscribed across every node it builds.

```typescript
import { createEdgeNode } from '@serfab/cadre-core/edge-node';

const edge = createEdgeNode({ keyStore, storage });
edge.on('strand:discovered', ({ strandId, strand }) => {
	// claim the strand: edge.node?.addStrand(...)
});
const node = await edge.start({ partyId, bootstrapAddrs: [], relayAddrs });
```

`start` takes `EdgeNodeOptions` (`edge-node/options.ts`): the party id, bootstrap addresses and relay addresses, and optionally `origin`, which says whether the app founded the party or joined it ([A joined party never runs owner genesis](apps.md#a-joined-party-never-runs-owner-genesis)).

### What the edge node does for the app

- **Runs transitions one at a time.** Start, stop, restart, join and dissolve each open or close the stores the others use, so they run in call order. A second start joins the one in progress.
- **Cleans up a failed start.** It closes everything the start opened and reports `failed`, and the next call starts afresh.
- **Builds the configuration** (`buildEdgeNodeConfig`): the `device` class, every strand admitted, the identity from the key store, durable node-local stores, and no hibernation timer, because the app's lifecycle code hibernates strands when it goes to the background.
- **Sets the network for a device that cannot accept connections.** It listens on nothing unless the platform names an address. Relays go through `network.relayAddrs` with `requireRelay: false`, so the control node and every strand node reserve on them and the node still starts when the relay is unreachable.
- **Settles the owner key, within a bound.** On a party the app founded it seats the founding owner key (`runOwnerGenesis`); on a party it joined it wires the owner slot's key only if the party lists it (`wireJoinedOwnerKey`). The start waits at most 60 seconds for either step by default and then succeeds without it.
- **Remembers the last start**, so the app's launch code, or a push wake into a killed process, can start the node unattended. A node the user stopped stays stopped.
- **Moves the app between parties** ([An app joins an existing cadre](apps.md#an-app-joins-an-existing-cadre)).

### What the platform supplies

`EdgeNodePlatform` (`edge-node/platform.ts`) has two required members:

- **`keyStore`**, a cadre-core `KeyStore` for everything secret: the identity, the owner key, the joined-strand records and the strand-move records.
- **`storage`**, an `EdgeNodeStorage`: an `id` that names the storage, a raw block store per scope (`rawStorage`), a node-local key-value store for the saved start and per-party records (`nodeLocal`), `destroyScope` for deleting a scope's data, and `close`, which the edge node calls on every stop.

`storage` has two optional members. `offlineJournal` enables [offline mode](../strands/writes.md#offline-mode); without it `EdgeNode.setStrandOfflineMode` throws an `Error`. `trustedOwnerSlot` puts the trusted-owner anchor in a more tamper-resistant store than the node-local one.

The other members are optional: `transports` (default WebSocket and circuit relay), `listenAddrs`, `noiseCrypto`, `allowPrivateDial` (default `true`: the node may dial loopback, private and plain `ws://` addresses, which libp2p's browser and React Native builds otherwise refuse), and `configure`, which may change anything in the finished `CadreNodeConfig`.

### Who runs it

The React Native kit's `createPhoneNode` (`@serfab/cadre-rn/phone-node`) is the edge node over `expo-secure-store` and `rn-leveldb`. The browser reference app runs it over IndexedDB (`web-edge-platform.ts`) and the NativeScript reference app over SQLite (`ns-edge-platform.ts`).

## Limits and accepted tradeoffs

- **Storage quotas are not enforced.** `storage.quotaBytes` is accepted and nothing reads it, so a `server`-class node stores every strand its filter admits. This is acceptable while a party has a handful of strands; if always-on nodes come to host hundreds, the options are per-strand quotas or a narrower default filter (ticket `5-quota-enforcement`).
- **cadre-core configures no storage rings.** The `server` class switches Optimystic's Arachnode subsystem on with its defaults and passes it no ring or capacity settings. Where cadre-core's own join catch-up runs, it turns Optimystic's rebalance reaction off, so a node stays in the ring it started in (ticket `5-ring-zulu-storage-rings`).
- **A machine's published always-on declaration is unverified.** Other nodes use it only to choose whom to dial first, so a false declaration costs only wasted dials.
- **The single-store provider form has not been run end to end.** Every provider in this repository returns a store per scope. One `IRawStorage` shared by all scopes is exercised only with in-memory stores, which are never cached (ticket `debt-shared-store-provider-never-exercised-end-to-end`).
- **Node-local records are written by one process at a time.** Each save replaces the whole record, and writes are ordered only within a process, so two processes sharing one slot for one party overwrite each other's entries. Every backend here gives each node its own directory or database, except for two browser tabs on one origin.
- **A long party id can exceed a file-name limit.** The control scope key is twice the party id's UTF-8 length plus eight characters, so a party id over about 120 bytes passes the 255-byte limit on one path component. Party ids are UUIDs; if long ids appear, the key should hash the party id.
- **An identity key file has no integrity check.** `cadre-cli` rejects a file that is structurally not a key, but a changed byte inside the key payload decodes as a different valid key and the node starts under an unexpected peer id (ticket `debt-identity-key-file-has-no-integrity-check`).
- **An edge node's relay supervisor runs while the app is in the background.** Hibernation stops strands, not the control node, so a named relay is checked every few seconds and redialed while the reservation is down. Stopping the supervisor would leave a device that can no longer be invited, with nothing reporting it. If battery use becomes a problem, lengthen the intervals in cadre-core.
