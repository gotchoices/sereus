# Getting started

This walkthrough takes an app developer from an empty project to a program in which two parties share a SQL database. Party A starts a node, founds a strand and issues a formation invitation. Party B starts a node and joins with the invitation. Each then reads rows the other wrote. Party, cadre, strand, sApp and the other terms used here are defined in [Concepts](concepts.md).

The code is adapted from the first test of `packages/integration-tests/src/scenarios/strand-formation-cross-party-seed.integration.ts`. The node configuration follows `controlNodeConfig` in `packages/integration-tests/src/harness/node-fixtures.ts`, and the owner-key step follows `packages/reference-app-web/e2e/fixtures/formation-responder.ts`. To run the scenario itself, check out the `optimystic` and `quereus` repositories beside this one (the root `package.json` links to them), then:

```sh
yarn install
yarn build
yarn workspace @serfab/integration-tests exec vitest run strand-formation-cross-party-seed
```

## What the walkthrough runs

Both parties run in one Node.js process and reach each other over WebSocket on the loopback interface, as they do in the scenario. The only thing that passes from A to B outside the network is the invitation text, so the same calls apply when the parties are on different machines. [Two machines instead of one process](#two-machines-instead-of-one-process) lists what changes.

The walkthrough constructs `CadreNode` directly, because that is the class a Node.js program uses and it needs only a configuration object. An app on a phone or in a browser calls `createEdgeNode` from `@serfab/cadre-core/edge-node` instead. The app passes an `EdgeNodePlatform` (its key store and its storage), and the edge node builds the configuration and performs the owner-key step itself. `edgeNode.start(options)` resolves to a `CadreNode`, so every call from founding the strand onward is the same. See [The edge node](cadre/node.md#the-edge-node).

Keys and data are held in memory, so everything is gone when the process exits. [Start a node for party A](#2-start-a-node-for-party-a) names the durable replacements.

## 1. Install

`@serfab/cadre-core` needs Node.js 20.19 or later, the floor its `@noble` dependencies declare. The script is an ES module that uses top-level `await`, so it needs a file named `.mjs` (or `"type": "module"` in `package.json`).

```sh
npm install @serfab/cadre-core @optimystic/db-p2p @optimystic/quereus-plugin-crypto @libp2p/websockets @libp2p/circuit-relay-v2
```

`@serfab/cadre-core` already depends on the other four packages. The script imports them directly, so the project declares them too. Keep each within the range `packages/cadre-core/package.json` declares, so that one copy of each is installed.

Create `two-parties.mjs` with the imports. Each later stage appends to this file, and `node two-parties.mjs` runs it.

```js
import { randomUUID } from 'node:crypto';
import {
	CadreNode,
	InMemoryKeyStore,
	createOwnerKey,
	loadOwnerSigner,
	signSchema,
	ed25519PublicKeyFromPrivate,
} from '@serfab/cadre-core';
import { memoryNodeStorage } from '@optimystic/db-p2p';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
```

## 2. Start a node for party A

```js
function nodeConfig(partyId, keyStore) {
	return {
		controlNetwork: { partyId, bootstrapNodes: [] },
		nodeClass: 'device',
		strandFilter: { mode: 'all' },
		keyStore,
		storage: { open: async () => memoryNodeStorage() },
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			listenAddrs: ['/ip4/127.0.0.1/tcp/0/ws'],
		},
	};
}

async function becomeOwner(node, keyStore) {
	const owner = (await loadOwnerSigner(keyStore)) ?? (await createOwnerKey(keyStore));
	await node.getControlDatabase().ensureOwnerKey(owner.publicKey, 'laptop');
	await node.useOwnerSigner(owner);
}

const aKeys = new InMemoryKeyStore();
const a = new CadreNode(nodeConfig(randomUUID(), aKeys));
await a.start();
await becomeOwner(a, aKeys);

console.log('A control addresses:', a.getMultiaddrs());
console.log('A is an owner:', await a.isOwner());
```

`start()` brings up the party's control network: a libp2p node and the control database. The script should print a loopback WebSocket address ending in `/p2p/<A's peer id>`, then `true`.

The configuration fields, all described in `packages/cadre-core/src/types.ts` and in [Configuration](cadre/node.md#configuration):

- **`controlNetwork.partyId`** names the party. The control database's storage is keyed by it, so an app generates it once and saves it. `bootstrapNodes` is empty because this node is the party's first.
- **`nodeClass: 'device'`** says this node runs inside an app, connected some of the time. An always-on node sets `'server'`. See [Node classes](cadre/node.md#node-classes).
- **`keyStore`** holds the node's identity key, which `start()` generates on first use, and the owner key in a slot of its own. `InMemoryKeyStore` forgets both at exit. A Node.js program that must keep them uses `FileKeyStore` from `@serfab/cadre-core/key-store-file`. See [Node key material and the KeyStore](cadre/node.md#node-key-material-and-the-keystore).
- **`storage.open`** is called once for the control database and once for each strand, with a scope key that is safe to use as a directory name, and returns all three of that scope's stores as one value. A Node.js program that must keep its data returns `fileNodeStorage(dir)` from `@optimystic/db-p2p-storage-fs` for each scope. See [Storage](cadre/node.md#storage).
- **`network`** gives the node a WebSocket listener on the loopback interface, on a port the operating system picks. The circuit-relay transport lets a node dial through a relay; nothing here uses one.

`becomeOwner` is the owner-key step. A new party has no owner key, and founding a strand and publishing an invitation are owner-signed writes that throw without one. `ensureOwnerKey` inserts the party's first owner key and returns `false`, changing nothing, when the party already has one. `useOwnerSigner` makes the node sign with that key from then on. See [Owner keys](cadre/owner-keys.md).

## 3. Declare an app schema and found a strand

```js
const schema = `
table Note (
	Id text primary key,
	Author text not null,
	Body text not null
);
`;

const authorPrivateKey = generatePrivateKey('ed25519', 'base64url');
const signedFields = { schema, version: '0.1.0', schemaVersion: 1 };
const sApp = {
	id: ed25519PublicKeyFromPrivate(authorPrivateKey),
	...signedFields,
	signature: signSchema(signedFields, authorPrivateKey),
};

const strandId = `notes-${randomUUID()}`;
const founded = await a.foundStrand({ strandId, type: 'o', sAppConfig: sApp });
const aDb = founded.instance.database.getDatabase();

console.log('founded:', founded.founded, 'status:', founded.instance.status);
```

The script should print `founded: true status: active`.

`sApp` is the **sApp config** an app hands to cadre-core for every strand it opens. `schema` is the body of `declare schema App { … }`; cadre-core adds the wrapper, so the table is addressed as `App.Note`. `id` is the public key of the sApp's author, and `signature` is the author's signature over `schema`, `version` and `schemaVersion`. A node refuses a config whose signature does not verify before it starts the strand.

The script generates an author key and signs at run time only to stay self-contained. A shipped app embeds the `id` and a `signature` computed once, and the author's private key stays off users' devices. Every party must pass the same config, byte for byte in `schema`. `schemaVersion` rises with every schema change; see [Writing an app schema](schema-guide.md) and [App schemas](strands/app-schema.md).

`foundStrand` publishes the strand's row in A's control database and starts the strand on this node as its founder. A running strand has its own libp2p node, the **strand node**, with its own peer id and listen port, and its own database. A strand id is 1 to 128 characters of `[a-z0-9._-]` and does not begin with `control-`, because it becomes a storage name.

`type: 'o'` founds an open strand. A closed strand takes `type: 'c'` and a `memberPrivateKey` from `generateStrandMemberKey()`; see [Closed-strand membership](strands/membership.md). [Founding a strand](strands/lifecycle.md#founding-a-strand) describes what the founder writes.

## 4. Create a formation invitation

```js
const invitation = await a.createOpenInvitation(sApp.id, 24 * 60 * 60 * 1000);
await a.publishFormationInvite(invitation.token, sApp.id, {
	strandId,
	expiresAtMs: invitation.expiration.getTime(),
	totalUses: 1,
});
const invitationText = a.encodeInvitation(invitation);

console.log('invitation:', invitationText);
```

The script should print one long base64url string.

`createOpenInvitation` mints a token and returns the invitation: the token, the sApp id, an expiration and A's control addresses. `publishFormationInvite` writes the owner-signed `FormationInvite` row for that token into A's control database. That row is what makes the token redeemable. Here it binds the token to `strandId` and allows one use. `encodeInvitation` turns the invitation into text to send as a link or a paste. The text is not sized for a QR code: it can name up to twelve addresses of the party's other machines ([Inviting and joining](strands/formation.md#limits-and-accepted-tradeoffs)).

The text is a bearer credential: whoever holds it can redeem it until it is used up or expires. [Formation invitations](strands/formation.md#formation-invitations) covers the other options, including an approval hook that decides each redemption.

`foundStrand` also accepts a `formationInvite` field, which publishes the invitation in the same control transaction and owner approval as the strand's row. An app that always invites at founding mints the invitation first and passes it there.

## 5. Party B starts a node and joins

```js
const bKeys = new InMemoryKeyStore();
const b = new CadreNode(nodeConfig(randomUUID(), bKeys));
await b.start();
await becomeOwner(b, bKeys);

const formed = await b.formStrand(b.decodeInvitation(invitationText), {
	partyId: b.partyId,
	purpose: 'getting started',
});
const joined = await b.addStrand({
	strandRow: {
		Id: formed.strandId,
		MemberPrivateKey: null,
		Type: 'o',
		FounderOwnerKey: null,
		FounderPeerId: null,
	},
	sAppConfig: sApp,
});
const bDb = joined.database.getDatabase();

console.log('same strand:', formed.strandId === strandId);
console.log('A strand addresses:', formed.strandAddrs);
console.log('B status:', joined.status);
```

The script should print `same strand: true`, at least one loopback address whose peer id is not A's control peer id, and `B status: active`.

B is a separate party with its own party id, control network and owner key. It shares nothing with A except the invitation text and the sApp config.

`formStrand` dials the control addresses in the invitation and presents the token with a disclosure, the second argument, which is what B chooses to tell A about itself. A's node checks the token against its `FormationInvite` row, records the use, and answers with the strand id and the addresses of its strand node. `formStrand` makes one attempt and throws `FormationRejectedError` or `FormationUnreachableError` when it fails. `requestJoin` is the call that keeps trying; see [Joining while the inviter is offline](strands/formation.md#joining-while-the-inviter-is-offline).

`addStrand` starts the strand on B as a joiner. B builds the row by hand because another party founded the strand, and the null founder fields mean B does not found it. B's strand node dials the addresses formation returned. `addStrand` resolves once B has received the strand's header row and read each of its tables from A, which is B's **first sync**, so B may write as soon as the call returns. If no member answers in time (six minutes by default) the call rejects with `StrandAwaitingFirstSyncError` and may be repeated. See [Joining: no writes before the first sync](strands/formation.md#joining-no-writes-before-the-first-sync).

## 6. Read and write with SQL

```js
async function until(check, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error('timed out waiting for a row to arrive');
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

async function bodyOf(db, id) {
	const row = await db.get('select Body from App.Note where Id = ?', [id]);
	return row?.Body;
}

const insertNote = 'insert into App.Note (Id, Author, Body) values (?, ?, ?)';

await aDb.exec(insertNote, ['n1', 'a', 'written on A']);
await until(async () => (await bodyOf(bDb, 'n1')) === 'written on A');

await bDb.exec(insertNote, ['n2', 'b', 'written on B']);
await until(async () => (await bodyOf(aDb, 'n2')) === 'written on B');

for await (const row of aDb.eval('select Id, Author, Body from App.Note order by Id')) {
	console.log('A reads:', row.Id, row.Author, row.Body);
}

await b.stop();
await a.stop();
```

The script should print `A reads: n1 a written on A` and `A reads: n2 b written on B`.

`getDatabase()` returns the strand's Quereus `Database`. `exec` runs a statement, `get` returns the first row or `undefined`, and `eval` iterates over rows. The app's tables are in the `App` schema. The strand's own tables, such as its header and membership, are in the `Strand` schema of the same database.

A row written on one node is readable on the other once it has replicated there, which is why the script polls. [A commit's durability](strands/writes.md#a-commits-durability) states what a resolved write guarantees, and [Change notifications](strands/app-schema.md#change-notifications) describes how an app is told of another member's write without polling.

## Two machines instead of one process

Each party runs its own program. The sApp config ships inside the app, and only the invitation text travels between the parties. Four things change:

- **A must be reachable.** The invitation carries A's control addresses and formation returns A's strand addresses, and here both are loopback addresses. On a machine B can dial, set `network.listenAddrs` to an address B can reach. A phone or a browser tab cannot listen, so it names a relay in `network.relayAddrs` and is reached through it. See [Relays](network/relay.md).
- **A must be running when B redeems.** `formStrand` fails if no machine named in the invitation answers. `requestJoin` records the request and retries.
- **Keys and data must be kept.** Replace `InMemoryKeyStore` and `memoryNodeStorage` with the durable backends named under [Start a node for party A](#2-start-a-node-for-party-a), and give the node durable stores for the records listed in [Node-local state](cadre/node.md#node-local-state).
- **A restarted app re-attaches its strands.** After `start()`, the node reports each of the party's strands that the app has not yet claimed through the `strand:discovered` event and `getDiscoveredStrands()`. The app subscribes first, then reads that map, and calls `addStrand` with its sApp config for each. See [Reactive strand management](strands/lifecycle.md#reactive-strand-management).

## Where to go next

- [Concepts](concepts.md): the model and the glossary.
- [Writing an app schema](schema-guide.md): tables, constraints and access rules for a real app.
- [cadre-core API guide](api.md): every call used here, what each promises, and the node's events and errors.
- [Strands: model and lifecycle](strands/lifecycle.md): what a strand is and how it is founded, joined and stopped.
- [Adding and removing machines](cadre/membership.md): giving a party a second device, so that its strands survive the loss of the first.
- [Writing to a strand](strands/writes.md): durability and offline mode.
- Platform guides for embedding a node in an app: [React Native](platforms/react-native.md), [NativeScript](platforms/nativescript.md) and [the browser](platforms/browser.md). [The reference apps](platforms/reference-apps.md) show the same flow with a user interface.
