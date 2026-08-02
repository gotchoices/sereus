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
│  db-p2p-storage-rn (LevelDB)│                       │  db-p2p-storage-fs     │
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

The phone supplies WebSocket + circuit relay transports via `CadreNodeConfig.network`:

```typescript
network: {
  transports: [webSockets(), circuitRelayTransport()],
  listenAddrs: []  // Cannot listen in RN
}
```

### How It Connects

`cadre-core` already passes `config.network.transports` and `config.network.listenAddrs` through to `createLibp2pNode()` for both the control node and strand instances. The `@optimystic/db-p2p` package has a `react-native` export condition that Metro resolves automatically—when the RN bundler encounters `import from '@optimystic/db-p2p'`, it resolves to `rn.js` (which does not import `@libp2p/tcp`).

## Simplified Chat Schema

The production `schemas/chat.qsql` has full cryptographic signature verification on every operation. For the reference app, we use a permissionless schema that lets anyone insert/update/delete freely:

```sql
declare schema Chat {
    table Member (
        Id text primary key,
        Name text not null check (length(Name) between 1 and 100)
    );

    table Message (
        -- Text UUID primary key: each peer generates it locally so concurrent
        -- posts into a shared strand never collide. A max(Id)+1 integer key read
        -- from the local replica would collide before either side replicates.
        Id text primary key,
        MemberId text not null,
        Content text not null,
        Timestamp datetime not null,
        foreign key (MemberId) references Member(Id)
    );
}
```

No signature verification, no invite flow, no authorization constraints. This keeps the reference app focused on the P2P plumbing rather than application-level crypto.

## Node-Local Persistence

Three things the phone node keeps *locally* — never replicated, never derivable from the network — and where each lives.

### Peer identity (secure enclave)

The phone node maintains a stable PeerId across app restarts:

1. **First launch** — cadre-core generates an Ed25519 keypair and stores it through `SecureStoreKeyStore` (`src/secure-key-store.ts`), a `KeyStore` over `expo-secure-store`: iOS Keychain / Android Keystore-encrypted preferences, under the reserved `sereus.ks.` key prefix plus a `__index` entry listing the keyIds it holds.
2. **Subsequent launches** — the key is loaded from the enclave, producing the same PeerId every time.
3. **Single identity** — the same key is used for both the control network and all strand networks, matching the one-key-per-device architecture.

Gating: the store is opened **ungated** (no `requireAuthentication`) with `keychainAccessible: AFTER_FIRST_UNLOCK`, because the node must come up headless on a push wake while the device is locked, and because a biometric-set change would invalidate the entry. An earlier version of the app kept the key in plaintext MMKV, then plaintext LevelDB; `migrateLegacyIdentity` lifts a pre-existing plaintext identity into the enclave once on upgrade and deletes the legacy database.

### Trusted-owner anchor (secure enclave)

The set of owner public keys this device believes speak for its party — what seed acceptance, wake authorization, and vouching all check against. Persisted by cadre-core's `PersistentTrustedOwnerStore` over a `DurableSlot` the app supplies: one `expo-secure-store` entry under its own `sereus.anchor.<base64url partyId>` key (`src/node-local-slots.ts`). Deliberately *not* under the key store's `sereus.ks.` prefix, whose `__index` must never see a foreign entry.

The anchor is not secret but it **is** trust-bearing — anything that can silently edit it can make this device trust a stranger — so it gets the most tamper-resistant store the app has, and shares the identity key's fate (including surviving an iOS reinstall, which is the desirable direction: same peer id, same trusted owners). The slot is ungated for the same headless reason as above, and `secureStoreSlot` **refuses** a gated slot outright: its "a `null` read means absent" mapping would misreport a biometric-invalidated anchor as empty, and the next snapshot write would make that permanent.

### Cold-start bootstrap peers (app-private LevelDB)

