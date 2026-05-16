# Sereus P2P Chat — React Native Reference App

A minimal peer-to-peer chat app built on the Sereus cadre system. Demonstrates strand creation, cadre networking, and real-time messaging between phones and drone servers — all over libp2p with no central server.

## Architecture Overview

```
Phone (this app)                        Drone (cadre-cli)
─────────────────                       ─────────────────
CadreNode (transaction profile)  ←────→ CadreNode (storage profile)
  ├─ Control network sync                 ├─ Control network sync
  ├─ Strand instances (chat DBs)          ├─ Strand instances (persistent)
  └─ WebSocket + Circuit Relay            └─ TCP + WebSocket listener
```

The phone runs a **transaction-profile** node (lightweight, intermittent) while the drone runs a **storage-profile** node (always-on, persists data). They sync over a shared control network identified by a Party ID.

**Strands** are isolated P2P databases. Each chat strand has `Member` and `Message` tables running on Optimystic (distributed serializable transactions) with Quereus as the SQL engine.

## Prerequisites

- Node.js 22+
- Yarn (workspace-aware)
- Android SDK (for Android) or Xcode (for iOS)
- Expo dev client (`expo-dev-client`)
- The sibling `optimystic` and `quereus` repos cloned alongside `sereus`:
  ```
  projects/
  ├── sereus/       # this repo
  ├── optimystic/
  └── quereus/
  ```

## Quick Start (App First — No Drone)

You can start the app standalone, chat locally, and add a drone later.

### 1. Build workspace dependencies

From the sereus monorepo root:

```bash
yarn install
yarn build   # builds cadre-core and other workspace packages
```

### 2. Run the app

```bash
cd packages/reference-app-rn
yarn android    # or: yarn ios
yarn start --host localhost
```

For Android emulators, forward the Metro port:

```bash
adb reverse tcp:8081 tcp:8081
```

