# Reference App: P2P Chat for React Native

This document describes the architecture for `packages/reference-app-rn`, a minimal but realistic peer-to-peer chat application built on the full Sereus/Optimystic stack. Its primary purpose is to exercise and validate the React Native platform path end-to-end.

## Goals

1. **Platform validation** — prove that cadre-core, db-p2p, Quereus, and the Optimystic plugin work correctly in a React Native runtime
2. **Realistic P2P scenario** — form a true 2-party cadre (phone + drone) with a shared strand running a chat sApp
3. **No local native tooling** — use EAS Build for cloud compilation; no Xcode or Android Studio required locally
4. **Automated test target** — provide a deterministic app that Maestro or Detox can drive for CI

## Architecture Overview

```
┌──────────────────────────┐        WebSocket         ┌────────────────────────┐
│   reference-app-rn       │◄═══════════════════════►│      cadre-cli         │
│   (Phone node)           │     + circuit relay      │    (Drone node)        │
│                          │                          │                        │
│  Expo / React Native     │                          │  Node.js CLI           │
│  cadre-core              │     libp2p protocols     │  cadre-core            │
│  db-p2p (RN entrypoint)  │◄──────────────────────►│  db-p2p (TCP)          │
│  db-p2p-storage-rn       │                          │  db-p2p-storage-fs     │
│  quereus + plugins       │                          │  quereus + plugins     │
│  Chat sApp schema        │     shared strand        │  Chat sApp schema      │
└──────────────────────────┘                          └────────────────────────┘
```

Both nodes are members of the same **cadre** (party). They share a **control network** for cadre coordination and a **strand network** running the chat sApp schema. Messages inserted on either side replicate via Optimystic's P2P consensus.

## Node Topology

### The Two Nodes

| Role | Runtime | Transport | Storage | Profile |
|------|---------|-----------|---------|---------|
| **Phone** | React Native (Expo) | WebSocket + circuit relay | LevelDB (`db-p2p-storage-rn`) | `transaction` |
| **Drone** | Node.js (`cadre-cli`) | TCP + WebSocket listener | File system (`db-p2p-storage-fs`) | `storage` |

The drone runs `cadre start` with a config that:
- Listens on both TCP and WebSocket (so the phone can reach it)
- Enables circuit relay (so it can relay for the phone)
- Applies the same chat sApp schema

The phone connects outbound via WebSocket to the drone's advertised address.

### Network Topology

Each party runs two isolated libp2p networks:

1. **Control network** (`control-<partyId>`) — cadre coordination, peer registry, strand table
2. **Strand network** (`strand-<strandId>`) — chat sApp data replication

Both networks run independently with their own FRET DHT, cluster coordination, and storage. The phone participates in both via WebSocket; the drone participates via TCP (with a WebSocket listener for the phone).

## Seed Bootstrap Flow

The phone is the owner (holds signing keys). The drone is a new node that needs to be bootstrapped into the cadre.

```
┌──────────┐                              ┌──────────┐
│  Phone   │                              │  Drone   │
│(owner)│                              │  (new)   │
└────┬─────┘                              └────┬─────┘
     │  1. Start drone with --listen-for-seeds │
     │         and WebSocket listener          │
     │                                         │
     │  2. Phone creates cadre (owner key)  │
     │     Phone generates seed:               │
     │       { partyId, peers, signature }     │
     │                                         │
     │  3. Seed exchanged as JSON              │
     │     (paste / deep link / file)          │
     │────────────── seed JSON ───────────────►│
     │                                         │
     │  4. Drone applies seed                  │
     │     → populates peer cache              │
     │     → dials phone (or waits)            │
     │                                         │
     │  5. Phone dials drone (outbound, NAT-safe)
     │◄════════════ control network sync ═════►│
     │                                         │
     │  6. Strand created in control DB        │
     │◄════════════ strand network sync ══════►│
     │                                         │
     │  7. Chat messages replicate both ways   │
     └─────────────────────────────────────────┘
```

For testing, the seed is a JSON data structure passed between the nodes—no QR encoding needed. The `SeedBootstrapService.encodeSeed()` / `decodeSeed()` methods handle base64url encoding for out-of-band transport, but raw JSON is sufficient.

## Transport & Connectivity

### Drone (cadre-cli) Configuration

The drone must listen on WebSocket in addition to TCP so the phone can reach it:

```yaml
network:
  listenAddrs:
    - "/ip4/0.0.0.0/tcp/4001"
    - "/ip4/0.0.0.0/tcp/4002/ws"    # WebSocket for phone
  enableRelay: true                   # Relay for NAT'd phone
```

### Phone (RN app) Configuration

The phone supplies WebSocket + circuit relay transports via `CadreNodeConfig.network` (`src/phone-node-config.ts`):

```typescript
network: {
  transports: [webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } })],
  listenAddrs: [],              // Cannot listen in RN
  relayAddrs: [...],            // Resolved by src/relay-config.ts; may be empty
  requireRelay: false,          // Must still start when the relay is down
  connectionGater: { denyDialMultiaddr: () => false },
}
```

`relayAddrs` and `requireRelay` are what make the phone dialable without making a relay a condition of starting — see "Reachability: configuring a relay" below.

`denyDialMultiaddr` is set because libp2p's `connection-gater` points its `react-native` package field at the browser build, which refuses to dial insecure `ws://` and private addresses — LAN and loopback. A node borrowed from a cadre-host on the same Wi-Fi is exactly that, in normal use rather than only in development, so the phone opts out of that default the same way the web reference app does. Only the dial is permitted: the connection is still Noise-encrypted, and membership is still gated by cadre-core's `denyDialPeer` plus its inbound and relay hooks. cadre-core threads this to strand nodes as well, which is wanted — they dial LAN addresses too.


### Reachability: configuring a relay

A React Native app cannot open a listener, so on its own the phone node has **no multiaddr at all**. That is fine for almost everything the app does — founding and reading strands, dialling out to a drone or to a node borrowed from a cadre-host, joining somebody else's invitation — because in all of those the phone is the side that dials. It is not fine for **inviting**: an invitation embeds the inviter's own addresses as its bootstrap list, so a phone with no address cannot mint one (`CadreNode.createOpenInvitation` throws `No multiaddrs available for invitation`).

The one address a phone can have is a `/p2p-circuit` address earned by holding a **reservation** on a circuit relay — a public libp2p node that forwards traffic on its behalf. Point the app at one and it becomes invitable.

Two ways to supply it, both resolved by [`src/relay-config.ts`](../packages/reference-app-rn/src/relay-config.ts):

| source | how | when to use it |
| --- | --- | --- |
| `EXPO_PUBLIC_RELAY_ADDR` | build-time env var, comma-separated; Expo inlines `EXPO_PUBLIC_`-prefixed vars into the bundle | a build that should work with no typing |
| Settings → **Relay** | typed per device, comma-separated | pointing one device elsewhere; overrides the env var |

The field is prefilled from the env var on launch, so a build that ships one needs no typing. A value typed into it wins; clearing it falls back to the env var, and with neither the phone runs with no relay.

The address is a full relay dial addr ending in the relay's peer id, e.g. `/ip4/203.0.113.7/tcp/4002/ws/p2p/12D3KooW…`. `ops/` has the relay container this repo ships.

**What the phone can and cannot do without one**

| | with a relay reserved | without |
| --- | --- | --- |
| Start, found strands, read and write them locally | yes | yes |
| Dial a drone / a borrowed cadre-host node, sync, chat | yes | yes |
| Join a closed strand from someone else's invitation | yes | yes |
| **Create a closed strand + invite** | yes | **no** — refused before anything is founded, with a message naming this field |

**It never blocks startup.** The config sets `requireRelay: false`, so a relay that is unreachable at launch is logged and retried in the background instead of failing `start()` — a phone has to work on a dead network. The posture is visible as **Reachable** on the Settings Node card and in the chat screen's connection banner, and it is read live at the moment Invite is tapped, so a relay that comes back mid-session starts working with no restart.

**Two costs worth knowing.** A configured-but-unreachable relay adds about ten seconds to `start()` and about ten more to **every** strand launch: cadre-core waits out each reservation supervisor's first attempt (`DEFAULT_RELAY_RESERVE_TIMEOUT_MS`, 10 s), and a refused dial spends that whole budget polling in case libp2p's own discovery lands a reservation anyway. Nothing fails — founding is just slower while the relay is down, which the Settings screen's slow-founding hint will surface.

