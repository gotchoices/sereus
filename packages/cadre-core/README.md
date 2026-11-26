# @serfab/cadre-core

The library that runs a Sereus cadre node. A node connects one machine to its party's private control network, starts the strands the party takes part in, and gives the app each strand as a SQL database.

In Sereus a **party** is a person or organisation, its **cadre** is the set of machines it runs, and a **strand** is an invitation-only SQL database shared among parties. [Concepts](https://github.com/gotchoices/sereus/blob/master/docs/concepts.md) defines the terms used here, and [Getting started](https://github.com/gotchoices/sereus/blob/master/docs/getting-started.md) walks through a first app with two parties.

## Prerequisites

- **An ES module project.** The package ships ES modules only. It runs on Node.js 20.19 or later, in browsers, and in React Native and NativeScript apps.
- **Storage for the platform.** cadre-core stores data through Optimystic's `NodeStorage` and does not bundle a durable implementation; see [Storage](#storage).

## Install

```bash
npm install @serfab/cadre-core
```

The [quick start](#quick-start) also imports two packages directly:

```bash
npm install @optimystic/db-p2p @optimystic/quereus-plugin-crypto
```

## Quick start

This script starts one node for a new party on Node.js, makes it the owner of its cadre, founds a strand, and reads back a row it wrote. It keeps everything in memory, so each run starts a new party.

```ts
import { CadreNode, InMemoryKeyStore, createOwnerKey, signSchema } from '@serfab/cadre-core';
import { memoryNodeStorage, type NodeStorage } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';

// The sApp: an app schema signed by its author. The author's public key is the sApp id.
const authorKey = generatePrivateKey('ed25519', 'base64url') as string;
const sApp = {
	version: '1.0.0',
	schemaVersion: 1,
	schema: 'table Note (Id text primary key, Body text not null);',
};
const sAppConfig = {
	id: getPublicKey(authorKey, 'ed25519', 'base64url', 'base64url') as string,
	...sApp,
	signature: signSchema(sApp, authorKey),
};

// One set of stores per scope: one for the control database, one for each strand.
// Memoised because `open` is called again for a scope after its strand stops.
const stores = new Map<string, NodeStorage>();
const openScope = async (scope: string): Promise<NodeStorage> => {
	let storage = stores.get(scope);
	if (!storage) {
		storage = memoryNodeStorage();
		stores.set(scope, storage);
	}
	return storage;
};

const keyStore = new InMemoryKeyStore();
const node = new CadreNode({
	keyStore,
	controlNetwork: { partyId: crypto.randomUUID(), bootstrapNodes: [] },
	nodeClass: 'device',
	storage: { open: openScope },
});
await node.start();

// A new cadre has no owner. Create an owner key, seat it as the first owner, and sign with it.
const owner = await createOwnerKey(keyStore);
await node.getControlDatabase()!.ensureOwnerKey(owner.publicKey);
await node.useOwnerSigner(owner);

// Publish the strand to the party and start it here.
const { instance } = await node.foundStrand({ strandId: 'notes', sAppConfig });

// The strand is a Quereus database. App tables are in the App schema.
const db = instance.database!.getDatabase();
await db.exec("insert into App.Note (Id, Body) values ('1', 'hello')");
for await (const row of db.eval('select Body from App.Note')) {
	console.log(row.Body); // hello
}

await node.stop();
```

Expected output is the line `hello`. Set `DEBUG=sereus:*` to see what the node does on the way.

An app on a phone or in a browser does not construct `CadreNode` itself. It calls `createEdgeNode` from `@serfab/cadre-core/edge-node`, which builds the node over the app's key store and storage, creates the owner key on first run, and remembers how to start again. See [The edge node](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#the-edge-node).

## Configuration

`new CadreNode(config)` takes a `CadreNodeConfig`, declared in [`src/types.ts`](src/types.ts). [Configuration](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#configuration) describes every option group. The options most embedders set:

| Option | Meaning |
| --- | --- |
| `controlNetwork.partyId` | The party this node serves. The app mints it once, for example as a UUID, and reuses it on every start. |
| `controlNetwork.bootstrapNodes` | Multiaddrs of the party's other machines to dial at start. Empty for the first machine. |
| `nodeClass` | `'device'` or `'server'`; see [Node class and roles](#node-class-and-roles). |
| `roles` | Per-role overrides of what the class means; see [Node class and roles](#node-class-and-roles). |
| `strandFilter` | Which of the party's strands this node runs; see [Strand filter](#strand-filter). |
| `storage.open`, `storage.allotmentBytes` | Where this node's data is kept, and how much of the machine each network it serves was given; see [Storage](#storage). |
| `keyStore` | Where the node's identity key and other secrets are kept. With neither this nor `privateKey`, the node gets a new peer id on every start. `InMemoryKeyStore` is for tests; `FileKeyStore` from `@serfab/cadre-core/key-store-file` is the Node.js backend. |
| `network` | Listen addresses, transports and relays. On Node.js the default listens on TCP. A browser or phone passes WebSocket and circuit-relay transports with `listenAddrs: []`. |
| `requireSignedSchemas` | Default `true`: an sApp config without a valid author signature is refused. Set `false` only for development. |

### Node class and roles

`nodeClass` says what kind of machine this node runs on. `'device'` is a phone, a laptop or a browser tab running an app, connected some of the time. `'server'` is an always-on machine: it also runs a relay server by default and keeps a copy of every strand its `strandFilter` admits, including strands no app on that machine uses. Under either preset a node stores the data of the strands it runs; the `strandCohortMember` role below is what changes that.

The class is only the preset for four decisions, the node's **roles**, which `roles` sets one at a time:

```ts
roles: {
	alwaysOn: true,            // declare that this machine stays running and reachable
	overlayTier: 'core',       // FRET resource tier: 'edge' or 'core'
	reactivity: 'subscriber',  // 'forwarder' may carry other subscribers' change notifications
	strandCohortMember: true,  // hold and sign the blocks of the strands this node runs
}
```

A role left out takes its preset's value (`device`: `false`, `'edge'`, `'forwarder'`, `true`; `server`: `true`, `'core'`, `'forwarder'`, `true`). A misspelled role name, or a value outside a role's own set, throws. `NODE_ROLE_PRESETS` and `resolveNodeRoles` are exported for a program that wants to show an operator what a config resolves to. See [Node classes](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#node-classes).

`strandCohortMember: false` makes the node a **client** of every strand it runs: it reads and writes the strand through the machines that store it, and is left out of every cluster, so it is never on the path of another machine's save. It still opens each strand scope's storage — a client keeps its own blob records, blob pieces and clock high-water mark — and never reads the block store beside them. It cannot host storage replicas, so `hostUnclaimedStrands` defaults to `false` on it and an explicit `true` throws naming both settings. A client needs a serving machine reachable to open or found a strand. See [A node that holds no strand blocks](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#a-node-that-holds-no-strand-blocks).

### Strand filter

`strandFilter` limits which of the party's strands the node runs. An app that should run only its own strands filters by its sApp id.

```ts
strandFilter: { mode: 'all' }                        // every strand of the party (the default)
strandFilter: { mode: 'sAppId', sAppId }             // strands of one sApp
strandFilter: { mode: 'strandId', strandId: 'notes' } // one strand
strandFilter: { mode: 'none' }                       // the control network only
```

`sAppId` is the sApp author's public key in base64url, the same value as `SAppConfig.id`. It is not a reverse-DNS application name. See [Strand filtering](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#strand-filtering).

### Storage

`storage.open` is an async function from a scope key to Optimystic's `NodeStorage` — the blocks, the node's own key-value records and its blob pieces, as one value. cadre-core calls it once for the control database and once for each strand the node starts.

```ts
import { fileNodeStorage } from '@optimystic/db-p2p-storage-fs';
import { FileKeyStore } from '@serfab/cadre-core/key-store-file';

const node = new CadreNode({
	keyStore: new FileKeyStore('/var/lib/my-app/keys'),
	controlNetwork: { partyId, bootstrapNodes: [] },
	nodeClass: 'server',
	storage: { open: async (scope) => fileNodeStorage(`/var/lib/my-app/data/${scope}`) },
});
```

- **The scope key is safe to use as a name.** It is a strand id, or `control-` followed by a hex encoding of the party id. Every key stays within `[a-z0-9._-]`, so it can go straight into a path or a database name. Do not parse it.
- **Return the same location for the same key.** `open` is called again for a scope after its strand stops or the node restarts, and must return storage over the same durable data.
- **Keep the control scope per party.** Two parties on one device must get two control stores. There is no form of this option that hands one value to every scope.
- **Close the storage yourself.** cadre-core never closes what `open` returned; keep the `OpenNodeStorage` each factory gives back and close it after the node has stopped.
- **`allotmentBytes` is per network, not per machine.** It reaches the control node and every strand node unchanged, so N strands plus the control network can hold up to (N+1) times that figure.

| Package | Opener | Platform |
| --- | --- | --- |
| `@optimystic/db-p2p` | `memoryNodeStorage()` | Any; nothing persists |
| `@optimystic/db-p2p-storage-fs` | `fileNodeStorage(basePath)` | Node.js |
| `@optimystic/db-p2p-storage-rn` | `levelDbNodeStorage(db)` | React Native |
| `@optimystic/db-p2p-storage-ns` | `sqliteNodeStorage(db)` | NativeScript |
| `@optimystic/db-p2p-storage-web` | `indexedDbNodeStorage(db)` | Browsers |

See [A node's storage](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node-storage.md) for the read cache cadre-core leases over a block store, the rules that follow from it, and what the allotment bounds.

## What the node keeps, and where

cadre-core writes no files of its own. Everything durable goes through an object the embedder supplies:

- **Blocks, blob records, blob pieces and the node's own ledgers** of the control database and of each strand go to the storage `storage.open` returns for that scope.
- **Secrets** go to `keyStore`: the node's identity key, the owner key, and the record of strands joined from other parties.
- **Node-local state** goes to the stores named in the config (`trustedOwners`, `bootstrapPeers`, `enrolledMachines`, `strandNetworkState`). Each defaults to memory. The file-backed versions are Node.js subpath imports such as `@serfab/cadre-core/trusted-owner-store-file`.

A node that keeps these in memory forgets which owner keys it trusts and which machines to dial when the process exits. See [Node-local state](https://github.com/gotchoices/sereus/blob/master/docs/cadre/node.md#node-local-state).

## API map

The [cadre-core API guide](https://github.com/gotchoices/sereus/blob/master/docs/api.md) lists every call an app makes, what each one promises and where its mechanism is explained.

| Task | Calls | Guide section |
| --- | --- | --- |
| Create and run a node | `new CadreNode`, `start`, `stop`, `createEdgeNode` | [Creating a node](https://github.com/gotchoices/sereus/blob/master/docs/api.md#creating-a-node) |
| Hold and manage owner keys | `createOwnerKey`, `useOwnerSigner`, `isOwner`, `addOwner`, `createOwnerGrant` | [Owner keys](https://github.com/gotchoices/sereus/blob/master/docs/api.md#owner-keys) |
| Add a machine to the cadre | `createCadreInvitation`, `redeemCadreInvitation`, `claimNode`, `addDrone`, `rentNode` | [Adding a machine](https://github.com/gotchoices/sereus/blob/master/docs/api.md#adding-a-machine) |
| List and remove machines | `listMachines`, `planMachineRemoval`, `removeMachine` | [Listing and removing machines](https://github.com/gotchoices/sereus/blob/master/docs/api.md#listing-and-removing-machines) |
| Found a strand | `foundStrand`, `signSchema` | [Founding](https://github.com/gotchoices/sereus/blob/master/docs/api.md#founding) |
| Invite another party | `createOpenInvitation`, `publishFormationInvite`, `encodeInvitation` | [Inviting another party](https://github.com/gotchoices/sereus/blob/master/docs/api.md#inviting-another-party) |
| Join a strand | `formStrand`, `requestJoin`, `addStrand`, the `strand:discovered` event | [Joining](https://github.com/gotchoices/sereus/blob/master/docs/api.md#joining) |
| Read and write | `getStrand`, `instance.database.getDatabase()`, `setStrandOfflineMode` | [The strand's database](https://github.com/gotchoices/sereus/blob/master/docs/api.md#the-strands-database) |
| Stop or leave a strand | `stopStrand`, `unpublishStrand`, `forgetJoinedStrand` | [Stopping and leaving](https://github.com/gotchoices/sereus/blob/master/docs/api.md#stopping-and-leaving) |
| Administer a closed strand | `revokeMember`, `addMemberByManager`, `leaveStrand` | [Membership of closed strands](https://github.com/gotchoices/sereus/blob/master/docs/api.md#membership-of-closed-strands) |
| Approve joins from outside the party | `enrollValidationKey`, `signFormationApproval` | [Formation approval hook](https://github.com/gotchoices/sereus/blob/master/docs/formation-approval-hook.md) |
| React to changes and failures | `node.on(...)`, the error classes | [Events](https://github.com/gotchoices/sereus/blob/master/docs/api.md#events), [Errors](https://github.com/gotchoices/sereus/blob/master/docs/api.md#errors) |

## Entry points

| Import | Use |
| --- | --- |
| `@serfab/cadre-core` | Everything that runs on every platform |
| `@serfab/cadre-core/edge-node` | `createEdgeNode`, for phones and browsers |
| `@serfab/cadre-core/key-store-file`, `/trusted-owner-store-file`, `/bootstrap-peer-store-file`, `/enrolled-machine-store-file`, `/strand-network-state-file` | File-backed stores, Node.js only |
| `@serfab/cadre-core/push-node` | FCM and APNs senders, Node.js only |
| `@serfab/cadre-core/node-default-transports`, `/primary-lan-address` | Node.js transport list and LAN address probe |

## Related documentation

- [Architecture](https://github.com/gotchoices/sereus/blob/master/docs/architecture.md): how the control network, strands and nodes fit together.
- [Writing an app schema](https://github.com/gotchoices/sereus/blob/master/docs/schema-guide.md): how to write the Quereus schema an sApp runs.
- [Writing to a strand](https://github.com/gotchoices/sereus/blob/master/docs/strands/writes.md): commit durability and offline mode.
- [Running a node in a React Native app](https://github.com/gotchoices/sereus/blob/master/docs/platforms/react-native.md), [in a NativeScript app](https://github.com/gotchoices/sereus/blob/master/docs/platforms/nativescript.md) and [in a browser](https://github.com/gotchoices/sereus/blob/master/docs/platforms/browser.md).
- [`@serfab/cadre-cli`](https://github.com/gotchoices/sereus/blob/master/packages/cadre-cli/README.md) runs a node from the command line without writing code.

## License

MIT