On Windows, set the Java path for Android builds:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
```

### 3. Start a local strand

1. In **Settings**, enter a **Party ID** (or leave blank for auto-generated) and tap **Connect** — leave Bootstrap addr empty
2. Tap **Create Chat Strand**
3. Switch to the **Chat** tab and start messaging

Messages are stored locally in MMKV. The node operates solo in "forming" mode — no network required yet.

### 4. Add a drone later

Start the drone server:

```bash
cd packages/cadre-cli
npx cadre start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds
```

Note the **Peer ID** from the console output. Back in the app's **Settings** tab (while still connected), use **Add Peer** to dial the drone:

```
/ip4/<drone-ip>/tcp/4002/ws/p2p/<drone-peer-id>
```

The drone joins the control network and syncs your strands — no need to disconnect and reconnect.

Alternatively, you can apply a **seed** (base64url-encoded bootstrap payload) in the Seed Bootstrap section, or paste the drone address during initial connect.

## Quick Start (With Drone)

If you want the drone running from the start:

### 1. Start the drone

```bash
cd packages/cadre-cli
npx cadre start -c ../reference-app-rn/drone.cadre.yaml --listen-for-seeds
```

The drone config (`drone.cadre.yaml`) uses:
- Party ID: `reference-chat-party`
- WebSocket on port `4002` (phones can't use raw TCP)
- Circuit relay enabled (for NAT traversal)

### 2. Run the app and connect

In **Settings**:

1. **Party ID** — enter `reference-chat-party` (must match the drone config)
2. **Bootstrap addr** — enter the drone's WebSocket multiaddr:
   ```
   /ip4/<drone-ip>/tcp/4002/ws/p2p/<drone-peer-id>
   ```
   For a local emulator, use your machine's LAN IP (not `127.0.0.1`).
3. Tap **Connect**

### 3. Create a strand and chat

1. In **Settings**, tap **Create Chat Strand**
2. Switch to **Chat** — type and send

The drone automatically joins all strands (`strandFilter: all`), so it syncs immediately.

## Connecting Multiple Users

Each phone runs its own CadreNode. To chat between two phones:

1. Start the drone — it acts as the rendezvous point
2. Both phones connect to the same Party ID and drone bootstrap address (at startup or via **Add Peer** later)
3. Phone A creates a strand
4. Phone B sees the strand via control network sync and auto-joins
5. Both phones can now send and receive messages on the shared strand

## Scripts

| Script | Description |
|--------|-------------|
| `yarn start` | Start Expo dev server |
| `yarn android` | Build and run on Android |
| `yarn ios` | Build and run on iOS |
| `yarn build:dev` | EAS cloud build (development profile) |
| `yarn build:preview` | EAS cloud build (preview profile) |
| `yarn test:bundle` | Verify the Metro bundle compiles for Android |
| `yarn test:e2e` | Run the Maestro e2e suite against a local drone fixture (see below) |

## E2E Tests (Maestro)

`yarn test:e2e` runs a Maestro suite against a locally-spawned drone fixture.
The orchestrator (`scripts/run-e2e.mjs`):

1. Spawns the drone fixture (`test-fixture/start.mjs`) — in-memory CadreNode +
   HTTP sidecar on port 4080
2. Waits for `/health`
3. `adb reverse tcp:4002` + `tcp:4080` so the emulator can reach host loopback
4. Runs `maestro test maestro/flows/ -e PARTY_ID=… -e BOOTSTRAP_ADDR=… …`

### Prerequisites

- **Android emulator** running with the dev-client APK installed
  (`yarn android` once produces a usable build)
- **`adb`** on PATH (Android SDK platform-tools)
- **Maestro CLI** on PATH —
  [install](https://maestro.mobile.dev/getting-started/installing-maestro)
- iOS support is not wired in `run-e2e.mjs`; the YAML flows themselves are
  platform-agnostic

### Flow inventory

| File | What it covers |
|------|----------------|
| `maestro/_setup.yaml` | Connect, apply seed, create strand, discover the shared strand |
| `maestro/flows/1-connect-and-send.yaml` | Send a message; local echo appears |
| `maestro/flows/2-drone-to-phone.yaml` | Drone HTTP insert → phone displays it |
| `maestro/flows/3-round-trip.yaml` | Phone send → drone sees; drone send → phone sees; both visible |

### Artifacts

- `maestro/.fixture.log` — full stdout/stderr from the drone fixture
- `maestro/.maestro-junit.xml` — JUnit report from Maestro
- `test-fixture/test-data.json` — emitted by the fixture each run; gitignored

### Troubleshooting

- **"adb reverse" warning**: emulator not running, or wrong device default —
  run `adb devices` to confirm and `emulator -avd <name>` to start one.
- **Connection fails / "Connection failed" modal**: the WS dial from the
  emulator's `127.0.0.1:4002` did not tunnel to host. Verify
  `adb reverse --list` shows both rules; if `adb reverse` is not supported on
  the device, override `BOOTSTRAP_ADDR` to use `10.0.2.2:4002` instead and
  pass it through `run-e2e.mjs`.
- **`maestro: command not found`**: install Maestro per the link above;
  override `MAESTRO_BIN=/path/to/maestro` if not on PATH.

## Project Structure

```
reference-app-rn/
├── app/                    # Expo Router screens
│   ├── _layout.tsx         #   Tab navigator (Chat + Settings)
│   ├── index.tsx           #   Chat screen — message list & input
│   └── settings.tsx        #   Settings — connect, dial peers, create strands
├── src/
│   ├── cadre-phone.ts      #   CadreNode singleton (WebSocket + MMKV config)
│   ├── use-cadre.ts        #   React hook: node lifecycle & strand events
│   ├── use-chat.ts         #   React hook: message polling & send
│   ├── chat-strand.ts      #   Strand creation with embedded chat schema
│   └── chat-operations.ts  #   SQL helpers (insert/query members & messages)
├── polyfills/              # Hermes runtime polyfills (see "Hermes Polyfills" section below)
├── drone.cadre.yaml        # Drone server config for local development
├── metro.config.js         # Bundler config (workspace symlinks + Node.js polyfills)
└── app.json                # Expo app manifest
```

## Key Concepts

**Control network** — The shared Optimystic network (keyed by Party ID) where nodes discover each other and advertise strands.

**Strand** — An isolated P2P database. The chat app creates strands of type `'o'` (open), meaning any connected node can participate.

**Transaction vs storage profile** — Transaction nodes (phones) participate in consensus but don't persist long-term; storage nodes (drones) archive everything and stay online.

**Seed** — A bootstrap payload containing peer addresses for joining an existing cadre. Paste a base64url seed in Settings to skip manual address entry.

## Hermes Polyfills

React Native uses the [Hermes](https://hermesengine.dev/) JS engine, which is fast but missing many Web/Node.js APIs that libp2p, Optimystic, and their dependencies expect. This app ships a set of polyfills in `polyfills/` that **must be imported before any library code** — see `index.js`.

### How it works

1. **`index.js`** imports polyfills in order, then hands off to Expo Router
2. **`metro.config.js`** maps Node.js built-in modules (`node:crypto`, `node:os`) to local shim files via `extraNodeModules`, and rewrites `@libp2p/crypto`'s Node files to their `.browser.js` variants (see *libp2p/crypto Node → browser rewrite* below)

### Polyfill inventory

| File | What it polyfills | Required by |
|------|-------------------|-------------|
| `hermes.js` | `crypto.getRandomValues()` (via `react-native-get-random-values`, no Math.random fallback) | @noble/hashes, @libp2p/crypto, @noble/curves |
| `hermes.js` | `crypto.subtle.digest()` | multiformats/hashes/sha2 (browser variant) |
| `hermes.js` | `TextDecoder` (UTF-8 only) | uint8arrays/util/bases (module-scope `new TextDecoder('utf8')` pulled in by libp2p/yamux/multiformats). No-op on Expo SDK 52+ Hermes; required on bare RN. |
| `hermes.js` | `structuredClone()` | @optimystic/db-core (transform tracker, cache-source, coordinator) |
| `hermes.js` | `Symbol.asyncIterator` (via `Symbol.for(...)` registry) | `for await...of` on custom iterables |
| `hermes.js` | `ReadableStream`, `WritableStream`, `TransformStream` | Vercel AI SDK, streaming libraries |
| `hermes.js` | `Promise.withResolvers()` (ES2024) | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue, mortice, abort-error |
| `hermes.js` | `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/utils, @libp2p/circuit-relay-v2, it-pushable, p-retry |
| `hermes.js` | Timer `.ref()` / `.unref()` wrappers | @optimystic/db-p2p, undici, libp2p internals |
| `event.js` | `EventTarget`, `Event` (via `event-target-polyfill` npm), `CustomEvent` (inline) | libp2p, @libp2p/interface |
| `intl-pluralrules.js` | `Intl.PluralRules` (English-only) | moat-maker (error messages) |
| `node-crypto.js` | `createHash()` (sha256, sha512) | multiformats/hashes/sha2 (Node variant) |
| `node-os.js` | `networkInterfaces()`, `platform()`, etc. | @libp2p/utils (network detection) |
| `empty.js` | `net`, `tls` empty stubs | libp2p transitive imports — never reached at RN runtime, but must resolve so the bundle builds |