**One relay per phone, and both ends are assumed to share it.** Two people configuring *different* relays is untested and out of scope (backlog `feat-scenario-two-relay-circuit`). Relaying through the phone's own always-on cadre node instead of third-party infrastructure is the intended end state but is blocked on two cadre-core defects — see backlog `feat-phone-relays-through-its-own-always-on-node`.

### How It Connects

`cadre-core` already passes `config.network.transports` and `config.network.listenAddrs` through to `createLibp2pNode()` for both the control node and strand instances. The `@optimystic/db-p2p` package has a `react-native` export condition that Metro resolves automatically—when the RN bundler encounters `import from '@optimystic/db-p2p'`, it resolves to `rn.js` (which does not import `@libp2p/tcp`).

## Simplified Chat Schema

`schemas/chat.qsql` is the fuller design — invitations, per-participant keys and ed25519 signature verification on every write: tables are insert-only (Participant additionally allows a signed self-rename and refuses deletes), and every insert after the founding transaction must carry a signature. No app loads it. The reference app runs `schemas/chat-simple.qsql`, a permissionless schema that lets anyone insert/update/delete freely:

```sql
table Participant (
    Id text primary key,
    Name text not null check (length(Name) between 1 and 100),
    -- App-level role (owner | member), assigned on closed-strand create/join.
    Role text not null default 'member' check (Role in ('owner', 'member'))
);

table Message (
    -- Text UUID primary key: each peer generates it locally so concurrent
    -- posts into a shared strand never collide. A max(Id)+1 integer key would
    -- be correct but not free: two peers computing the same next id race, the
    -- loser is refused, and the app must catch that, recompute and retry.
    Id text primary key,
    ParticipantId text not null,
    Content text not null,
    Timestamp datetime not null,
    foreign key (ParticipantId) references Participant(Id)
);
```

