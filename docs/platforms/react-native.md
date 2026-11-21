# Running a node in a React Native app

This document is for a developer who embeds a cadre node in a React Native app. It covers what the app must supply, the polyfills and Metro settings the libp2p and Optimystic stack needs under Hermes, how a phone connects and becomes reachable, where node state is stored, and the platform's limits. The kit's API is in the [`@serfab/cadre-rn` README](../../packages/cadre-rn/README.md).

Related: [The cadre node](../cadre/node.md) (the edge node the kit runs) · [Relays](../network/relay.md) · [Several apps in one cadre](../cadre/apps.md) · [The reference apps](reference-apps.md) · [Device testing](../contributing/device-testing.md) · [NativeScript](nativescript.md) · [Browser](browser.md)

## What the app must provide

A React Native app runs a node through `@serfab/cadre-rn`, called the kit in this document. The kit has no root import: every entry point is a subpath, so an app installs only the native modules that the subpaths it imports need. `createPhoneNode` (`@serfab/cadre-rn/phone-node`) is cadre-core's edge node ([The edge node](../cadre/node.md#the-edge-node)) over the platform secure store and LevelDB.

The app supplies eight things:

| What | How | Details |
|---|---|---|
| A native build | A development client or release build. Expo Go cannot load the native modules. | [When a native rebuild is needed](#when-a-native-rebuild-is-needed) |
| Polyfills, loaded first | Side-effect imports at the top of the entry file | [Polyfills](#polyfills) |
| Bundler settings | One call to `withCadreMetro` in `metro.config.js` | [Metro configuration](#metro-configuration) |
| Babel helpers | `@babel/runtime` 7.29.2 or newer | [Babel helpers must be 7.29.2 or newer](#babel-helpers-must-be-7292-or-newer) |
| Storage | A secure store and `rn-leveldb`, passed to `createPhoneNode` | [Where node state is kept](#where-node-state-is-kept) |
| Cleartext WebSocket on Android | The kit's Expo config plugin, or one manifest attribute | [Release builds need cleartext WebSocket](#release-builds-need-cleartext-websocket) |
| A relay address | A start option, if the phone is to be invitable | [Reachability: configuring a relay](#reachability-configuring-a-relay) |
| Lifecycle wiring | The kit's background runner over `AppState` | [Background and foreground](#background-and-foreground) |

### Native modules the app lists itself

React Native autolinks native code only for an app's own direct dependencies. The kit imports the native modules it needs, but the app must list each one in its own `package.json` and rebuild. The [kit README](../../packages/cadre-rn/README.md#what-the-app-must-install) says which subpath needs which module and version.

`react-native-quick-crypto` needs React Native's new architecture. The reference app runs Expo SDK 53 with the new architecture enabled, lists `react-native-quick-crypto` under `plugins` in `app.json`, and uses `@config-plugins/react-native-webrtc` for the WebRTC native settings.

### What the kit decides for the app

The edge node builds the node's configuration ([The edge node](../cadre/node.md#the-edge-node)). Two of its choices need something from the app:

- **The app hibernates strands.** Automatic hibernation is off, so the app's lifecycle runner hibernates strands when the app goes to the background ([Background and foreground](#background-and-foreground)).
- **Signed schemas are required**, cadre-core's default. An app with unsigned schemas relaxes it in the platform's `configure` hook, as the reference app does for its demo schema.

## Polyfills

libp2p, Optimystic and their dependencies read several web and Node APIs that Hermes and React Native do not provide. They read them while their modules evaluate, so a library module that loads before the polyfills has already captured `undefined`, and the failure appears much later as an unrelated timeout. The app's entry file must:

```js
// index.js: the app's entry module (package.json "main")
import '@serfab/cadre-rn/polyfills';                 // first
import '@serfab/cadre-rn/polyfills/native-crypto';   // only with react-native-quick-crypto
import '@serfab/cadre-rn/polyfills/webrtc';          // only with @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';                // after every polyfill, before the app
import 'expo-router/entry';                          // or AppRegistry.registerComponent(...)
```

Each position has a reason:

- **`/polyfills` first.** Its first statement sets `process.env.DEBUG` in development builds, which every bundled copy of `debug` reads once when it loads, and it installs `crypto.getRandomValues`, which key generation needs.
- **`/polyfills/native-crypto` before anything imports libp2p.** `@libp2p/crypto` decides between WebCrypto and pure-JavaScript Ed25519 once, when its Ed25519 module evaluates. It goes after `/polyfills` because quick-crypto reads globals `/polyfills` installs.
- **`/polyfills/webrtc` before the app's code**, so the WebRTC globals exist before anything can dial.
- **`/boot-check` as an import, after every polyfill.** A statement in the entry module's own body runs only after all its imports have evaluated, the app tree included, so a missing global would crash the app before a check called from the body could print.

Each patch except the timer wrapper tests for the API and does nothing where the runtime already provides it.

### Globals `/polyfills` installs

| API | Required by | Notes |
|---|---|---|
| `crypto.getRandomValues` | `@noble/hashes`, `@noble/curves`, `@libp2p/crypto` | From `react-native-get-random-values`. There is no `Math.random` fallback: without the native module the import fails. |
| `crypto.subtle.digest` | multiformats' browser SHA-2, which hashes every Optimystic block | SHA-256 and SHA-512 over `@noble/hashes`; replaced by a native hash when quick-crypto loads ([Native crypto](#native-crypto)). |
| `TextDecoder` | `uint8arrays`, at module scope (libp2p, multiformats, yamux) | UTF-8 only; another encoding throws `RangeError`. Expo SDK 52 and later provide one, so this arm runs on bare React Native. |
| `structuredClone` | `@optimystic/db-core` | Copies plain data, typed arrays, `Date`, `RegExp`, `Map` and `Set` directly. A graph holding anything else goes whole to `@ungap/structured-clone`, which is several times slower. |
| `Symbol.asyncIterator` | `for await` over custom iterables | Defined through `Symbol.for`, so independent polyfills agree on one symbol. |
| `ReadableStream`, `WritableStream`, `TransformStream` | Streaming libraries an app may add | From `web-streams-polyfill`. Expo SDK 53 already provides all three. |
| `Promise.withResolvers` | `@libp2p/utils`, `@libp2p/ping`, `@chainsafe/libp2p-yamux`, `it-queue`, `mortice`, `abort-error` | ES2024. |
| `DOMException` | `p-timeout` (through `p-queue` and `p-event`), which constructs one unchecked; the `AbortSignal` polyfills' abort reasons | A named `Error` subclass with `name`, `message` and the legacy numeric `code`. |
| `AbortSignal.prototype.throwIfAborted` | libp2p, `@libp2p/utils`, `@libp2p/circuit-relay-v2`, yamux, `it-pushable`, `p-retry`, `p-event` | |
| `AbortSignal.timeout` | libp2p's dial queue, registrar and connection pruner; relay reservations; `@libp2p/websockets`; `@libp2p/identify` | Without it every dial that carries no signal of its own throws `TypeError`. |
| `AbortSignal.any` | `p-wait-for`, reached through `@libp2p/webrtc` | Removes its listeners when the combined signal aborts ([Limits](#limits-and-accepted-tradeoffs)). |
| Abort reasons (`signal.reason`) | Every `controller.abort(err)` | React Native installs `abort-controller` 3.0.0, whose `abort()` takes no argument. Without the patch a dial timeout reports a bare `AbortError` with no cause. |
| `WebSocket.prototype.bufferedAmount` | `@libp2p/websockets` | Reports `0`. React Native hands each frame to the native socket and keeps no queue in JavaScript. |
| Timer `ref()` and `unref()` | `@optimystic/db-p2p`, `undici`, libp2p | Wraps Hermes's numeric timer ids in objects, and patches `clearTimeout` and `clearInterval` to unwrap them. |
| `Intl.PluralRules` | `moat-maker` (a Quereus dependency), at module scope | English only. |
| `EventTarget`, `Event`, `CustomEvent` | libp2p, `@libp2p/interface` | The `event-target-polyfill` package, plus a `CustomEvent` class that package lacks. |

`bufferedAmount` decides whether the phone can dial at all. `@libp2p/websockets` sends only while it is below a limit, and `undefined < n` is `false`, so without the patch the socket opens, the handshake is never written, and the dial ends at its timeout with nothing naming the cause.

### Optional polyfill entry points

| Import | Installs | Required by |
|---|---|---|
| `/polyfills/native-crypto` | `crypto.subtle` `generateKey`, `importKey`, `exportKey`, `sign` and `verify` from quick-crypto, and the native digest | `@libp2p/crypto`'s browser Ed25519 module, which signs through WebCrypto when its load-time probe succeeds |
| `/polyfills/webrtc` | `RTCPeerConnection`, `RTCSessionDescription`, `RTCIceCandidate` and the rest, through `react-native-webrtc`'s `registerGlobals()` | `@libp2p/webrtc`'s browser variants, which read the WebRTC engine from globals |

Without `/polyfills/native-crypto`, `crypto.subtle` has only `digest`: libp2p signs and verifies Ed25519 in pure JavaScript, and its ECDSA and RSA key import and export throw `TypeError`.

### APIs the runtime already provides

Do not add polyfills for these: a second implementation can conflict with the native one.

| API | Provided by |
|---|---|
| `TextEncoder` | Hermes |
| `BigInt` | Hermes |
| `AggregateError` | Hermes. libp2p throws it when every address of a peer fails. |
| `queueMicrotask`, `performance.now` | React Native's startup code |
| `AbortController`, `AbortSignal` | React Native, from the `abort-controller` package; the kit adds what that release lacks |
| `WebSocket` | React Native |

Do not add `fast-text-encoding`. Its `TextEncoder` replaces the native one and returns a `Uint8Array` subclass that behaves slightly differently, which can cause double encoding. An app that constructs `URL` objects in its own code may need `react-native-url-polyfill`; the node itself does not.

### Guards against a missing global

A dependency upgrade can start reading a global that nothing provides, and a React Native upgrade can stop providing one. Two checks in the app cover this, and neither closes the gap alone.

- **A dependency scan in the app's tests**, such as the reference app's `test/polyfills/dependency-globals.spec.ts`, fails when a global starts appearing in the app's installed dependencies with nothing providing it. It belongs in the app because the dependency graph is per app.
- **`/boot-check` on the real runtime**, in development builds only, prints each global as `native`, `polyfilled`, `gap` or `MISSING` under `[cadre-rn] polyfill audit`, and warns on any `MISSING`. `RTCPeerConnection` and `crypto.subtle.importKey` read `gap` in an app that does not import the optional entry points.

`/boot-check` also logs `[reload] <reason>` before any reload that starts in JavaScript; [Device testing](../contributing/device-testing.md) explains how to read it.

A new global polyfill goes in the kit, not in an app, so that every Sereus app gets it, with a `typeof` guard and a probe in `polyfills/audit.js`. Prefer a maintained, spec-complete package to a hand-written shim. A polyfill is a fallback for code the project does not control: first-party Sereus source is linted off four of these APIs ([Lint coverage](../contributing/gates.md#lint-coverage)).

## Native crypto

Metro resolves the browser build of `@chainsafe/libp2p-noise`, whose crypto is pure JavaScript. Hermes has no JIT compiler, so that crypto keeps the event loop busy during a strand bring-up for longer than libp2p's liveness-ping deadline, and libp2p then drops connections. The kit replaces three kinds of work with `react-native-quick-crypto`:

| Work | Entry point | Why it is separate |
|---|---|---|
| Noise handshake and frame encryption | `buildNoiseCrypto(mode)` from `/noise-crypto`, passed to `createPhoneNode` | cadre-core reads it when it builds the node, and hands it to the control node and every strand node. |
| Ed25519 signing and verifying | `/polyfills/native-crypto` at boot | libp2p's one-time probe means installing it later has no effect. |
| Block hashing (`crypto.subtle.digest`) | Installed by either of the other two | multiformats reads the digest on every call, so it can be replaced at any time. |

Only local primitives change, not the wire protocol, so a phone with native crypto talks to nodes without it.

How much of Noise runs natively is a start option, `PhoneNodeOptions.noiseCryptoMode`, whose values are in the [kit README](../../packages/cadre-rn/README.md#noise-crypto). Changing the mode means building a new node. The kit saves the resolved mode with the start, so a build with a different default does not change a device that has already started.

## Metro configuration

The kit's `withCadreMetro` (`@serfab/cadre-rn/metro`) takes the config the app's toolchain produced and adds the settings a node needs:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');   // or '@react-native/metro-config'
const { withCadreMetro } = require('@serfab/cadre-rn/metro');

module.exports = withCadreMetro(getDefaultConfig(__dirname), { projectRoot: __dirname });
```

It keeps what the incoming config already set. It does not set condition names or `unstable_enablePackageExports`: both toolchains enable package exports by default, and the condition order is the app's choice.

An app whose packages are linked from local checkouts (a monorepo root, sibling repositories) passes them as `linkedRoots`, which lets Metro follow a symlink out of the project. Without them the bundle fails with "Unable to resolve module" for the linked package.

### Node built-in aliases

Metro follows every import in the graph, including ones behind runtime checks that never pass on a phone, so each Node built-in that libp2p imports must resolve to something. The kit maps each under both its bare name and its `node:` name. Metro consults these only after every `node_modules` lookup fails.

| Module | Resolves to | Required by |
|---|---|---|
| `os` | `shims/node-os.js`: `networkInterfaces`, `platform`, `type`, `hostname` | `@libp2p/utils`' address discovery |
| `crypto` | `shims/node-crypto.js`: `createHash` for SHA-256 and SHA-512 over `@noble/hashes` | The Node variants of multiformats' SHA-2, libp2p-noise's crypto and `@libp2p/crypto`'s key modules |
| `net`, `tls` | `shims/empty.js` | The Node variant of `@libp2p/websockets`' listener, never called on a phone |
| `stream` | The `readable-stream` package | libp2p stream handling |
| `buffer` | The `buffer` package | libp2p, multiformats |

The reference app's bundle reaches only `os`. The rest are for an app whose resolver settings select a Node variant, where an unmapped built-in fails the whole bundle with an error that names the importer and not the cause.

The kit does not stub `path`, `fs` or `http2`. cadre-core keeps the code that needs them behind Node-only subpaths that a React Native app never imports, and an empty `path` or `fs` would break a dependency that really uses them.

### The three `resolveRequest` rules

The resolver applies three rules in this order. The comments in `packages/cadre-rn/metro/index.cjs` have the full reasoning.

**1. The kit's peer dependencies resolve from the app.** An import of `react-native`, of any module in the kit's `peerDependencies`, or of a subpath of one resolves as if a file in `projectRoot` imported it, whoever the importer is. Otherwise a monorepo bundles a copy hoisted to the repository root beside the app's. Native code is linked only for the app's own dependencies, so a second copy is JavaScript that does not match the native side: two copies of `react-native-webrtc` each number their peer connections from zero.

**2. `@babel/runtime/*` resolves to the CommonJS helper in the app's copy.** Metro's Babel output calls `require()` on these helpers and expects the function itself. An app whose condition list puts `import` ahead of `require` otherwise gets the ESM wrapper, and the bundle fails at startup with `_interopRequireDefault is not a function`. The app's copy is the one [the version requirement](#babel-helpers-must-be-7292-or-newer) applies to.

**3. `@libp2p/crypto` and `@libp2p/webrtc` get their `browser`-field variants.** With package exports enabled, Metro returns a file it found through a package's `exports` without applying the `browser` field, and the Node variants cannot run on a phone. Those of `@libp2p/crypto` call functions of Node's `crypto` that the kit's shim lacks, so the first `generateKeyPair('Ed25519')` throws `undefined cannot be used as a constructor`. Those of `@libp2p/webrtc` load the native addon `node-datachannel`.

### Variants Metro selects by itself

Several dependencies avoid a missing API only because Metro applies their `react-native` or `browser` field. If one of these symptoms appears, that mechanism has stopped working:

| API the phone lacks | What avoids it | Symptom if it fails |
|---|---|---|
| `BroadcastChannel` | `mortice`'s `react-native` field selects a build with no channel | The bundle contains `mortice`'s browser build, which needs the channel |
| `WebAssembly` | libp2p-noise's `browser` field selects pure-JavaScript crypto over `@chainsafe/as-sha256` and `as-chacha20poly1305` | The bundle fails to resolve `@chainsafe/as-*` |
| `navigator.userAgent` | libp2p's `react-native` field selects a user-agent module that reads `Platform.OS` | Identify announces `browser/undefined` |

`@optimystic/db-p2p` and `@serfab/cadre-core` both declare a `react-native` export condition. db-p2p's selects an entry point that does not import `@libp2p/tcp`.

### Babel helpers must be 7.29.2 or newer

Hermes has no native async generators, so Metro's Babel transform rewrites them onto Babel's `wrapAsyncGenerator` helper from `@babel/runtime`. Before 7.29.2 that helper stopped a generator's `finally` block at its first `await` when the consumer left a `for await` loop early. Quereus releases its execution lock in such a `finally`, so on a phone the first early-exit read leaves the lock held and founding a strand hangs. Node runs async generators natively, so no test on Node shows the fault.

The app declares `@babel/runtime` `^7.29.2`. Upgrade inside Babel 7 with `yarn up -R @babel/runtime @babel/helpers` (a bare `yarn up` moves to Babel 8), then restart Metro with `--clear` so it recompiles. An app with its own Babel setup should compile an early-exit probe with its Metro transformer in a test, as the reference app's Vitest project `metro-babel` does.

## Transport and reachability

A phone binds no socket, so it never listens on TCP or WebSocket: it dials out. The kit's default transports are WebSockets and circuit relay. An always-on node that a phone dials directly must therefore listen on a `/ws` address, for example `/ip4/0.0.0.0/tcp/4002/ws` in a cadre-cli node's `network.listenAddrs`.

An app with `react-native-webrtc` adds the WebRTC transport and, with it, a `/webrtc` listen address whenever the phone has a relay. A `/webrtc` listener binds nothing: it registers the signalling handler and derives its address from the relay reservation. Advertising that address is what lets another machine open a direct connection *to* the phone, and lets a relayed connection upgrade to a direct one while the relay carries only the signalling. `webrtcListenAddrs` (`@serfab/cadre-rn/phone-node`) is the listen function to pass, the same one the browser reference app uses:

```ts
transports: (relayAddrs) => [
	webSockets(),
	circuitRelayTransport(),
	webRTC({ rtcConfiguration: { iceServers: resolveStunServers([...relayAddrs]) } }),
],
listenAddrs: webrtcListenAddrs,
```

With no relay `webrtcListenAddrs` names nothing, since there is then no signalling path, and the phone keeps the posture of accepting no connection.

cadre-core's `resolveStunServers` turns each relay address into `stun:<relay host>:3478`, so each relay is also the phone's STUN server; its second argument replaces the derived list. With no relay the phone has no STUN server, and a WebRTC upgrade uses local network candidates only.

### Dialing private and plain `ws://` addresses

libp2p's connection gater, in the build its `react-native` field selects, refuses to dial plain `ws://`, loopback and private addresses. A cadre-host node claimed on the same Wi-Fi, an emulator reaching `10.0.2.2` and a self-run relay without TLS are all such addresses. The edge node therefore permits them by default (`allowPrivateDial`), on strand nodes too. Only the dial is permitted: the connection is still encrypted by Noise, the peer id in the address decides which machine may answer, and cadre membership is still enforced by [the connection gate](../cadre/control-security.md#the-connection-gate).

### Release builds need cleartext WebSocket

Android refuses connections without TLS unless the app opts in, and it treats `ws://` as cleartext. React Native's template opts in for debug builds only, so without an opt-in for every build a release build dials no `/ws` address: no always-on node, no cadre-host node, no relay.

The kit's Expo config plugin sets `android:usesCleartextTraffic="true"` on the manifest's `<application>` element at prebuild, and a bare React Native app adds the attribute by hand. The [kit README](../../packages/cadre-rn/README.md#config-plugin-expo) has both forms, and says which setting wins when another plugin or a network security config also decides cleartext.

Dialing without TLS is safe here. The Noise handshake encrypts every libp2p connection and authenticates it against the peer id in the dialed address, so a party between the phone and the node can neither read the traffic nor pose as the node. TLS underneath would add a dependency on certificate authorities and no security. A claim's secret does not cross the wire either: `claimNode` sends an HMAC proof of it inside the Noise channel.

### Reachability: configuring a relay

Without a relay a phone node has no address of its own. A reservation on a circuit relay earns it a `/p2p-circuit` address, and an app carrying WebRTC a `/webrtc` address derived from that reservation, so a peer can open a direct connection to the phone. [Which nodes can be reached through a relay](../network/relay.md#which-nodes-can-be-reached-through-a-relay) covers the other node kinds.

The relay is a start option: `PhoneNodeOptions.relayAddrs`, a list of full relay dial addresses that each end in the relay's peer id, such as `/ip4/203.0.113.7/tcp/4002/ws/p2p/12D3KooW…`. The edge node puts the list in `network.relayAddrs`, which reaches the control node and every strand node. Both need a circuit address, because a joining party dials the control node first and then the strand nodes.

| The phone can | With a relay reserved | Without |
|---|---|---|
| Start, found strands, read and write them | yes | yes |
| Dial an always-on node or a claimed cadre-host node and sync | yes | yes |
| Join a strand from someone else's invitation | yes | yes |
| Invite another party to a strand it founded | yes | no |

Inviting needs an address because the phone runs the strand it invites to, so the joiner must reach the phone itself. `CadreNode.createOpenInvitation` on a phone with no address names only the party's other machines, which may not run a newly founded strand yet. An app should read `CadreNode.getRelayReservationState()` when the user asks to invite, and refuse while the phone holds no circuit address.

- **A relay never blocks startup.** An unreachable relay is logged and retried in the background, also while the app is backgrounded and the OS lets it run. The reservation state is read live, so a relay that comes back works with no restart.
- **An unreachable relay slows startup and founding.** cadre-core waits out the first reservation attempt on `start()` and on every strand launch: 18 seconds at the default declared link when the dial is refused (`relayReservationBudgetMs` in `packages/cadre-core/src/link-budget.ts`).
- **The two ends need not share a relay.** Each phone dials the other through the other's relay.
- **A direct path is not guaranteed.** Two phones whose networks do not let ICE connect — each behind a carrier NAT that rewrites ports, say — stay on the relay for the life of the connection. Everything still works; the traffic is relayed.

### Deadlines sized for a phone

cadre-core sizes its liveness ping, its first-sync wait and its per-peer read deadline for a phone on a relayed link, on every node it builds, and an app sets nothing for them ([Deadlines and the link budget](../network/deadlines.md)). A deployment whose link is slower sets `network.linkRoundTripMs` in the platform's `configure` hook, which moves every link-derived budget.

`addStrand` rejects with `StrandAwaitingFirstSyncError` when a first sync outlasts its budget, and the strand keeps syncing. The kit's `attachStrandWhenWritable` treats that as progress and keeps waiting ([Joining: no writes before the first sync](../strands/formation.md#joining-no-writes-before-the-first-sync)).

### Background and foreground

The kit's `createBackgroundRunner` (`@serfab/cadre-rn/lifecycle`) follows React Native's `AppState`. On `background` it hibernates the node's strands and leaves the control connection up for as long as the OS allows. On `active` it starts the node again from the saved start if the OS killed the process, then waits a bounded time for the control network to reconnect. The [kit README](../../packages/cadre-rn/README.md#lifecycle) has its states and options.

A push wake (FCM or APNs) is the app's own code; the kit has none. [Push wake](../strands/hibernation.md#push-wake) describes the mechanism, and the reference app's `src/push-wake-native.ts` is an example.

## Where node state is kept

A phone node keeps state in two places. The **secure store** is the iOS Keychain or Android Keystore-encrypted preferences, reached through `expo-secure-store` or the app's own adapter. **App-private LevelDB** is `rn-leveldb`: one database per cadre-core storage scope (the control network and each strand) and one more for the node-local records. None of the node-local records is replicated or can be rebuilt from the network.

| Record | Store | Key | One per |
|---|---|---|---|
| Node identity | Secure store | Key-store slot `cadre/identity` | Install |
| Owner key | Secure store | Key-store slot `cadre/owner` | Install |
| Joined-strand records | Secure store | Key-store slots under `cadre/joined-strand/` | Party and strand |
| Strand-move record | Secure store | Key-store slot `cadre/strand-move/<party>` | Party left |
| Trusted-owner anchor | Secure store | `sereus.anchor.<base64url party id>` | Party |
| Provider tokens | Secure store | `sereus.provider-tokens.<base64url provider id>` | Provider |
| Saved start | Node-local LevelDB | `start-options` | Install |
| Dissolve marker | Node-local LevelDB | `dissolving-party` | Install |
| Open link request | Node-local LevelDB | `link-join-request` | Install |
| Recommended apps | Node-local LevelDB | `recommended-apps` | Install |
| Bootstrap dial targets | Node-local LevelDB | `bootstrap-peers.<partyId>` | Party |
| Enrolled-machine count | Node-local LevelDB | `enrolled-machines.<partyId>` | Party |
| Strand network state | Node-local LevelDB | `strand-network.<partyId>` | Party |
| Provider rentals | Node-local LevelDB | `rentals.<partyId>` | Party |
| Control database | Its own LevelDB database | `<storagePrefix><control scope>` | Party |
| Strand data and offline queue | Its own LevelDB database | `<storagePrefix><strandId>` | Strand |

What each record is for is in [Node-local state](../cadre/node.md#node-local-state). The key-store slots are stored under `sereus.ks.` plus the base64url of the slot id, with a `sereus.ks.__index` entry that lists them, because neither platform store can enumerate its keys. The anchor and the provider tokens have prefixes of their own.

### Which store, and why

The module comment of `packages/cadre-rn/src/node-local.ts` has the full reasoning for where each record goes.

- **Secrets go in the secure store.** The identity, the owner key, the joined-strand records (read secrets and party keys) and the strand-move record are private key material or bearer credentials. Provider tokens are credentials for the user's account at the provider.
- **The anchor goes in the secure store although it is not secret.** Anything that can edit it can make the device trust a stranger as an owner ([The trusted-owner anchor](../cadre/control-security.md#the-trusted-owner-anchor)). It gets the most tamper-resistant store the app has, and is kept or lost together with the identity it qualifies.
- **The other records go in LevelDB.** None of them grants authority, and the dial targets and the strand network state outgrow the secure store's value guideline of 2,048 bytes. They get a database of their own, not a strand's, so that clearing it cannot disturb replicated data.
- **A strand's offline queue sits in that strand's database**, beside the blocks it refers to ([Offline mode](../strands/writes.md#offline-mode)).

### Secure-store gating

Open the secure store with no `requireAuthentication` and with `keychainAccessible: AFTER_FIRST_UNLOCK`. The node must start and sign owner writes with no user present, on a push wake or a background restart while the device is locked. A biometric-gated entry is also invalidated when the device's biometric set changes. `createPhoneNode` takes one options object for the identity, the owner key and the anchor, so they cannot have different gating.

`SecureStoreKeyStore` distinguishes a refused read from an empty slot: a read that throws becomes `KeyStoreAccessError` and fails the start. cadre-core generates a new identity only for a slot that reads as absent, so a transient access failure never replaces the real key. The anchor slot (`secureStoreSlot`) and the provider-token slot refuse a gated configuration outright, because they read `null` as absent and a biometric-invalidated entry also reads `null`.

### What survives a reinstall

| Platform | Secure store after uninstall and reinstall | LevelDB |
|---|---|---|
| iOS | Keychain items persist, the identity, the owner key and the anchor among them | Deleted |
| Android | Deleted with the app's preferences | Deleted |

On iOS the reinstalled app has the same peer id and the same owner key, which is still an owner of every cadre that listed it, and a first start that founds a party founds it with that key. The saved start does not survive, so the app does not know which party it was in, and an app that mints a new party id on first run never reads the old anchor.

On Android the reinstalled app generates a new identity and holds no owner key. A node that has lost its secure-store entries joins the cadre again as a new machine ([Adding and removing machines](../cadre/membership.md)), and becomes an owner again by importing an exported key or redeeming a backup owner grant ([Owner keys](../cadre/owner-keys.md)).

### Storage names are a persistence contract

`PhoneNodeNames` sets the LevelDB database prefix, the node-local database name and the keys inside it. Renaming one orphans every installed phone's records, so an app that sets its own names should pin them in a test.

`rn-leveldb` holds a lock per database name, so a database left open fails the next start. `PhoneNode.stop()` closes every database the node opened; an app that opens its own handles must close them the same way.

## When a native rebuild is needed

JavaScript changes reach a development client through Metro with no rebuild. A rebuild is needed when the native side changes:

- **A native module is added or changes version.** This includes every native module the kit needs and any Expo module with native code. A client built before the module was added fails when the bundle first evaluates it, which is at launch for a module the entry file imports.
- **The native configuration changes.** This covers `app.json` or `app.config.ts` entries that prebuild writes into the manifest or `Info.plist`: plugins, intent filters, URL schemes and permissions. The kit plugin's cleartext attribute and its `appLinks` option are such changes: on Android, a client built before the plugin declared another app's scheme reports that app as not installed.

After upgrading `@babel/runtime` or changing `metro.config.js`, restart Metro with `--clear`; no native rebuild is needed.

## Limits and accepted tradeoffs

- **A phone that other parties must dial needs a dedicated relay.** It cannot listen. It can hold its reservation on its party's own always-on node when that node's address is given as `relayAddrs`, but then only the party's own machines can reach it: a party-run relay closes another party's connection through it, and nothing supplies the node's address automatically ([Relaying for other parties](../network/relay.md#relaying-for-other-parties); ticket `feat-phone-relays-through-its-own-always-on-node`).
- **The phone cannot dial `/webrtc-direct` addresses.** The kit's WebRTC support is the relayed-connection upgrade only (ticket `rn-webrtc-direct-dial`).
- **iOS App Transport Security is unverified.** The plugin changes nothing on iOS, and whether ATS applies to React Native's WebSocket has not been established. An iPhone release build dialing a public `/dns4/…/ws` address would settle it; if ATS refuses the dial, the plugin needs an ATS exception.
- **Native Noise crypto has not been measured on a device.** Whether each mode stops the connection drops that pure-JavaScript crypto causes is not known, and `full` has had less use than `symmetric` (ticket `rn-native-noise-crypto-device-run`).
- **`crypto.subtle` has no AES-GCM.** Nothing installs `encrypt`, `decrypt` or `deriveKey`, so `@libp2p/keychain` throws `TypeError` when used. The node does not use it.
- **`AbortSignal.any` can retain listeners.** A combination none of whose inputs ever aborts keeps its listeners on those inputs, because Hermes offers no weak reference to the combined signal. The only caller in the dependency graph always pairs its signal with a timeout.
- **The stand-ins are partial.** `TextDecoder` is UTF-8 only. `DOMException` has no static code constants, and `structuredClone` copies one as a plain `Error`.
- **Keys are readable without the user.** The ungated secure store lets the app read the identity and the owner key whenever the device has been unlocked once since boot. Prompting before an owner signature belongs to a signer that can prompt (ticket `feat-owner-key-on-a-hardware-key`).
- **An Android reinstall loses the identity and the owner key**, and there is no recovery of the old keys.
- **Two secure-store records can pass the store's 2,048-byte value guideline.** `expo-secure-store` 14 warns above it and stores the value; its warning says a later version may throw. An anchor passes it at about 20 owner keys, and a strand-move record that carries a routing table per strand passes it sooner.
- **A missing global can still reach a release build.** The dependency scan is a substring search over a hand-listed set of packages, and the boot audit runs only in development builds.
- **The UTF-8 decoder and the `structuredClone` stand-in exist twice**, in the kit and in the NativeScript reference app. A fix to one must be ported to the other (ticket `decide-shared-runtime-shims-for-phone-apps`).