### Adding new polyfills

When adding a new dependency, watch for runtime errors like `Property 'X' doesn't exist` or `TypeError: X is not a function` — these typically mean Hermes is missing an API. The fix is:

1. **Global API** (e.g., `structuredClone`, `Promise.withResolvers`): add to `polyfills/hermes.js`
2. **Node.js built-in module** (e.g., `crypto`, `os`): create a shim file in `polyfills/` and map it in `metro.config.js` under `extraNodeModules`
3. **Web API class** (e.g., `EventTarget`): add to `polyfills/event.js` or a new file, import from `index.js`

Always guard with `typeof` checks so the polyfill is skipped on platforms that have native support.

### libp2p/crypto Node → browser rewrite

`@libp2p/crypto` ships parallel `.browser.js` variants for the modules that use Node's `crypto` at key generation / signing time (`keys/ed25519`, `keys/secp256k1`, `keys/rsa`, `keys/ecdh`, `webcrypto/webcrypto`, `hmac`, `ciphers/aes-gcm`). The browser variants use `@noble/curves` + WebCrypto and work under Hermes; the Node variants call `crypto.generateKeyPairSync`, `createPrivateKey`, `sign`, `verify` — none of which our `polyfills/node-crypto.js` implements.

The package declares the mapping in its `browser` field, but with `unstable_enablePackageExports: true` (Expo SDK 52+ default, and @libp2p/crypto ships an `exports` map) Metro resolves via `exports` and the `browser` rewrite is not reliably applied. Without the rewrite, the first call to `generateKeyPair('Ed25519')` throws `undefined cannot be used as a constructor` (the Node variant's `crypto.generateKeyPairSync` is undefined in the shim).

`metro.config.js` reads the package's own `browser` map at config load time and applies it via `resolver.resolveRequest` — so any future upstream additions to that map are picked up automatically. The same pattern is mirrored in `sereus-health/apps/mobile/metro.config.js`.

### Built-in APIs (no polyfill needed)

These APIs are natively available in the target Hermes/Expo versions used by this app. Do not add polyfills for them — it wastes bundle size and can cause subtle conflicts.

| API | Available since | Notes |
|-----|----------------|-------|
| `TextEncoder` | Hermes (all versions used by Expo SDK 49+) | No polyfill needed; `fast-text-encoding` is unnecessary |
| `TextDecoder` | Expo SDK 52+ (UTF-8 only) | If you need non-UTF-8 encodings, use `text-encoding` package. **Bare RN** (non-Expo) Hermes through at least 0.85 does NOT ship `TextDecoder`; `polyfills/hermes.js` includes a UTF-8-only fallback (guarded by `typeof` so it's a no-op under Expo) |
| `BigInt` | Hermes since RN 0.70 | |
| `crypto.getRandomValues` | RN 0.76+ with New Architecture | `react-native-get-random-values` still recommended as safety net |

### Polyfill quality principles

- Prefer battle-tested npm packages over hand-rolled shims (e.g., `@ungap/structured-clone` over `JSON.parse(JSON.stringify(...))`)
- Prefer spec-compliant implementations — shortcuts like JSON round-trips silently drop data types
- Always guard with `typeof` checks so polyfills are skipped on platforms with native support
- Native modules (like `react-native-get-random-values`) require a dev client rebuild — document this when adding them

### Commonly needed beyond core

The polyfills above cover the libp2p/Optimystic/AI stack. Apps building additional features may need:

| API | Package | When needed |
|-----|---------|-------------|
| `URL` / `URLSearchParams` | `react-native-url-polyfill` | If using URL constructor in app code (Hermes has partial support) |

## Drone Configuration

The included `drone.cadre.yaml` is a minimal config for local development. Key settings:

```yaml
controlNetwork:
  partyId: "reference-chat-party"    # Must match the phone's Party ID
profile: storage                      # Always-on, persists strand data
network:
  listenAddrs:
    - "/ip4/0.0.0.0/tcp/4001"        # TCP (LAN peers)
    - "/ip4/0.0.0.0/tcp/4002/ws"     # WebSocket (required for RN)
  enableRelay: true                   # Circuit relay for NAT'd phones
```

See the [cadre-cli README](../cadre-cli/README.md) for production deployment options (systemd, Docker).

## Troubleshooting

**"Connecting..." never resolves** — Check that the bootstrap addr is correct, the drone is running, and the phone can reach the drone's IP on port 4002. On Android emulators, use your host machine's LAN IP.

**No messages appearing** — Ensure both nodes share the same Party ID. Check the Metro console for strand errors. Messages poll every 2 seconds, so there's a brief delay.

**Metro bundler errors** — Run `yarn install` from the monorepo root to ensure workspace symlinks are intact. The Metro config watches `sereus/`, `optimystic/`, and `quereus/` workspaces.

**"Property 'structuredClone' doesn't exist"** — Hermes doesn't ship `structuredClone`, which Optimystic uses for defensive deep cloning. The `polyfills/hermes.js` shim provides a spec-compliant polyfill via `@ungap/structured-clone` (handles Date, Map, Set, circular refs). If you see this error, make sure `index.js` imports `./polyfills/hermes` before any library code, then restart Metro with `--reset-cache`.

**"stabilize tick failed: TypeError: Cannot read properties of undefined (reading 'digest')"** — The `multiformats` package ships a browser variant of its SHA-2 hasher that calls `crypto.subtle.digest()`, which Hermes doesn't support. The `polyfills/hermes.js` shim provides a `crypto.subtle.digest` backed by `@noble/hashes`. If you see this error, restart Metro with `--reset-cache`.