`schemas/chat-simple.qsql` is the source of record for the above; `composeStrand` supplies the
`declare schema App { ... }` wrapper, so the file itself is a bare table list. The chat table is
`Participant` rather than `Member` because app tables may not reuse the built-in `Strand` schema's
table names ([`docs/strands.md` → Reserved Table Names](strands.md#reserved-table-names)).

No signature verification, no invite flow, no authorization constraints. This keeps the reference app focused on the P2P plumbing rather than application-level crypto.

## Node-Local Persistence

Three things the phone node keeps *locally* — never replicated, never derivable from the network — and where each lives.

### Peer identity (secure enclave)

The phone node maintains a stable PeerId across app restarts:

1. **First launch** — cadre-core generates an Ed25519 keypair and stores it through `SecureStoreKeyStore` (`src/secure-key-store.ts`), a `KeyStore` over `expo-secure-store`: iOS Keychain / Android Keystore-encrypted preferences, under the reserved `sereus.ks.` key prefix plus a `__index` entry listing the keyIds it holds.
2. **Subsequent launches** — the key is loaded from the enclave, producing the same PeerId every time.
3. **Single identity** — the same key is used for both the control network and all strand networks, matching the one-key-per-device architecture.

`startPhoneNode` resolves the key itself (cadre-core's exported `loadOrCreateIdentityKey`, on the same store and slot the node uses) *before* constructing the `CadreNode`, so it can sign the ICE-manifest request with the identity the node is about to start with — see `ops/docs/ice-servers.md` → "Client side". Ordering is load-bearing: it must run before `loadIceConfig`. A locked/refused enclave read propagates and **fails the start** rather than booting on a replacement key.

Gating: the store is opened **ungated** (no `requireAuthentication`) with `keychainAccessible: AFTER_FIRST_UNLOCK`, because the node must come up headless on a push wake while the device is locked, and because a biometric-set change would invalidate the entry. Earlier development builds kept the key in plaintext MMKV, then plaintext LevelDB; there is no upgrade path from either, and none was ever needed. The app reads its identity only from the enclave and generates one there on first run.

### Trusted-owner anchor (secure enclave)

The set of owner public keys this device believes speak for its party — what seed acceptance, wake authorization, and vouching all check against. Persisted by cadre-core's `PersistentTrustedOwnerStore` over a `DurableSlot` the app supplies: one `expo-secure-store` entry under its own `sereus.anchor.<base64url partyId>` key (`src/node-local-slots.ts`). Deliberately *not* under the key store's `sereus.ks.` prefix, whose `__index` must never see a foreign entry.

The anchor is not secret but it **is** trust-bearing — anything that can silently edit it can make this device trust a stranger — so it gets the most tamper-resistant store the app has, and shares the identity key's fate (including surviving an iOS reinstall, which is the desirable direction: same peer id, same trusted owners). The slot is ungated for the same headless reason as above, and `secureStoreSlot` **refuses** a gated slot outright: its "a `null` read means absent" mapping would misreport a biometric-invalidated anchor as empty, and the next snapshot write would make that permanent.

### Bootstrap dial targets (app-private LevelDB)

The dial targets the node learned out of band: the owner peers of every seed it has applied, and every node it added (a lent cadre-host node, a provider drone). They are the only addresses a stranded node has to re-dial its way back into the party, and the only ones the phone has for a node it added until that node publishes a signed address record. Persisted by cadre-core's `PersistentBootstrapPeerStore` over a `kvStoreSlot`: one key of a `LevelDBKVStore` in the app-private `sereus-node-local` database, separate from any strand's database so clearing it cannot disturb replicated data.

Not the enclave, for two reasons: dialing grants no authority (`CadreNode` re-binds every retained address to the peer id it was recorded under before dialing), and multiaddrs run 80–120 characters each with several per peer and the snapshot growing for the node's whole lifetime — it would cross SecureStore's ~2048-byte value limit and simply fail the write.

⚠️ **Both records are party-scoped, and the app does not yet persist its party id** — it is typed into Settings each launch. Until `feat-rn-persist-node-start-options` lands, a fresh party id per launch means both slots load empty every time: the storage is correct, but survival across a relaunch is not yet observable on device.

## cadre-core React Native Compatibility

### Validated (2026-02-23)

`cadre-core` imports `createLibp2pNode` from `@optimystic/db-p2p`. That package's `exports` field includes a `react-native` condition pointing to `rn.js`, so Metro automatically selects the RN-safe entrypoint (no TCP import). Transport injection in `createControlNode()` and `StrandInstanceManager` already works.

**cadre-core** now declares a `react-native` export condition in its `package.json`. Source audit confirmed two Node-only dynamic imports — `require('path')` in `getStrandStoragePath` and `require('fs/promises')` in `ControlDatabase.loadSchema` — both runtime-guarded behind `process.versions?.node` checks and restricted to Node-only code paths.

**Quereus** has no Node-only imports. BigInt is supported in Hermes since RN 0.70. Only `TextEncoder` is used (built-in to Hermes); `TextDecoder` is not required by Quereus. However, `@optimystic/db-p2p` (and `uint8arrays`, which it pulls in transitively via libp2p/yamux/multiformats) uses `TextDecoder` at module scope — this is covered by Expo SDK 52+'s built-in `TextDecoder` global (UTF-8 only). On **bare RN** Hermes (non-Expo) `TextDecoder` is NOT present as of RN 0.85, so `polyfills/hermes.js` ships a UTF-8-only fallback that becomes a no-op once the runtime provides it.

**Metro bundle** succeeds with 2790 modules (cadre-core, Quereus, db-p2p, libp2p, and all transitive deps). The only warnings are cosmetic: `multiformats` subpath export fallbacks that resolve correctly via file-based resolution.

### Polyfills

The app uses a custom entry point (`index.js`) that imports global polyfills before `expo-router/entry` loads any library code. This is critical because libp2p and its dependencies reference Web APIs at import time. The import order matters:

```js
import './polyfills/hermes';           // Runtime globals (crypto, AbortSignal, WebSocket, structuredClone, …)
import './polyfills/webrtc';           // react-native-webrtc registerGlobals() — after hermes, before app code
import './polyfills/intl-pluralrules'; // Intl.PluralRules for moat-maker
import './polyfills/event';            // Event, CustomEvent, EventTarget for libp2p
import './polyfills/audit';            // Prints the boot audit table under __DEV__ (below)
import 'expo-router/entry';            // App code starts here
```

`polyfills/audit.js` is imported rather than called, and its position is the point: every statement in `index.js`'s own body runs only after all of its imports have evaluated, which includes `expo-router/entry` and the app tree behind it. A global that is missing would crash at that import and the table would never print. Imported here, it prints first.

#### Required polyfill dependencies

The following dependencies **must** be listed as direct dependencies in your app's `package.json` — relying on transitive resolution is fragile and will break when upstream packages change their dependency trees:

```json
{
  "@noble/hashes": "^2.0.0",
  "@ungap/structured-clone": "^1.3.0",
  "buffer": "^6.0.3",
  "event-target-polyfill": "^0.0.4",
  "react-native-get-random-values": "^1.11.0",
  "readable-stream": "^4.7.0",
  "web-streams-polyfill": "^4.1.0"
}
```

Keep this block in sync with [`packages/reference-app-rn/package.json`](../packages/reference-app-rn/package.json).

`@noble/hashes` deserves special attention: it provides the SHA-256/SHA-512 implementation used by both `polyfills/hermes.js` (lazy `require('@noble/hashes/sha2.js')` inside `crypto.subtle.digest`) and `polyfills/node-crypto.js` (`import { sha256 } from '@noble/hashes/sha2.js'`). The `.js` suffix matters: version 2.x lists only `./sha2.js` in its package.json `exports`. Metro still resolves a bare `@noble/hashes/sha2`, but only by falling back to file-based resolution and logging a warning on every bundle. It currently resolves transitively via libp2p, but the lockfile can carry multiple major versions simultaneously — the polyfills use the v2 import path, so the direct dep must be pinned `^2.0.0`.

#### Global polyfills (`polyfills/hermes.js`)

These patch `globalThis` to provide APIs that Hermes does not yet support:

| API | Required by | Notes |
|-----|-------------|-------|
| `process.env.DEBUG` (development builds only) | `debug`, for cadre-core's `sereus:cadre:timing` bring-up and founding timings | Set to `sereus:cadre:timing` as the file's first statement. Each bundled copy of `debug` reads the variable once when it loads, so it must be set before any library module loads. A value that is already set is left alone. See "Tracing a strand founding" |
| `crypto.getRandomValues()` | @noble/hashes, @libp2p/crypto, @noble/curves | via `react-native-get-random-values` (native CSPRNG). No Math.random fallback — without the native module any libp2p key generation is unsafe, so we want loud breakage rather than silent insecurity |
| `crypto.subtle.digest()` | multiformats/hashes/sha2-browser | Async SHA-256/SHA-512 via @noble/hashes |
| `structuredClone()` | @optimystic/db-core (transform tracker, cache-source, coordinator) | via `@ungap/structured-clone` (spec-compliant); handles Date, Map, Set, circular refs |
| `Symbol.asyncIterator` | `for await...of` on custom iterables | Some Hermes versions omit this. Guarded definition uses `Symbol.for('Symbol.asyncIterator')` (registry) so independent polyfills converge on the same symbol |
| `ReadableStream`, `WritableStream`, `TransformStream` | Vercel AI SDK, streaming libraries | via `web-streams-polyfill`. No-op under Expo SDK 53: Expo's Metro config adds `expo/virtual/streams.js` as a bundle polyfill, which runs before the entry module, and the 2026-09-16 device audit reported all three `native` |
| `Promise.withResolvers()` | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue, mortice, abort-error | ES2024 API |
| `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/utils, @libp2p/circuit-relay-v2, it-pushable, p-retry | DOM spec addition |
| Timer `.ref()` / `.unref()` | @optimystic/db-p2p, undici, libp2p internals | Wraps Hermes numeric timer IDs in objects; also patches `clearTimeout`/`clearInterval` to unwrap (see `hermes.js` `// ── Timer .ref() / .unref() ──` section) |
| `TextDecoder` | `uint8arrays` (via libp2p / multiformats / yamux) | UTF-8 only; throws `RangeError` for any other encoding. No-op on Expo SDK 52+, which installs one in `expo/src/winter/runtime.native.ts`; the 2026-09-16 device audit under SDK 53 reported it `native` |
| `DOMException` | `p-timeout` (via `p-queue` / `p-event`); the abort reasons below; `react-native-webrtc`'s `event-target-shim` when present | A named `Error` subclass: `name`, `message`, the legacy numeric `code`, `instanceof Error`. No static code constants, and `structuredClone` copies it as a plain `Error` (below) |
| `AbortSignal.timeout()` | libp2p's dial queue, connection pruner and registrar; @libp2p/circuit-relay-v2 reservations; @libp2p/websockets; @libp2p/identify | Without it every dial that carries no signal of its own throws `TypeError: AbortSignal.timeout is not a function` |
| `AbortSignal.any()` | @optimystic/db-p2p's repo client, `p-wait-for`, @quereus/quereus | Detaches its listeners from every input once the combined signal aborts. A combination none of whose inputs ever aborts keeps its listeners on those inputs: the DOM holds combined signals weakly and Hermes offers no equivalent. Optimystic's repo client hits this on every successful RPC (backlog `bug-abortsignal-any-leaks-listeners-on-hermes`) |
| `AbortSignal` abort reasons | everything that calls `controller.abort(err)` | React Native installs `abort-controller` 3.0.0, whose `abort()` takes no argument (below) |
| `WebSocket.prototype.bufferedAmount` | @libp2p/websockets | Reports `0`. React Native hands each frame straight to the native socket and keeps no JS-side queue, so nothing is ever pending from the caller's point of view (below) |

#### Other global polyfills

| File | Target | Required by | Notes |
|------|--------|-------------|-------|
| `packages/reference-app-rn/polyfills/intl-pluralrules.js` | `Intl.PluralRules` | moat-maker (error messages) | English-only ordinal/cardinal shim |
| `packages/reference-app-rn/polyfills/event.js` | `EventTarget`, `Event`, `CustomEvent` | libp2p, @libp2p/interface | Imports the [`event-target-polyfill`](https://www.npmjs.com/package/event-target-polyfill) npm package (spec-complete: handles `capture`, `once`, and `signal` options on `addEventListener`), then adds a minimal `CustomEvent` shim on top — `event-target-polyfill` does not include `CustomEvent`, which libp2p's `safeDispatchEvent` uses internally |

> A hand-rolled inline `EventTarget` class is technically sufficient for libp2p's current usage but quietly drops `once`, `signal`, and capture semantics. We prefer the npm package so future libp2p versions (or other consumers) that rely on those options keep working without surprises. The dependency must be listed in `package.json` — omitting it produces `Unable to resolve module event-target-polyfill` Metro failures.

#### Built-in APIs (no polyfill needed)

These APIs are natively available in the target Hermes/Expo versions used by this app. Do not add polyfills for them — it wastes bundle size and can cause subtle conflicts.

| API | Available since | Notes |
|-----|----------------|-------|
| `TextEncoder` | Hermes (all versions used by Expo SDK 49+) | See warning below |
| `TextDecoder` | Expo SDK 52+ (UTF-8 only) | Bare RN (non-Expo) Hermes through at least 0.85 does NOT ship this — `polyfills/hermes.js` has a UTF-8-only fallback. For non-UTF-8 encodings, use the `text-encoding` package. |
| `BigInt` | Hermes since RN 0.70 | |
| `crypto.getRandomValues` | RN 0.76+ with New Architecture | `react-native-get-random-values` still recommended as safety net |
| `queueMicrotask` | React Native, `Libraries/Core/setUpTimers.js` | Read by @libp2p/utils, @libp2p/circuit-relay-v2 and @libp2p/webrtc |
| `performance.now` | React Native, `Libraries/Core/setUpPerformance.js` | Read by `p-retry`, Quereus and cadre-core |
| `AbortController` / `AbortSignal` | React Native, `Libraries/Core/setUpXHR.js` | From the `abort-controller` npm package, which React Native installs over whatever the engine had. Missing `reason`, `timeout`, `any` and `throwIfAborted` — all four are added in `polyfills/hermes.js` |

> **Do not add `fast-text-encoding`.** Hermes has native `TextEncoder` in all Expo SDK 49+ versions. Adding the polyfill wastes bundle size (~4 KB) and can cause subtle double-encoding bugs when the polyfill's `TextEncoder` replaces the native one with slightly different `Uint8Array` subclass behavior. If your app currently depends on it, remove it.

#### Polyfill quality principles

- Prefer battle-tested npm packages over hand-rolled shims (e.g., `@ungap/structured-clone` over `JSON.parse(JSON.stringify(...))`)
- Prefer spec-compliant implementations — shortcuts like JSON round-trips silently drop data types
- Always guard with `typeof` checks so polyfills are skipped on platforms with native support
- Native modules (like `react-native-get-random-values`) require a dev client rebuild — document this when adding them

#### Metro module aliases (Node.js built-in shims)

These are configured in `metro.config.js` via `extraNodeModules` and map both `node:X` and bare `X` imports:

| Module | Target | Source | Required by |
|--------|--------|--------|-------------|
| `os` / `node:os` | `packages/reference-app-rn/polyfills/node-os.js` | Custom shim (networkInterfaces, platform, type, hostname) | @libp2p/utils |
| `crypto` / `node:crypto` | `packages/reference-app-rn/polyfills/node-crypto.js` | Custom shim — `createHash()` for SHA-256/SHA-512 via @noble/hashes | multiformats/hashes/sha2, @chainsafe/libp2p-noise crypto/index, @libp2p/crypto Node key modules (before the browser rewrite). *Not* cadre-core push — the FCM/APNs notifiers moved behind the Node-only `@serfab/cadre-core/push-node` subpath. |
| `stream` / `node:stream` | `readable-stream` (npm) | Metro `extraNodeModules` | libp2p stream handling |
| `buffer` / `node:buffer` | `buffer` (npm) | Metro `extraNodeModules` | libp2p, multiformats |
| `net` / `node:net` | `packages/reference-app-rn/polyfills/empty.js` | Empty stub | libp2p transitive imports — never reached at RN runtime, but needs to resolve so the bundle builds |
| `tls` / `node:tls` | `packages/reference-app-rn/polyfills/empty.js` | Empty stub | libp2p transitive imports — never reached at RN runtime, but needs to resolve so the bundle builds |

#### Commonly needed beyond core

The polyfills above cover the libp2p/Optimystic/AI stack. Apps building additional features may need:

| API | Package | When needed |
|-----|---------|-------------|
| `URL` / `URLSearchParams` | `react-native-url-polyfill` | If using URL constructor in app code (Hermes has partial support) |

### Bundle Smoke Test

`yarn test:bundle` runs `expo export --platform android` as a dry-run to catch import resolution failures without an EAS Build, then cleans up the output. This is suitable for CI.

## Package Structure

The app lives at `packages/reference-app-rn` as a workspace member. Yarn's workspace glob (`packages/*`) picks it up automatically.

```
packages/reference-app-rn/
  index.js                    # Custom entry: loads polyfills before expo-router/entry
  app.json                    # Expo config (SDK 53, custom dev client)
  package.json                # workspace:^ deps on cadre-core, db-p2p, etc.
  tsconfig.json
  metro.config.js             # Workspace symlink resolution for Metro
  eas.json                    # EAS Build profiles (development, preview)
  app/
    _layout.tsx               # Expo Router root layout
    index.tsx                 # Chat screen (message list + input)
    settings.tsx              # Bootstrap config (seed paste, drone address)
  src/
    cadre-phone.ts            # CadreNode setup: WS/WebRTC transports, LevelDB storage, seed apply
    secure-key-store.ts       # KeyStore over expo-secure-store (identity in the enclave)
    node-local-slots.ts       # DurableSlots for the owner anchor + bootstrap peers
    chat-strand.ts            # Strand lifecycle: create/join strand, load chat schema
    chat-operations.ts        # Quereus operations: insert message, query messages
    strand-selection.ts       # Which strand the chat screen is showing
    background-runner.ts      # AppState-driven hibernate / bounded resume
    app-state.ts              # AppState seam the runner is tested against
    push-wake.ts              # Platform-agnostic push-wake decision logic
    push-wake-native.ts       # Expo notifications wiring for push-wake
    connection-status.ts      # Derives UI connection state from node events
    ice-config.ts             # STUN/TURN servers from the runtime manifest
    cadre-context.tsx         # React context provider for the node
    use-chat.ts               # React hook: message list, send, connection status
    use-cadre.ts              # React hook: cadre lifecycle, seed application
  polyfills/
    hermes.js                 # Runtime globals: crypto, AbortSignal, WebSocket, structuredClone, etc.
    webrtc.js                 # react-native-webrtc registerGlobals() for @libp2p/webrtc
    intl-pluralrules.js       # Intl.PluralRules for moat-maker
    event.js                  # Event, CustomEvent, EventTarget globals for Hermes
    registry.js               # Records which globals each polyfill actually patched
    audit.js                  # Boot-time native/polyfilled/gap/MISSING table (__DEV__ only)
    node-os.js                # Minimal os module shim for libp2p
    node-crypto.js            # createHash() shim via @noble/hashes
  schemas/
    chat-simple.qsql          # Simplified chat schema (or inline string)
```

### Key Dependencies

| Package | Source | Purpose |
|---------|--------|---------|
| `@serfab/cadre-core` | `workspace:^` | CadreNode, seed bootstrap, strand management |
| `@optimystic/db-p2p` | npm | libp2p node creation (Metro resolves RN entrypoint) |
| `@optimystic/db-p2p-storage-rn` | npm | LevelDB-backed `IRawStorage` |
| `@quereus/quereus` | npm | SQL engine for sApp schema |
| `@libp2p/websockets` | npm | WebSocket transport |
| `@libp2p/circuit-relay-v2` | npm | Circuit relay transport |
| `rn-leveldb` | npm | Native KV store (requires native compilation) |
| `expo` | npm | Framework, dev client, EAS Build |
| `expo-router` | npm | File-based routing |
| `@babel/runtime` | npm | Helpers imported by Metro's Babel output; must be 7.29.2 or newer (below) |

**Babel helpers must be 7.29.2 or newer.** Hermes has no native async generators, so Metro's Babel transform rewrites them onto Babel's `wrapAsyncGenerator` helper, imported from `@babel/runtime` (or inlined from `@babel/helpers` for script sources). Before 7.29.2 that helper stopped a generator's `finally` at its first `await` when the consumer left a `for await` loop early. Quereus releases its execution lock in such a `finally`, so on the phone the first early-exit read (`strandTableCount`) left the lock held, and founding a strand hung at `StrandDatabase.bootstrapFounder`. Node runs async generators natively, so no headless test saw it. The app declares `@babel/runtime` `^7.29.2`, and `test/metro-babel/async-generator-cleanup.spec.ts` (Vitest project `metro-babel`) compiles an early-exit probe with the app's own Metro Babel transformer and fails, naming the upgrade, if any helper a bundle would use drops that cleanup. Upgrade inside Babel 7 with `yarn up -R @babel/runtime @babel/helpers` (a bare `yarn up` moves to Babel 8), then restart Metro with `--clear` so it recompiles.

#### The web APIs the phone's connectivity depends on

**Three of them decide whether the phone can dial at all.** Hermes provides no `AbortSignal.timeout`, no `AbortSignal.any`, and React Native's WebSocket has no `bufferedAmount` — on the instance or on the prototype — and libp2p reads all three on the dial path. `connection-manager/dial-queue.js` calls `AbortSignal.timeout(this.dialTimeout)` for any dial that does not carry its own signal, so without it every such dial threw `TypeError: AbortSignal.timeout is not a function`. `@libp2p/websockets` gates each write on `websocket.bufferedAmount < 4194304`, and `undefined < 4194304` is `false` — so the transport concluded the socket was full, waited for a drain event that could never arrive, and the dial died on the ten-second timeout as `AbortError: The operation was aborted` with nothing naming the cause. `polyfills/hermes.js` supplies all three. With them, a device session on 2026-09-16 connected in 1.6 s, held a relay reservation for the first time, and completed a cross-party `formStrand` through that relay.

**React Native drops abort reasons, which is why that failure was opaque.** `Libraries/Core/setUpXHR.js` installs the `abort-controller` npm package (3.0.0) as the global `AbortController`/`AbortSignal`, unconditionally replacing whatever the engine had. That release predates the DOM's `reason`: its `abort()` takes no argument and nothing ever defines `signal.reason`. Every `controller.abort(err)` in the bundle therefore lost its error, and `throwIfAborted` fell back to a generic `AbortError`. `polyfills/hermes.js` records the reason on the signal before delegating, so a dial timeout now surfaces as `TimeoutError` and a cancelled operation carries whatever the caller passed.

**`crypto.subtle` provides `digest` and nothing else.** The polyfill defines a `crypto.subtle` object with a single `digest` method. `@libp2p/crypto`'s `keys/index.js` calls `crypto.subtle.importKey` and `exportKey` for ECDSA and RSA keys, and `@libp2p/keychain` calls the AES-GCM surface (`encrypt`, `decrypt`, `deriveKey`) through `ciphers/aes-gcm.browser.js`. None of those exist, so any of them throws a `TypeError` the moment it is reached. The phone does not reach them: it uses Ed25519, whose browser variant is pure `@noble/curves`, and it does not use the libp2p keychain. This is a dormant path, not a working one — adding a second key type, or anything that wants the keychain, breaks immediately and needs real WebCrypto first.

**Checked during the same audit and found not to be gaps.** Each was read out of installed sources, and several were confirmed against the string table of an exported Android bundle (`dist/_expo/static/js/android/index-*.hbc` from `yarn test:bundle`) — a string that a module would have to contain is decisive about whether Metro bundled that module.

| API | Why it is not a gap |
|-----|---------------------|
| `queueMicrotask` | React Native installs it in `Libraries/Core/setUpTimers.js`, before the entry module runs |
| `performance.now` | React Native installs it in `Libraries/Core/setUpPerformance.js` |
| `BroadcastChannel` | Only `mortice`'s `browser` build needs it. `mortice` also ships `dist/src/react-native.js` and declares it in its package.json `react-native` field — a bare `TypedEventEmitter` with no channel at all — and Metro's default `resolverMainFields` puts `react-native` first. The exported bundle carries no `BroadcastChannel` string. (The NativeScript app resolves the `browser` variant instead, which is why it polyfills this and the RN app does not.) |
| `WebAssembly` | `@chainsafe/as-sha256` and `@chainsafe/as-chacha20poly1305` reach the graph only through `@chainsafe/libp2p-noise`, whose package.json `browser` field maps `crypto/index.js` to `crypto/index.browser.js` — noble ciphers and hashes, no WebAssembly. The exported bundle contains `pureJsCrypto` and neither `as-sha256` nor `as-chacha20poly1305` |
| `navigator.userAgent` | `libp2p`'s `user-agent.browser.js` reads it with no guard, but libp2p's package.json `react-native` field points at `user-agent.react-native.js` instead, which uses `Platform.OS`. The exported bundle contains `react-native/` and no `browser/`, so identify announces `js-libp2p/<version> react-native/android-<version>` — on the 2026-09-16 device run, `js-libp2p/3.1.3 react-native/android-29` |

Those last three all depend on Metro applying a package's `browser`/`react-native` subpath map to that package's own internal relative imports. `metro.config.js` hand-rewrites that map for `@libp2p/crypto` and `@libp2p/webrtc` because package `exports` resolution made it unreliable for them — so if a future bundle ever fails to resolve `@chainsafe/as-*`, or announces `browser/undefined` in identify, this is the mechanism that slipped.

**`AggregateError` is native.** `libp2p/dist/src/connection-manager/dial-queue.js` throws `new AggregateError(errors, 'All multiaddr dials failed')` when every address for a peer fails. The repo holds the `hermesc` compiler but no Hermes VM, so only a device could say whether Hermes (`hermes-2025-06-04-RNv0.79.3`) provides it. The boot audit on 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client) found it native, with `errors` and `message` intact and `instanceof Error` true, so a fully failed dial carries its per-address causes.

**`DOMException` is absent, and `polyfills/hermes.js` supplies a stand-in.** The same boot audit found `typeof DOMException === 'undefined'`. `p-timeout` 7 constructs one without checking — `signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')` — and it is pulled in by `p-queue` and `p-event`, with copies at the repo root and under `../optimystic` and `../Fret`. Without a global it throws `ReferenceError: DOMException is not defined` instead of the `AbortError` it meant. That path needs a signal aborted with no reason, which the abort-reason patch above should prevent for every `AbortController.abort()`; it has not been exercised on a device, and a signal aborted any other way would still reach it, so the stand-in makes it correct regardless. (`@expo/metro-runtime`'s `Location.native.ts` also contains `new DOMException(…)`, which is why a search of the dev bundle turns it up, but it declares its own module-local class and never reads the global.)

Three more modules check for a global `DOMException` and build their own class when there is none, so the stand-in only changes which class they use. `react-native-webrtc`'s copy of `event-target-shim` checks each time it raises an `InvalidStateError`, so it uses the stand-in. `whatwg-fetch` (React Native's `fetch`) checks once, when React Native first loads `fetch`; it uses the stand-in if that happens after `polyfills/hermes.js` runs. The streams polyfill Expo's Metro config injects (`expo/virtual/streams.js`) runs before `index.js`, so it always builds its own. The abort reasons the polyfill creates are also `DOMException`s now, as libp2p sees in browsers and Node. The stand-in is a named `Error` subclass with `name`, `message`, the DOM's legacy numeric `code` table and `instanceof Error`. It has no static code constants (`DOMException.ABORT_ERR`), and `@ungap/structured-clone` copies it as a plain `Error` with only the message. It is not the `domexception` npm package, which is a full WebIDL implementation built on `webidl-conversions` and much larger than the need.

#### Guards

| What | Where | What it catches |
|------|-------|-----------------|
| Behaviour of `polyfills/hermes.js` | `test/polyfills/hermes-polyfills.spec.ts` (Vitest project `polyfills`) | Evaluates the polyfill against a fake Hermes + React Native surface, then drives `@libp2p/websockets`' own `webSocketToMaConn` over a socket with no `bufferedAmount`. Deleting any arm fails a test rather than a phone |
| The next missing global | `test/polyfills/dependency-globals.spec.ts` | Reads a listed set of dependency `dist` trees and fails when a global that nothing provides starts appearing. A substring search over a hand-listed set of packages — it narrows the window, it does not close it; see the spec's header for what it cannot see |
| The real runtime | `polyfills/audit.js`, imported by `index.js` under `__DEV__` | Prints a `native` / `polyfilled` / `gap` / `MISSING` table at boot and warns loudly on anything MISSING. The only thing that notices when a React Native upgrade starts — or stops — providing one of these natively |

The audit tells `native` from `polyfilled` through `polyfills/registry.js`: each polyfill calls `markPolyfilled(key)` when its guard actually fires, so a `typeof` check at boot is not left guessing which of the two it is looking at. Two limits on that: `EventTarget` comes from the `event-target-polyfill` package, which does not mark the registry, so it always reads `native`; and a row the audit cannot read (a native getter that throws when read off a prototype) counts as present rather than crashing boot.

### Metro Configuration

Metro needs to resolve workspace symlinks, sibling repo packages, and Node.js built-in modules:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Resolve workspace roots for symlinked packages. `fretRoot` is required because
// @optimystic/db-p2p portals `p2p-fret` from the sibling ../Fret monorepo; Metro
// must be allowed to follow that symlink out of the tree or a local release
// bundle fails with "Unable to resolve module p2p-fret". On EAS the portal
// resolutions are stripped and p2p-fret resolves from npm, so — like the
// optimystic/quereus roots — this only matters for local bundling.
const workspaceRoot = path.resolve(__dirname, '../..');
const optimysticRoot = path.resolve(__dirname, '../../../optimystic');
const quereusRoot = path.resolve(__dirname, '../../../quereus');
const fretRoot = path.resolve(__dirname, '../../../Fret');

config.watchFolders = [workspaceRoot, optimysticRoot, quereusRoot, fretRoot];
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
  path.resolve(optimysticRoot, 'node_modules'),
  path.resolve(quereusRoot, 'node_modules'),
  path.resolve(fretRoot, 'node_modules'),
];

// Map Node.js built-ins to polyfills/npm packages
config.resolver.extraNodeModules = {
  'node:os': path.resolve(__dirname, 'polyfills/node-os.js'),
  'node:stream': require.resolve('readable-stream'),
  'node:buffer': require.resolve('buffer'),
  'node:crypto': path.resolve(__dirname, 'polyfills/node-crypto.js'),
  os: path.resolve(__dirname, 'polyfills/node-os.js'),
  stream: require.resolve('readable-stream'),
  buffer: require.resolve('buffer'),
  crypto: path.resolve(__dirname, 'polyfills/node-crypto.js'),
};

// Apply @libp2p/crypto's own `browser` map via resolveRequest — the package
// ships `.browser.js` variants (Ed25519/secp256k1/RSA/ECDH keys, webcrypto,
// hmac, aes-gcm) that use @noble/curves + WebCrypto instead of Node's crypto.
// With `unstable_enablePackageExports: true` Metro resolves via `exports` and
// does not reliably apply the `browser` rewrite on its own.  See
// `packages/reference-app-rn/metro.config.js` for the implementation.

module.exports = config;
```

> **Why the browser rewrite matters.** `@libp2p/crypto` has parallel
> `*.browser.js` variants for every module that would otherwise call
> `crypto.generateKeyPairSync`, `createPrivateKey`, `sign`, or `verify` from
> Node.js's built-in `crypto`.  Our `polyfills/node-crypto.js` intentionally
> only implements `createHash` (SHA-256/SHA-512 via `@noble/hashes`), so
> without the rewrite the first call to `generateKeyPair('Ed25519')` (phone
> peer identity, enrollment, strand solicitation) fails with
> `undefined cannot be used as a constructor`.  The rewrite is applied in
> Metro's `resolveRequest` hook — see `packages/reference-app-rn/metro.config.js`
> and `sereus-health/apps/mobile/metro.config.js` (same pattern).

## Two-Node Startup Sequence

This section walks through starting the drone and phone from scratch, establishing a connection, and chatting.

### Prerequisites

- Repo cloned, `yarn install` at root
- `cadre-cli` built: `cd packages/cadre-cli && yarn build`
- Expo dev client installed on a phone or emulator (see Build & Development Workflow)

### Step 1: Start the Drone

```bash
cd packages/cadre-cli
node dist/bin/cadre.js start \
  -c ../reference-app-rn/drone.cadre.yaml \
  --listen-for-seeds \
  --ws-port 4002
```

> `--ws-port 4002` is a convenience shorthand. The example `drone.cadre.yaml` already includes `/ip4/0.0.0.0/tcp/4002/ws` in `network.listenAddrs`, so the flag is optional when using that config as-is.

On startup the console prints:

```
Starting cadre node...
✓ Connected to control network
  Party ID: reference-chat-party
  Peer ID:  12D3KooW...
✓ Seed protocol listener enabled
Cadre node running. Press Ctrl+C to stop.
```

Note the **Peer ID** -- you'll need it in the next step.

### Step 2: Construct the Drone's Bootstrap Multiaddr

Combine the drone's IP, WebSocket port, and Peer ID into a multiaddr:

```
/ip4/<DRONE_IP>/tcp/4002/ws/p2p/<DRONE_PEER_ID>
```

For local development (phone and drone on the same machine or LAN):

```
/ip4/192.168.1.42/tcp/4002/ws/p2p/12D3KooWExamplePeerId...
```

> Use the machine's LAN IP, not `127.0.0.1`, if the phone is a separate device.

### Step 3: Connect the Phone

1. Open the Expo app on the phone (or emulator)
2. Go to the **Settings** tab
3. Enter:
   - **Party ID**: `reference-chat-party` (must match `controlNetwork.partyId` in the drone config)
   - **Bootstrap addr**: the multiaddr from Step 2
4. Tap **Connect**

The phone creates a `CadreNode` with WebSocket + circuit relay transports, dials the drone, and joins the control network. The status indicator should turn green.

### Step 4: Apply a Seed (if needed)

For the first connection, both nodes start with empty peer caches. The phone's outbound dial to the drone's bootstrap address is enough to establish the initial connection. The `--listen-for-seeds` flag on the drone means it can also accept seeds delivered via the `/sereus/seed/1.0.0` protocol.

If the nodes can't discover each other automatically (e.g., after a restart with stale state), you can manually exchange a seed:

1. On the owner side, generate and encode a seed:
   ```typescript
   const seed = await cadreNode.createSeed();
   const encoded = cadreNode.encodeSeed(seed); // base64url string
   ```
2. Paste the encoded seed into the **Seed** field on the phone's Settings screen and tap **Apply Seed**
3. Or apply via the drone's CLI: `--seed <base64url-encoded-seed>`

> **Cold-start trust.** A seed is signature-verified and its signer key must clear a trust anchor (`SeedTrustPolicy`) before it is accepted — the secure default (`anchoredTrustPolicy`) trusts only owner keys in the phone's node-local trusted-owner anchor, which is seeded out of band and never from replicated control state. A phone that has not been given the issuing cadre's owner key will therefore **reject** a seed signed by that cadre, no matter what its `OwnerKey` table has synced. To anchor trust, paste the issuer's `CadreInvite` (which carries `ownerKeys`) into the optional **Paste enrollment invite (for trust)** field in the Seed Bootstrap section before tapping **Apply Seed**; its keys are pinned for that apply via `pinnedKeyTrustPolicy` and persisted into the anchor, so later seeds from the same owner need no invite. Leave it blank when the phone already trusts the signer.

### Step 5: Create a Strand

1. On the phone's **Settings** tab, tap **Create Strand**
2. This calls `createChatStrand(cadreNode, uuid())` which:
   - Creates a `StrandRow` with `Type: 'o'` (open)
   - Registers the simplified chat sApp schema (Participant + Message tables)
   - Starts a strand-specific libp2p network (`strand-<strandId>`)
3. The drone (with `strandFilter: all`) automatically detects the new strand and joins

### Step 6: Chat

Switch to the **Chat** tab. Type a message and send. The message is:

1. Inserted into the local strand's Quereus database via `insertMessage()`
2. Replicated to the drone via Optimystic's P2P consensus
3. Visible on both nodes

Messages from the drone (if any are inserted programmatically) replicate back to the phone the same way. The chat screen polls for new messages every 2 seconds.

### Quick Reference

| Step | Command / Action |
|------|-----------------|
| Start drone | `node dist/bin/cadre.js start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds` |
| Note Peer ID | From drone console output |
| Build multiaddr | `/ip4/<IP>/tcp/4002/ws/p2p/<PEER_ID>` |
| Connect phone | Settings → enter Party ID + bootstrap addr → Connect |
| Create strand | Settings → Create Strand |
| Chat | Chat tab → type → send |


## Borrowing a Node From a cadre-host

The startup sequence above has you run the always-on node yourself, from the command line. The other way to get one is to ask a machine running **cadre-host** — the self-hosted manager (`docs/cadre-host.md`) — to lend your cadre a node. The phone drives that from **Settings → Host Node**.

This is a **manual acceptance check**, not something CI runs. The headless coverage is `packages/reference-app-rn/test/host-node-request.spec.ts` (the phone's side of the protocol, against a fake host) and `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts` (the same flow on the wire, with a real lent node — but with a Node-hosted requester, not a device).

### On the PC

```bash
cadre-host start                 # note the management port it binds
cadre-host grant issue           # prints the grant token to paste into the phone
```

### Reaching the host from the phone

The grant surface (`/grants`) is loopback-only in v1: the host's origin guard accepts a `Host` header of `127.0.0.1` or `localhost` and nothing else, so a LAN-IP URL answers `403 forbidden_origin`. Forward the port instead:

```bash
adb reverse tcp:<managementPort> tcp:<managementPort>
```

Then enter `http://127.0.0.1:<managementPort>` as the Host URL on the phone.

Two things `adb reverse` does **not** cover:

- **libp2p traffic.** The phone dials the lent node directly, so the phone must be on the **same Wi-Fi LAN** as the PC. `adb reverse` needs every port named up front, and a lent node's strand nodes listen on ports the OS picks at start, so forwarding the control port alone is not a working setup.
- **The Windows firewall.** Allow `node.exe` on private networks when prompted, or the phone's dial is dropped before it reaches the node.

### The run

1. Connect the phone solo (Settings → Connect, no bootstrap address).
2. Settings → **Host Node** → paste the Host URL and the grant token → **Request Node**.
3. The progress line advances through: asking the host, waiting for the node to start, adding it to the cadre, seeding it, connecting. A failure opens the usual modal, with the host's own wording underneath the plain-language message.

Expected result: the stages reach `connected`, and the lent node's peer id appears among the phone's control connections.

Disconnecting (Settings → Disconnect) while a request is running cancels it: the app drops the authorization it had given the lent node and asks the host to end the loan, then brings the node down. It waits a few seconds for that to finish — not indefinitely, so a host that has gone quiet cannot hold up a logout. If the wait runs out, the loan is left for the host's own UI or `cadre-host` CLI to end.

Reconnecting to the lent node after the app relaunches is only observable on a device once the party id persists across restarts (ticket `feat-rn-persist-node-start-options`). Until then the headless proof of that reconnect is the integration scenario named above.

### If the flow stalls

- **Stuck at "Adding the node to this cadre"** (the `authorizing` stage). That step writes to the control database. Run `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` and restart Metro with `--clear`: the Babel async-generator helper defect behind `rn-solo-founding-stall-on-device` left Quereus's lock held after an early-exit read, and it only exists in Metro's compiled bundle. The device-side confirmation of that fix is ticket `rn-solo-founding-device-run`, which has since landed.
- **Stuck at "Connecting to the node"**, then failing after 60 seconds. The phone reached the host over the forwarded port but cannot reach the node itself: check the Wi-Fi network and the firewall. The phone tries every address the host reported for the node, one at a time, giving each up to 8 seconds, so a few unreachable addresses (the PC's other network adapters, or LAN addresses a firewall drops) delay the connection by that much each but do not prevent it. The connect wait counts from the first dial, and the phone dials again whenever an attempt ends without a connection.

### Not covered here

- Strands on the lent node. A lent node launches no strand of its own — whether it should is ticket `always-on-nodes-host-strands-of-apps-they-do-not-run`.
- Reaching a host across the internet rather than a home LAN: ticket `feat-cadre-host-wan-grant-reachability`.
- Listing loans or ending one from the app. The host's own UI and `cadre-host` CLI do that.


## Build & Development Workflow

### First-Time Setup

1. `yarn install` at repo root (workspace hoists dependencies)
2. `npx eas build --profile development --platform android` (or ios) — cloud-compiles a dev client with `rn-leveldb` native module
3. Install the dev client APK/IPA on a device or emulator

### Iterating

1. Start the drone: `cd packages/cadre-cli && node dist/bin/cadre.js start -c drone.yaml --listen-for-seeds`
2. Start Metro: `yarn workspace @serfab/reference-app-rn start` (`expo start --dev-client`)
3. Open on device → app loads JS from Metro → iterate on changes without rebuilding native

Metro watches the whole sereus, optimystic, quereus and Fret roots, so a changed module in any of them reaches the phone while it is connected. For a scenario run that must not be interrupted, see Device test runs below.

### Device test runs

When Metro sends a development build a changed module, Fast Refresh applies it in place only if every chain of imports above that module ends at a React component module. Otherwise the whole app reloads, which is the case for the library and `dist` modules the node is built from, because `index.js` and `src/cadre-phone.ts` import them outside any component. The reload restarts the node and breaks whatever step of the scenario was running.

**What reaches the phone.** Measured against this app's Metro on 2026-09-16:

| Write during the run | Effect on the phone |
|---|---|
| A `.md` file anywhere (tickets, docs), or a commit | Nothing. `.md` is not a watched extension and `.git` is ignored |
| A watched extension (`.json`, `.db`, `.ts`, …) outside the app's module graph, such as `tickets/.logs/*.json` or optimystic's `tickets/.index/index.db` | An empty update: "Refreshing..." flashes and LogBox and any red box are cleared. No reload |
| A build that rewrites `dist` files with identical bytes | An empty update |
| A content change to a module the app bundles: this app's `src/`, a sereus workspace package it imports, or a linked `dist` file in optimystic, quereus or Fret | The module is sent, and the app reloads unless Fast Refresh can apply it |

Ticket, doc and commit writes never need to pause. On `yarn start`, the writes that must wait until the run ends are edits to bundled source and builds that change linked `dist` output. The optional watch narrowing (a Metro `blockList` for `tickets/`, `docs/` and similar) was measured to change none of this and is not configured; the note at `watchFolders` in `metro.config.js` says when to revisit it.

One reload does not come from a write. If the app's connection to Metro drops (Wi-Fi, a lost `adb reverse`, Metro restarted), the next time the app loads a module bundled lazily (a dynamic `import()` fetched from Metro, such as optimystic's `import('p2p-fret')`), it reloads with `Bundle Splitting – Metro disconnected`.

**Frozen dev server.** `yarn workspace @serfab/reference-app-rn start:frozen` runs `expo start --dev-client` with `CI=1`, which turns Metro's file watching off. No write anywhere reaches the phone, so other work does not need to pause. Differences from `yarn start`:

- A reload (from the dev menu or a red box) serves each module as Metro first read it, not as it is on disk now. To put a rebuilt dependency on the phone, restart Metro.
- There is no interactive terminal: no QR code and no `r`/`m`/`j` keys. Metro prints `Metro is running in CI mode, reloads are disabled. Remove CI=true to enable watch mode.` followed by `Waiting on http://localhost:8081`, and the dev client connects as usual (its recent-servers list, or `adb reverse tcp:8081 tcp:8081`).
- Expo does not register the session with its servers, so a signed-in dev client does not suggest the project in its list.
- A port in use is not replaced by a prompt for another one; pass `--port <n>`.

Confirmed on a device (2026-09-16): the dev client connected through `adb reverse tcp:8081 tcp:8081` and the deep link `sereus-chat://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`, and editing `polyfills/event.js` (a module imported outside components) and reverting it caused no reload, no JavaScript log lines and no `metro:observe` output.

**First launch on a cold Metro.** This applies to `yarn start` and `start:frozen` alike. After `yarn start --clear`, the dev client's first launch from the deep link gave up after about 10 s with "There was a problem loading the project. timeout" (okhttp `readResponseHeaders`): building the Android bundle on a cold cache takes about 20 s (4825 modules). Fetching the bundle once from the PC, then launching again, worked. Build the bundle before opening the app: start `metro:observe` first, which builds it when no client has loaded it yet (see below). To fetch it by hand instead, use the URL the observer prints on its first line (`bundle <url>`), which comes from Expo's manifest. Do not shorten it to `index.bundle?platform=android&dev=true`: the query carries transform options (`transform.engine=hermes` and others), and a bundle requested with different options is a different build.

**Why it reloaded.** Development builds log a line before any reload that starts in JavaScript (`polyfills/reload-reason.js`), as a warning that logcat shows before the next `Running "main"`:

```
W ReactNativeJS: [reload] Bundle Splitting – Metro disconnected
W ReactNativeJS: '[reload] (no reason given) caller:', 'Error: reload caller\n    at logReload (http://127.0.0.1:8081/...)\n    at anonymous (...)\n    at reload (...)\n    at performFullRefresh (...)\n    at metroHotUpdateModule (...)\n    at injectUpdate (...)\n ...'
```

The no-reason line passes the text and the stack as two arguments, so logcat prints both quoted and comma-separated on one line, with the stack's newlines escaped as `\n`. Search with `grep '\[reload\]'`; a search for `caller: Error` does not match. The `Bundle Splitting` line has one argument; its shape above is inferred and has not been seen on a device.

| Line | Meaning |
|---|---|
| `(no reason given)`, with `performFullRefresh` in the caller stack | Metro sent a changed module Fast Refresh could not apply. Metro's own reason (`No root boundary` and similar) is lost, because it reloads through Expo's `window.location.reload()`, which passes none. Hermes names the callers: `performFullRefresh`, then `metroHotUpdateModule` and `injectUpdate`. The observer below names the module |
| `(no reason given)` with any other caller | Some other JavaScript called `DevSettings.reload()`; the stack names it |
| `Bundle Splitting – Metro disconnected` | The connection to Metro had closed, and the app then loaded a lazily bundled module. React Native also logs a `Disconnected from Metro` warning when the connection drops |

`Running "main" with {...}` is logged once per JavaScript start: at launch, after a Fast Refresh full reload, and after the dev menu's Reload (all three seen on a device on 2026-09-16). A `Running "main"` with no `[reload]` line before it was started natively: the dev menu's Reload (on the device it printed none), `r` in the Metro terminal, or the app process restarting. Do not use `I ReactNativeJS: log level = info` as a restart marker: it is also logged by a different process (a different pid in logcat), including about every 15 minutes, probably the background task. The `Bundle Splitting` path has not been checked on a device; its reading comes from React Native 0.79 and Expo SDK sources.

**Which file reached the phone.** With Metro running under `yarn start`, run in a second terminal:

```
yarn workspace @serfab/reference-app-rn metro:observe [--port <n>]
```

It attaches to the bundle the dev client loads (read from Metro's manifest) and prints each update that adds, modifies or deletes modules, with local timestamps in logcat's format:

```
09-16 21:43:24.439 update: 1 modified, 0 added, 0 deleted
    modified packages/reference-app-rn/src/connection-status.bundle
```

Paths are relative to the sereus root, with the file extension replaced by `.bundle`; a sibling repo's module starts with `../optimystic/` and so on. Empty updates print nothing. Confirmed on a device under `yarn start`: writing, modifying and deleting `.md` and `.json` files under `tickets/` produced no observer output and no JavaScript log lines. If no client has loaded the bundle yet, the script builds it once before attaching, which can take a minute on a cold Metro. Attaching does not change what the phone receives; whether it has any visible effect on the phone has not been checked. Under `start:frozen` it prints nothing. When Metro stops, it prints `Metro closed the HMR socket` and exits with code 1.

The observer's block and the phone's `[reload]` line appear at the same moment. On a device, an edit to `polyfills/event.js` printed the observer block at 22:37:48.281 (PC clock) and the `[reload]` line at 22:37:47.715 (phone clock), with the phone clock about 0.65 s behind the PC, then `Running "main"` about 8 s later. When matching the two logs, allow for the offset between the phone's clock and the PC's rather than expecting one line to come first.

### When Native Rebuild Is Needed

Only when `rn-leveldb` or another native dependency version changes. Otherwise, JS-only iteration via the dev client.

### Tracing a strand founding

While a strand is being created, the pressed create button in Settings shows elapsed seconds, both create buttons are disabled until it settles, and a "still running" hint appears under the pressed button after 30 s. Nothing gives up at that point: founding is resumable, so reporting a failure would leave a strand the user believes was never created. The result modal reports the elapsed time on a line under its title.

Every build logs the Settings handler at both ends (`adb logcat -s ReactNativeJS`):

```
I ReactNativeJS: [settings] create strand 1a2b3c4d pressed
I ReactNativeJS: [settings] create strand 1a2b3c4d succeeded in 1400 ms
```

A failure is a `W` line, `failed after <n> ms:` followed by the error. No `pressed` line after a tap means the tap never reached the handler.

Development builds also log cadre-core's `sereus:cadre:timing` lines as `D ReactNativeJS` (enabled in `polyfills/hermes.js`). Each awaited step of `CadreNode.foundStrand` and of the strand launch logs a line when it starts and another when it ends, so a step with a start and no end is the one that hung:

```
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: start +0ms
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: 21ms +21ms
D ReactNativeJS: sereus:cadre:timing [startOrFoundStrand:<id>] strandManager.startStrand: start +0ms
D ReactNativeJS: 'sereus:cadre:timing [buildStrandRuntime:%s] createLibp2pNode: %dms +35ms', '<id>', 35
```

The trailing `+<n>ms` is `debug`'s time since that namespace's previous line. The last line shows how the older timing lines print on the device: they pass their values as `%s`/`%d` arguments, and React Native's console prints the placeholders unfilled with the values after them, rather than substituting them as a browser console does.

The headless counterpart is `test/solo-founding.spec.ts`: it builds the node from the app's own `src/phone-node-config.ts` over the rn-leveldb adapter (with an in-memory fake of the native module) and founds an open and a closed strand under a 10 s deadline. It runs library code as published, so it cannot catch a stall that only occurs in Metro's Babel-compiled bundle; Maestro flow 4 covers the device. The one such stall found so far, the Babel helper defect under Key Dependencies, has its own headless guard in `test/metro-babel/async-generator-cleanup.spec.ts`.

## Testing Strategy

### Phase 1: Manual Smoke Test

- Start drone, start app, paste seed, send messages, verify bidirectional replication
- Validates the full stack on a real device

### Phase 2: Scripted Integration

Local runnable via `yarn workspace @serfab/reference-app-rn test:e2e`. The
`scripts/run-e2e.mjs` orchestrator:

1. Spawns `test-fixture/start.mjs` (in-memory drone with WS + HTTP sidecar)
2. Waits for `GET http://127.0.0.1:4080/health` to return 200
3. Reads `test-fixture/test-data.json` for `partyId`, `droneBootstrapAddr`,
   `seed`, `strandId`, `enrollInvite`
4. Runs `adb reverse tcp:4002` and `tcp:4080` so the Android emulator can
   reach the host-bound fixture
5. Spawns Maestro against `maestro/flows/`, passing the test-data fields as
   `-e KEY=VALUE` env vars
6. Tears down the fixture + adb reverse rules on exit

#### Prerequisites

- Android emulator running, with the dev-client APK installed
- `adb` on PATH
- [Maestro CLI](https://maestro.mobile.dev/getting-started/installing-maestro)
  on PATH (`maestro` binary)

#### Flows

| Flow | What it covers |
|------|----------------|
| `flows/1-connect-and-send.yaml` | Cold launch → connect → seed → create strand → send message → local echo |
| `flows/2-drone-to-phone.yaml` | Drone-side HTTP insert appears in phone chat within 5s |
| `flows/3-round-trip.yaml` | Bidirectional: phone send seen by drone; drone send seen by phone; both visible |
| `flows/4-solo-create-strand.yaml` | No drone: connect alone (empty party id and bootstrap) → create strand → result modal with its elapsed time |

Flows 1–3 share `_setup.yaml` for the connect/seed/strand bootstrap. Flow 4 connects alone and does not use it; the orchestrator still runs it with the rest of the directory, and it can be run by itself with `maestro test -e MAESTRO_APP_ID=… maestro/flows/4-solo-create-strand.yaml`.

Under the secure-default seed-trust policy (`anchoredTrustPolicy`), the cold
phone would reject the drone's seed because the drone's owner key is not in its
node-local trusted-owner anchor — and control-sync can never put it there. To
make the apply step work at all, the drone fixture enrolls its own owner key
(`ensureOwnerKey`) and mints a `CadreInvite` carrying it; `start.mjs` writes
this as `enrollInvite`, the orchestrator threads it in as `ENROLL_INVITE`, and
`_setup.yaml` pastes it into `input-enroll-invite` before tapping **Apply Seed**
so the phone pins the drone owner out-of-band (`pinnedKeyTrustPolicy`) for
that one apply. The success-modal title stays `"Seed applied"` (only the body
text changes), so the assertion is unchanged.

After the phone creates its strand, `_helpers/discover-phone-strand.js`
polls the drone's `/status` endpoint to discover the strand the drone has
joined via `strandFilter:all` control-network sync — drone-side inserts
target this strand so both nodes reference the same database.

Maestro Cloud can run the same `maestro/flows/` directory in CI without
local emulators; the orchestrator script is local-runnable only.

### Phase 3: Convergence Tests

- Extend integration tests to verify Optimystic convergence properties:
  - Concurrent inserts from both nodes resolve correctly
  - Temporary disconnection → reconnection → sync catches up
  - Strand hibernation and wake cycle works on RN

## Multi-Party Strand Topology

Phases 1–6 exercise a single cadre (one party, two nodes). The next level of realism is **cross-party strands** — two independent parties, each with their own cadre, sharing a strand.

```
  Party A cadre                          Party B cadre
┌──────────────────────┐              ┌──────────────────────┐
│  phone-A  ←WS→  drone-A  │←─ strand network ─→│  drone-B  ←WS→  phone-B  │
│  (owner)    (storage) │              │  (storage)    (owner) │
└──────────────────────┘              └──────────────────────┘
        control-A                              control-B
   (intra-cadre only)                     (intra-cadre only)
```

Each party runs its own **control network** (cadre coordination is party-private). The **strand network** is shared across both parties — all four nodes (phone-A, drone-A, drone-B, phone-B) participate in the same FRET DHT and Optimystic replication for that strand.

### Open vs Closed Strands

| Aspect | Open (`'o'`) | Closed (`'c'`) |
|--------|-------------|----------------|
| Membership | Any peer can join | Invitation required |
| Read access | Unrestricted | Members only |
| Write access | Controlled by sApp schema | Controlled by sApp schema + membership |
| Strand schema tables | All declared, only `Header` populated (`OnlyClosed` rejects the membership writes; `ConsumedInvite`/`MemberPeer` need a `Member` row that cannot exist) | All populated: `Header`, `Invite`/`ConsumedInvite`/`CancelledInvite`, `Member`, `MemberPeer`, `Manager`, `Revocation` |
| Use case | Public channels, announcements | Private chats, group DMs |

### Strand Formation Flow (cross-party)

For **closed strands** (private/invited):

1. Party A creates an `OpenInvitation` containing a token, sAppId, and bootstrap addresses for A's cadre
2. Invitation is shared out-of-band (JSON paste, deep link, etc.)
3. Party B calls `formStrand(invitation)` — this dials Party A's cadre via the native formation transport, negotiates strand creation
4. The responder (A) provisions the strand and inserts B as a member
5. Both parties' cadre nodes join the strand network and begin replication

For **open strands**:

1. Party A creates a strand with `Type = 'o'` and publishes a join token or strand ID
2. Party B joins by referencing the strand — no invitation signature flow needed
3. Both parties' cadres replicate via the shared strand network

### Orchestration for Testing

The reference app needs a way to script multi-party scenarios. The approach:

- **Phone nodes**: RN app instances (or, for CI, a headless test driver using cadre-core directly)
- **Drone nodes**: `cadre-cli start` processes with YAML configs
- **Orchestrator**: A test script (Node.js) that spawns drone processes, generates seeds, feeds invitations between parties, and asserts convergence — similar in spirit to the `TestCadreNetwork` harness in `packages/integration-tests`

---