The dial targets retained from every seed the node has applied — the only addresses a stranded node has to re-dial its way back into the party. Persisted by cadre-core's `PersistentBootstrapPeerStore` over a `kvStoreSlot`: one key of a `LevelDBKVStore` in the app-private `sereus-node-local` database, separate from any strand's database so clearing it cannot disturb replicated data.

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
import './polyfills/hermes';          // Runtime globals (crypto, structuredClone, etc.)
import './polyfills/intl-pluralrules'; // Intl.PluralRules for moat-maker
import './polyfills/event';            // Event, CustomEvent, EventTarget for libp2p
import 'expo-router/entry';           // App code starts here
```

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

`@noble/hashes` deserves special attention: it provides the SHA-256/SHA-512 implementation used by both `polyfills/hermes.js` (lazy `require('@noble/hashes/sha2')` inside `crypto.subtle.digest`) and `polyfills/node-crypto.js` (`import { sha256 } from '@noble/hashes/sha2'`). It currently resolves transitively via libp2p, but the lockfile can carry multiple major versions simultaneously — the polyfills use the v2 import path, so the direct dep must be pinned `^2.0.0`.

#### Global polyfills (`polyfills/hermes.js`)

These patch `globalThis` to provide APIs that Hermes does not yet support:

| API | Required by | Notes |
|-----|-------------|-------|
| `crypto.getRandomValues()` | @noble/hashes, @libp2p/crypto, @noble/curves | via `react-native-get-random-values` (native CSPRNG). No Math.random fallback — without the native module any libp2p key generation is unsafe, so we want loud breakage rather than silent insecurity |
| `crypto.subtle.digest()` | multiformats/hashes/sha2-browser | Async SHA-256/SHA-512 via @noble/hashes |
| `structuredClone()` | @optimystic/db-core (transform tracker, cache-source, coordinator) | via `@ungap/structured-clone` (spec-compliant); handles Date, Map, Set, circular refs |
| `Symbol.asyncIterator` | `for await...of` on custom iterables | Some Hermes versions omit this. Guarded definition uses `Symbol.for('Symbol.asyncIterator')` (registry) so independent polyfills converge on the same symbol |
| `ReadableStream`, `WritableStream`, `TransformStream` | Vercel AI SDK, streaming libraries | via `web-streams-polyfill` |
| `Promise.withResolvers()` | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue, mortice, abort-error | ES2024 API |
| `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/utils, @libp2p/circuit-relay-v2, it-pushable, p-retry | DOM spec addition |
| Timer `.ref()` / `.unref()` | @optimystic/db-p2p, undici, libp2p internals | Wraps Hermes numeric timer IDs in objects; also patches `clearTimeout`/`clearInterval` to unwrap (see `hermes.js` `// ── Timer .ref() / .unref() ──` section) |

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
    hermes.js                 # Runtime globals: crypto, structuredClone, Promise.withResolvers, etc.
    intl-pluralrules.js       # Intl.PluralRules for moat-maker
    event.js                  # Event, CustomEvent, EventTarget globals for Hermes
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
   - Registers the simplified chat sApp schema (Member + Message tables)
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


## Build & Development Workflow

### First-Time Setup

1. `yarn install` at repo root (workspace hoists dependencies)
2. `npx eas build --profile development --platform android` (or ios) — cloud-compiles a dev client with `rn-leveldb` native module
3. Install the dev client APK/IPA on a device or emulator

### Iterating

1. Start the drone: `cd packages/cadre-cli && node dist/bin/cadre.js start -c drone.yaml --listen-for-seeds`
2. Start Metro: `cd packages/reference-app-rn && npx expo start --dev-client`
3. Open on device → app loads JS from Metro → iterate on changes without rebuilding native

### When Native Rebuild Is Needed

Only when `rn-leveldb` or another native dependency version changes. Otherwise, JS-only iteration via the dev client.

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

All three flows share `_setup.yaml` for the connect/seed/strand bootstrap.

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
3. Party B calls `formStrand(invitation)` — this dials Party A's cadre via `strand-proto`, negotiates strand creation
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

