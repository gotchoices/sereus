# Running a node in a browser

This document is for a developer who embeds a cadre node in a web page. It covers what the page supplies to cadre-core's edge node, how the node's data is laid out in IndexedDB, how a tab that binds no socket becomes reachable through a relay, and what a bundler must alias. All of it is taken from `packages/reference-app-web`, a Svelte and Vite single-page app.

Related: [The cadre node](../cadre/node.md) · [Relays](../network/relay.md) · [React Native](react-native.md) · [NativeScript](nativescript.md) · [The reference apps](reference-apps.md) · [reference-app-web README](../../packages/reference-app-web/README.md)

## What the app must provide

A tab runs the same edge node as a phone app: `createEdgeNode(platform)` from `@serfab/cadre-core/edge-node` ([The edge node](../cadre/node.md#the-edge-node)). The edge node builds, starts, stops and rebuilds the `CadreNode`, runs the owner step, saves the start for the next load, and joins another cadre. The page supplies an `EdgeNodePlatform` (`packages/cadre-core/src/edge-node/platform.ts`). The reference app's is `src/lib/web-edge-platform.ts`:

```ts
// Condensed from web-edge-platform.ts; the helpers are in strand-storage.ts and node-local-slots.ts.
createEdgeNode({
	keyStore: nodeLocalKeyStore(openNodeLocal),
	storage: {
		id: 'sereus-web',
		rawStorage: (scope) => lazyRawStorage(() => openStore(scope), durability),
		offlineJournal: (scope) => openJournal(scope),
		destroyScope: (scope) => deleteStore(scope),
		nodeLocal: () => nodeLocal,
		close: () => closeStores(),
	},
	transports: (relayAddrs) => [
		webSockets(),
		circuitRelayTransport(),
		webRTC({ rtcConfiguration: { iceServers: resolveStunServers(relayAddrs) } }),
		webRTCDirect(),
	],
	listenAddrs: webrtcListenAddrs,
});
```

- **A key store and storage over IndexedDB.** `@optimystic/db-p2p-storage-web` provides the block store (`IndexedDBRawStorage`), a key-value store (`IndexedDBKVStore`) and the opener (`openOptimysticWebDb`). The page adds the glue between them and the edge node ([Storage](#storage)).
- **Browser transports.** WebSockets and the circuit-relay transport, plus the two WebRTC transports if relayed connections should upgrade to direct ones ([Transport and reachability](#transport-and-reachability)). When `transports` is omitted the edge node uses WebSockets and circuit relay only.
- **Relay addresses, if the tab is to be reachable.** The start option `relayAddrs` names the relays the node reserves on. How the page obtains the addresses is its own choice.
- **Two polyfills, loaded before any other module,** and a handful of bundler aliases ([Bundling](#bundling)).
- **Start options on every load.** A tab has no launch form. The reference app calls `EdgeNode.loadSavedStart()` when the page loads and starts the party it names; with nothing saved it creates a party id with `crypto.randomUUID()` and starts it with `origin: 'founded'`.
- **A signed app schema.** cadre-core refuses an unsigned schema by default. The reference app signs its chat schema with `signSchema` (`src/lib/chat-strand.ts`).

## Storage

### The storage bridge

cadre-core asks for storage by scope key: `controlStorageScope(partyId)` for the control database and the strand id for each strand ([Storage](../cadre/node.md#storage)). Every key is within `[a-z0-9._-]`, so the reference app's `src/lib/strand-storage.ts` concatenates it into a database name, `sereus-strand-<key>`, without escaping.

The bridge exists because the two sides disagree about timing. `EdgeNodeStorage.rawStorage` is synchronous, while `IndexedDBRawStorage` wraps a database handle that is already open, and opening is asynchronous. The platform therefore returns cadre-core's `lazyRawStorage` over an opener:

- **A database opens on its first use.** Nothing is opened ahead of a start, and a strand that the control database lists gets storage the same way as one the page adds.
- **One handle and one store per scope key.** `openHandle` shares an open that is in flight, so a strand's first read and first write do not open the database twice. The handle and its `IndexedDBRawStorage` are cached until the edge node's stop closes them (`closeStores`, the platform's `EdgeNodeStorage.close`).
- **Durability is stated before the open.** `lazyRawStorage` is asked for the store's `durability` before any database exists, so the platform reports what `IndexedDBRawStorage` will report: `'power-loss'` where the browser honours strict transactions (`supportsStrictDurability()`), otherwise `'process-crash'`.
- **A strand's offline journal shares the strand's database.** `EdgeNodeStorage.offlineJournal` returns one `IndexedDBKVStore` over the same handle, kept in the database's `kv` object store. One instance per key, because the store serves its unflushed writes from memory and a second instance would not see them ([Offline mode](../strands/writes.md#offline-mode)).
- **Deleting a scope deletes its database.** `destroyScope` closes the page's handle and calls `indexedDB.deleteDatabase`. If another tab still has the database open the browser reports `blocked`; `deleteStore` then throws `StoreDeleteBlockedError` instead of waiting, and the browser completes the deletion when that tab closes.

### Which database holds what

| Database | Holds |
|---|---|
| `sereus-strand-control` | The tab's node-local records, in the `kv` object store: the key store and the edge node's records. One per origin. |
| `sereus-strand-control-<hex of the party id>` | One party's control database blocks. |
| `sereus-strand-<strand id>` | One strand's blocks and, in `kv`, the transactions offline mode has queued. |

The first row is not a storage scope, although its name resembles the second. It holds what the node reads before it knows its party, so it cannot be named after the party. `src/lib/node-local-slots.ts` builds two stores over its `kv` object store:

- **The key store** (`EdgeNodePlatform.keyStore`). The identity is under `peer-private-key` and the owner key under `owner-private-key`, each as the libp2p protobuf bytes of an Ed25519 private key. Every other slot (joined-strand and strand-move records) is under `keystore.<slot id>`. A value that is not bytes raises `KeyStoreAccessError`; reading it as an empty slot would let the node write a new key over it. Writes are strict where the browser supports them, because a key may found a party and a key lost to a power cut would leave that party with an owner nobody holds.
- **The node-local records** (`EdgeNodeStorage.nodeLocal`), as text: the saved start (`start-options`), the dissolve marker (`dissolving-party`), and for each party the trusted-owner anchor, cold-start dial targets, enrolled-machine count and strand network state under `<record>.<partyId>`. [Node-local state](../cadre/node.md#node-local-state) lists them for every platform.

Each party's records are filed under its own id because a tab that joins another cadre switches party, and returns to the one it founded when the join fails. With one key per tab, the joined party's first save would overwrite the founded party's records.

Everything node-local is in one database so that it is cleared together. "Clear site data" removes the identity, the owner key, the joined-strand records and the anchor at once, and the tab then starts as a new node. A partial clear could leave a new identity with an old anchor.

### The saved start

The saved start names the party and how the tab came to it (`origin: 'founded' | 'joined'`, and `formerPartyId` for a party it left). The reference app reads it on every load and ignores its `autoStart` flag, because a tab always starts when the page loads. Two cases need care:

- **No record.** The tab founds a new party. Its owner key is labelled with the start option `ownerKeyLabel` (`browser` in the reference app; the edge node's default is `phone`).
- **A record the edge node cannot parse.** `loadSavedStart` logs it and returns nothing, which looks the same as a first load. The reference app checks whether the key is present and, if so, fails the start with a message instead of founding a new party, which would orphan the one the record names. The user clears the site's data to start again.

### A tab on its own

With no bootstrap address and no relay, the node forms a cadre of one. The owner step creates an owner key in the key store's owner slot and seats it as the founding owner ([Owner keys](../cadre/owner-keys.md)). A node that is alone commits its own writes, so SQL writes to a strand it founded reach IndexedDB with no other machine present, and the data is there after a reload.

The owner step is bounded and does not fail the start (`runOwnerGenesis`, 60 seconds by default). If it throws or does not finish in time, the edge node reports the owner standing as `failed` or `timed-out` and the node runs without an owner key wired for signing. Such a tab can still read and write strands it already runs, but it cannot mint invitations or publish a strand, both of which need an owner signature. A founded party runs the owner step again on every start.

## Transport and reachability

### What a tab can dial

A tab has WebSocket, circuit-relay and WebRTC transports and no TCP. It can dial any node that publishes a `/ws` or `/wss` address, a WebRTC-direct address, or a `/p2p-circuit` address on a relay it can reach. Two restrictions come from the browser, not from Sereus:

- **A page served over HTTPS cannot open a `ws://` connection to another host.** Browsers block it as mixed content. A deployed app needs relay and bootstrap addresses that are reachable over `/wss`.
- **libp2p's browser build refuses plain `ws://`, loopback and private addresses by default.** The edge node lifts that restriction (`EdgeNodePlatform.allowPrivateDial`, default `true`), because a home machine on the same network, a development drone on `127.0.0.1` and a self-run relay without TLS are all such addresses. Only the dial is permitted: the connection is still encrypted with Noise, the peer id in the address decides which machine may answer, and cadre membership is still checked.

### Becoming reachable

A tab cannot open a listening socket. Other machines can dial it only at a `/p2p-circuit` address, which exists while the tab holds a reservation on a circuit relay. Anything that requires being dialled needs one. A formation invitation embeds the cadre's addresses, so `createOpenInvitation` throws when the cadre has none, and a cadre invitation minted by a tab whose cadre has no other dialable machine can be redeemed only at the tab's own circuit address.

Naming relays in the start option `relayAddrs` is all the page does. The edge node passes them to cadre-core as `network.relayAddrs` with `requireRelay: false`:

- **The control node and every strand node reserve.** An invitee first dials the control node and then the strand's nodes, so both need a circuit address ([Strand nodes inherit the relay configuration](../network/relay.md#strand-nodes-inherit-the-relay-configuration)).
- **The reservation is asked for directly**, not left to libp2p's relay discovery ([Reservations are requested explicitly](../network/relay.md#reservations-are-requested-explicitly)).
- **A relay that is down does not fail the start.** A first attempt that obtains nothing is logged and retried in the background, and a reservation lost later is requested again, so a tab still starts on its own when its relay is unreachable. A malformed relay address does fail the start.

`CadreNode.getRelayReservationState()` reports the result as `none` (no relay named), `dialing`, `reserved`, `retrying` or `error`, with the live circuit addresses. The state is computed from the node's current addresses on each call, so a reservation lost after start stops reading `reserved`. A page should read it at the moment it mints an invitation, not from a value it cached at start; the reference app's `createInvitation` refuses unless the state is `reserved`, so that no invitation carries an address that no longer routes.

### How the reference app configures its relay

`src/lib/relay-config.ts` resolves the relay addresses in this order and uses the first source that yields any:

1. `VITE_RELAY_ADDR`, a comma-separated list of multiaddrs fixed when the bundle is built.
2. `localStorage["relay-addr"]`, a comma-separated list read only when the build set none. It is per browser and intended for development.
3. Nothing: the tab starts with no relay.

The app reads the addresses at each start, restart and join, so a value written to `localStorage` takes effect when the page reloads or the user restarts the node.

### WebRTC upgrade and STUN

With a relay named, cadre-core's `webrtcListenAddrs` adds `/webrtc` to the listen addresses, so a peer can open a direct connection to the tab and a connection that began through the relay can be replaced by a direct WebRTC one. cadre-core adds the bare `/p2p-circuit` entry for the relay itself. With no relay there is no signalling path, so the listen addresses are empty. A phone app passes the same function ([React Native](react-native.md#transport-and-reachability)).

WebRTC needs a STUN server to discover the tab's public address. `resolveStunServers(relayAddrs, override)` from `@serfab/cadre-core` returns one `stun:<relay host>:3478` URL per relay, because each Sereus relay also answers STUN on that port. The second argument replaces them with a comma-separated list of `stun:` URLs, for a relay whose STUN service is published elsewhere; the reference app passes `VITE_STUN_URLS`. With no relay and no override the list is empty and WebRTC uses host and LAN candidates only. `ops/docs/ice-servers.md` describes the server side.

## Bundling

### Aliases

The reference app's `vite.config.ts` aliases only the Node built-ins that dependencies of libp2p import. A browser already provides `crypto.subtle`, `EventTarget`, `ReadableStream`, `structuredClone`, `Promise.withResolvers`, `AbortSignal.throwIfAborted`, `TextEncoder` and `TextDecoder`, so none of the phone polyfills for those is needed.

| Module (bare and `node:` forms) | Alias | Why |
|---|---|---|
| `os`, `net`, `tls` | an empty module (`src/shims/empty.ts`) | imported by `@libp2p/tcp` and by Node-only branches that a tab never runs |
| `stream` | `readable-stream` | libp2p stream handling |
| `buffer` | the npm `buffer` package | dependencies that import Node's `Buffer` |

Three other settings matter:

- **`crypto` is deliberately not aliased.** Anything that imports `node:crypto` in a browser bundle is a defect to find, not to hide behind a shim. cadre-core keeps its Node-only code that needs it (the FCM and APNs push senders) behind the subpath `@serfab/cadre-core/push-node`, which a browser app does not import.
- **`resolve.dedupe: ['@multiformats/multiaddr']`** forces a single copy of that package into the bundle. The reason given beside it in `vite.config.ts`, a `@chainsafe/libp2p-gossipsub` that needs version 12 of the package, does not apply to the installed packages: gossipsub is not among them and every copy of the package is version 13. A new app can leave the rule out unless it finds two copies in its own bundle.
- **`define: { global: 'globalThis' }`** for dependencies that refer to Node's `global`.

### TCP is bundled and never used

cadre-core imports the main entry of `@optimystic/db-p2p`, which imports `@libp2p/tcp` statically, so the TCP transport's code is in the bundle. The `net`, `os` and `tls` aliases let it load. It is never constructed, because the platform supplies an explicit transports list. A running tab's libp2p node should list four transports: WebSockets, circuit relay and the two WebRTC transports. A TCP entry there means a Node transport was instantiated in the browser.

### Polyfills

`src/polyfills.ts` supplies the two things a current browser still lacks, and `src/main.ts` imports it before any other module:

- **`globalThis.Buffer`,** set to the npm `buffer` package's. The alias makes the module importable but defines no global.
- **Timer handles with `.ref()` and `.unref()`.** Browsers return a number from `setTimeout` and `setInterval`; db-p2p, undici and libp2p call `.unref()` on the result. The shim wraps the number in an object with both methods, each doing nothing, and unwraps it in `clearTimeout` and `clearInterval`.

A further missing API belongs in that file, with a comment naming the package that needs it. [Browser bundle checks](../contributing/gates.md#browser-bundle-checks) describes what the repository checks about the bundle.

### Browser support

The reference app is developed and tested in Chromium; its Playwright suite runs no other browser. The stack uses WebSocket, IndexedDB, WebCrypto and WebRTC and nothing specific to Chromium, but Firefox and Safari are untested. Strict IndexedDB transactions are detected at run time, so a browser without them still works with weaker durability.

## Limits and accepted tradeoffs

- **Keys are readable by any script on the origin.** The identity and the owner key are plaintext in origin-scoped IndexedDB. Non-extractable WebCrypto keys were considered and declined, because exporting an owner key to a file or a QR code needs an extractable key.
- **Clearing site data loses the owner key.** The tab is then no owner of the party it founded, unless the user imports an export of the key or redeems a backup owner grant ([Exporting and importing an owner key](../cadre/owner-keys.md#exporting-and-importing-an-owner-key)).
- **Two tabs of one origin are not coordinated.** `createEdgeNode` refuses a second edge node over the same storage id only within one page. Two tabs share the node-local database, the saved start and the identity, and nothing stops the second from starting the party the first runs. Each writes its whole view of a per-party record on save, so the last writer wins and a dial target or anchor entry the other recorded can be dropped, until a later seed restores it. A join in one tab changes the other only on its next load, and deleting a party's database waits until the other tab closes.
- **A tab is reachable only while it is open and its reservation holds.** An invitation whose only addresses are a tab's circuit addresses can be redeemed only while that tab stays open.
- **No TURN.** `resolveStunServers` returns STUN servers only. A WebRTC upgrade that fails leaves the connection on the relay.
- **Dialling private and plain-WebSocket addresses is on by default.** It is needed for home machines and development, and it means a tab will attempt any address an invitation names. A deployment that wants libp2p's stricter browser default sets `allowPrivateDial: false`.
- **Firefox and Safari are untested.**
