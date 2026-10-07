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

The phone's `CadreNodeConfig` is built by the kit (`@serfab/cadre-rn/phone-node` → `buildPhoneNodeConfig`); `src/cadre-phone.ts` adds the WebRTC transport, native Noise and the demo's unsigned-schema policy:

```typescript
network: {
  transports: [webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } })],
  listenAddrs: [],              // Cannot listen in RN
  relayAddrs: [...],            // Resolved by src/relay-config.ts; may be empty
  requireRelay: false,          // Must still start when the relay is down
  noiseCrypto: buildNoiseCrypto(mode), // Native Noise crypto; undefined in 'off' mode
  connectionGater: { denyDialMultiaddr: () => false },
}
```

`relayAddrs` and `requireRelay` are what make the phone dialable without making a relay a condition of starting — see "Reachability: configuring a relay" below.

`denyDialMultiaddr` is set because libp2p's `connection-gater` points its `react-native` package field at the browser build, which refuses to dial insecure `ws://` and private addresses — LAN and loopback. A node borrowed from a cadre-host on the same Wi-Fi is exactly that, in normal use rather than only in development, so the phone opts out of that default the same way the web reference app does. Only the dial is permitted: the connection is still Noise-encrypted, and membership is still gated by cadre-core's `denyDialPeer` plus its inbound and relay hooks. cadre-core threads this to strand nodes as well, which is wanted — they dial LAN addresses too.

**Native crypto for Noise.** Metro resolves `@chainsafe/libp2p-noise`'s browser build, so on its own every handshake and every encrypted frame runs pure-JS SHA-256, ChaCha20-Poly1305 and X25519 on Hermes (see the `WebAssembly` row under "The web APIs the phone's connectivity depends on"). SHA-256 over 512 bytes was measured at about 15 ms on a Galaxy S7, and at that cost the phone's event loop stays busy for long enough that libp2p's connection monitor drops connections (gotchoices/sereus#13). `cadre-phone.ts` therefore passes `buildNoiseCrypto(mode)` from `@serfab/cadre-rn/noise-crypto` as `CadreNodeConfig.network.noiseCrypto`, and cadre-core hands it to the control node and every strand node. The implementation is backed by `react-native-quick-crypto`; [the kit's README](../packages/cadre-rn/README.md) has the measurements and the native modules an app must list. Only local primitives change, not the wire protocol, so a phone with native crypto still talks to nodes without it.

| Mode | What runs natively | Settings label |
| --- | --- | --- |
| `symmetric` (default) | SHA-256 and ChaCha20-Poly1305, the costs paid on every frame. X25519 stays pure JavaScript | Native, symmetric only |
| `full` | Also X25519 key generation and Diffie-Hellman, the handshake's key agreement. It has had less device time than `symmetric` | Native, including key exchange |
| `off` | Nothing: `noiseCrypto` is `undefined`, which is stock libp2p-noise. Kept to reproduce the connection-monitor timeouts | Pure JavaScript |

Every mode but `off` starts from optimystic's `noisePureJsCrypto` and overrides only its own functions, so anything it does not replace keeps working. The mode is a start option (`PhoneNodeOptions.noiseCryptoMode`), read when the node is built, as `relayAddrs` is. Two places set it:

| source | how | when to use it |
| --- | --- | --- |
| `EXPO_PUBLIC_NOISE_CRYPTO` | build-time env var: `off`, `symmetric` or `full`, read by [`src/noise-crypto-config.ts`](../packages/reference-app-rn/src/noise-crypto-config.ts). Unset or blank means `symmetric`, the kit's `DEFAULT_NOISE_CRYPTO_MODE`. Any other value throws an error naming the three, because silently running a different mode would corrupt the measurement the switch exists for | a build that should start in another mode |
| Settings → **Connection encryption** | a three-way choice in the disconnected Node form, below **Relay**, prefilled from the mode the node last started with (see [Start options](#start-options-app-private-leveldb)), else from the env var. The choice is remembered: the next launch starts in the same mode | switching one device between modes |

Switching modes is Disconnect → choose → Connect, which builds a new node. The choice exists only in the disconnected form, so a strand founding or host-node request in flight never sees a rebuild. The connected Node card's **Encryption** row names the mode the running node was built with. `cadre-phone.ts` records it when it builds the node (cadre-core keeps only the implementation), so a device run can confirm what it measured. Adding the native modules needs a native rebuild (§ When Native Rebuild Is Needed). Whether each mode stops the connection-monitor drops on a real device has not been measured yet: blocked ticket `rn-native-noise-crypto-device-run`.

**The ping deadline is already widened, for every node.** While the phone runs pure-JS crypto (`off` mode, or any build before the native crypto above) its event loop can stay busy for longer than libp2p's 5 second liveness-ping deadline, and libp2p aborts a connection on the first missed ping. Each redial costs another handshake, which keeps the phone busy — measured on a Galaxy S7's crypto cost, a two-party bring-up never finished. cadre-core therefore defaults `network.connectionMonitor` to a 30 second deadline, pinged every 35 seconds, on every node it builds (`DEFAULT_CONNECTION_MONITOR`), not only under React Native: the peer at the other end of the connection runs the monitor too, and its abort closes the connection just as effectively. The gap between pings has to exceed the deadline, or libp2p starts a second ping over the same connection while the first is still waiting and drops the connection for that instead. This app sets nothing for it.

**The first-sync wait is widened for the same reason, also for every node.** A phone that has just redeemed an invitation holds none of the strand's data, so cadre-core withholds the strand database until that data arrives from another member and rejects `addStrand` with the retryable `StrandAwaitingFirstSyncError` if it has not arrived within `strandFirstSync.timeoutMs` (see [`strands.md` → Joining](strands.md#joining-no-writes-before-the-first-sync)). Through a relay on a slow link that first sync is not quick: on a measured path with a round trip of a couple of seconds it takes tens of seconds, not the second or two a direct connection takes, and a phone re-attaching after being away can take longer than a first join. cadre-core's default wait (`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, whose doc comment carries the number, the measurements and what the budget costs) is sized for that re-attach. This app sets nothing for it. The chat screens re-render on `strand:writable` ([`use-cadre.ts`](../packages/reference-app-rn/src/use-cadre.ts)), so a sync that lands after any budget still opens the screen — but [`joinClosedChatStrand`](../packages/reference-app-rn/src/chat-strand.ts) writes the joiner's app-level role right after `addStrand` resolves, so a join that times out has to be retried before that role exists.


**The per-peer read deadline is widened for every node too.** Before serving a read whose local copy may be stale, a node asks the other holders of that block which revision is newest, and believes an answer only if it arrives inside a per-peer deadline. Optimystic's own default for that is 1000 ms — a LAN budget, and shorter than one round trip between two phones that reach each other only through a relay, so every holder read as silent and the read was declined and retried. cadre therefore derives it from the declared link on both the control node and every strand node: two link round trips, **7000 ms** at the default declaration (`COHORT_READ_DEADLINE_MS` in [`cluster-size.ts`](../packages/quereus-plugin-sereus/src/cluster-size.ts), whose doc comment carries the derivation, the measurement history and what the wider budget costs). This app sets nothing for it; `network.linkRoundTripMs` moves it with every other link budget if a deployment's link is slower, and `network.cohortQueryTimeoutMs` overrides it on both networks at once.

### Reachability: configuring a relay

A React Native app cannot open a listener, so on its own the phone node has **no multiaddr at all**. That is fine for almost everything the app does — founding and reading strands, dialling out to a drone or to a node borrowed from a cadre-host, joining somebody else's invitation — because in all of those the phone is the side that dials. It is not fine for **inviting**: the phone runs the strand it invites to, so the joiner must be able to reach the phone itself, and the app refuses to mint an invitation while the phone has no address (`use-cadre.ts`). `CadreNode.createOpenInvitation` alone would still mint one that names only the party's other machines, which may not run a strand the phone has just founded yet.

The one address a phone can have is a `/p2p-circuit` address earned by holding a **reservation** on a circuit relay — a public libp2p node that forwards traffic on its behalf. Point the app at one and it becomes invitable. Which other kinds of node can hold a reservation today is in [architecture.md → Which nodes can be reached through a relay](architecture.md#which-nodes-can-be-reached-through-a-relay).

Two ways to supply it, both resolved by [`src/relay-config.ts`](../packages/reference-app-rn/src/relay-config.ts):

| source | how | when to use it |
| --- | --- | --- |
| `EXPO_PUBLIC_RELAY_ADDR` | build-time env var, comma-separated; Expo inlines `EXPO_PUBLIC_`-prefixed vars into the bundle | a build that should work with no typing |
| Settings → **Relay** | typed per device, comma-separated | pointing one device elsewhere; overrides the env var |

The field is prefilled with the relays the node last started with (see [Start options](#start-options-app-private-leveldb)), else from the env var, so a build that ships one needs no typing. A value typed into it wins; clearing it falls back to the env var, and with neither the phone runs with no relay. A remembered list also wins over a later build's env var until the field is cleared.

The address is a full relay dial addr ending in the relay's peer id, e.g. `/ip4/203.0.113.7/tcp/4002/ws/p2p/12D3KooW…`. `ops/` has the relay container this repo ships.

Each relay is also the phone's **STUN** server, for upgrading a relayed connection to a direct WebRTC one: cadre-core's [`resolveStunServers`](../packages/cadre-core/src/relay-stun.ts) turns each relay address into `stun:<relay host>:3478`. `EXPO_PUBLIC_STUN_URLS` (comma-separated `stun:` URLs) replaces that, for a relay whose STUN is published elsewhere. With no relay the phone has no STUN server and WebRTC upgrades use LAN candidates only — see `ops/docs/ice-servers.md`.

**What the phone can and cannot do without one**

| | with a relay reserved | without |
| --- | --- | --- |
| Start, found strands, read and write them locally | yes | yes |
| Dial a drone / a borrowed cadre-host node, sync, chat | yes | yes |
| Join a closed strand from someone else's invitation | yes | yes |
| **Create a closed strand + invite** | yes | **no** — refused before anything is founded, with a message naming this field |

**It never blocks startup.** The config sets `requireRelay: false`, so a relay that is unreachable at launch is logged and retried in the background instead of failing `start()` — a phone has to work on a dead network. The posture is visible as **Reachable** on the Settings Node card and in the chat screen's connection banner, and it is read live at the moment Invite is tapped, so a relay that comes back mid-session starts working with no restart.

**Two costs worth knowing.** A configured-but-unreachable relay adds about ten seconds to `start()` and about ten more to **every** strand launch: cadre-core waits out each reservation supervisor's first attempt (`DEFAULT_RELAY_RESERVE_TIMEOUT_MS`, 10 s), and a refused dial spends that whole budget polling in case libp2p's own discovery lands a reservation anyway. Nothing fails — founding is just slower while the relay is down, which the Settings screen's slow-founding hint will surface.

**One relay per phone, and the two ends need not share it.** Two people who each configured their own relay form strands and replicate through their two relays — each phone dials the other through the other's relay, without reserving there (`blind-relay-phone-to-phone-e2e.integration.ts`, per-party arm). Relaying through the phone's own always-on cadre node instead of third-party infrastructure is the intended end state but is blocked on two cadre-core defects — see backlog `feat-phone-relays-through-its-own-always-on-node`.

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

`schemas/chat-simple.qsql` is the source of record for the above, and a test fails when the block
stops matching it (see [testing.md](testing.md) → "Lint coverage"); `composeStrand` supplies the
`declare schema App { ... }` wrapper, so the file itself is a bare table list.

No signature verification, no invite flow, no authorization constraints. This keeps the reference app focused on the P2P plumbing rather than application-level crypto.

## Node-Local Persistence

What the phone node keeps *locally* — never replicated, never derivable from the network — and where each lives.

### Peer identity (secure enclave)

The phone node maintains a stable PeerId across app restarts:

1. **First launch** — cadre-core generates an Ed25519 keypair and stores it through `SecureStoreKeyStore` (`@serfab/cadre-rn/key-store`), a `KeyStore` over `expo-secure-store`: iOS Keychain / Android Keystore-encrypted preferences, under the reserved `sereus.ks.` key prefix plus a `__index` entry listing the keyIds it holds.
2. **Subsequent launches** — the key is loaded from the enclave, producing the same PeerId every time.
3. **Single identity** — the same key is used for both the control network and all strand networks, matching the one-key-per-device architecture.

`CadreNode` resolves the key from that store when it starts. A locked/refused enclave read propagates and **fails the start** rather than booting on a replacement key.

Gating: the store is opened **ungated** (no `requireAuthentication`) with `keychainAccessible: AFTER_FIRST_UNLOCK`, because the node must come up headless on a push wake while the device is locked, and because a biometric-set change would invalidate the entry. Earlier development builds kept the key in plaintext MMKV, then plaintext LevelDB; there is no upgrade path from either, and none was ever needed. The app reads its identity only from the enclave and generates one there on first run.

### Trusted-owner anchor (secure enclave)

The set of owner public keys this device believes speak for its party — what seed acceptance, wake authorization, and vouching all check against. Persisted by cadre-core's `PersistentTrustedOwnerStore` over a `DurableSlot` the app supplies: one `expo-secure-store` entry under its own `sereus.anchor.<base64url partyId>` key (`@serfab/cadre-rn/node-local`). Deliberately *not* under the key store's `sereus.ks.` prefix, whose `__index` must never see a foreign entry.

The anchor is not secret but it **is** trust-bearing — anything that can silently edit it can make this device trust a stranger — so it gets the most tamper-resistant store the app has, and shares the identity key's fate (including surviving an iOS reinstall, which is the desirable direction: same peer id, same trusted owners). The slot is ungated for the same headless reason as above, and `secureStoreSlot` **refuses** a gated slot outright: its "a `null` read means absent" mapping would misreport a biometric-invalidated anchor as empty, and the next snapshot write would make that permanent.

### Bootstrap dial targets (app-private LevelDB)

The dial targets the node learned out of band: the owner peers of every seed it has applied, and every node it added (a lent cadre-host node, a provider drone). They are the only addresses a stranded node has to re-dial its way back into the party, and the only ones the phone has for a node it added until that node publishes a signed address record. Persisted by cadre-core's `PersistentBootstrapPeerStore` over a `kvStoreSlot`: one key of a `LevelDBKVStore` in the app-private `sereus-node-local` database, separate from any strand's database so clearing it cannot disturb replicated data.

Not the enclave, for two reasons: dialing grants no authority (`CadreNode` re-binds every retained address to the peer id it was recorded under before dialing), and multiaddrs run 80–120 characters each with several per peer and the snapshot growing for the node's whole lifetime — it would cross SecureStore's ~2048-byte value limit and simply fail the write.

Both records are party-scoped, as are the enrolled-machine count and the strand network state beside them in the same database. They are read back on a relaunch because the party id itself is remembered, below.

### Start options (app-private LevelDB)

What the node last started with — party id, bootstrap addresses, relay addresses and Noise crypto mode — plus `autoStart`, whether to start again unattended. One record under the key `start-options` in the same `sereus-node-local` database, deliberately **not** party-scoped: it is what selects the party every record above is filed under. The kit's `parseSavedStart` (`@serfab/cadre-rn/phone-node`) parses it: unparseable JSON, an unknown version or a missing party id counts as no record (logged), while a malformed address list or Noise mode falls back to its default rather than costing the phone its party id. Not the enclave: nothing in it is secret or trust-bearing, and a relay list can outgrow SecureStore's value limit.

- **Written** only by the kit's `PhoneNode` (`cadre-phone.ts` is this app's): after every successful start (`autoStart: true`, with the options exactly as the node ran with them), and on Settings → **Disconnect** (`autoStart: false`, same options — Disconnect is logging out, which also clears the push-wake device token). A failed start writes nothing, so a typo in Settings cannot replace the last configuration that came up. An OS kill runs no code, so `autoStart` stays true across one. Both writes are best-effort: a failure is logged and the node carries on.
- **Read** once at app launch (`use-cadre.ts`). With `autoStart` true the app connects by itself with those options, exactly as a Connect tap would — this is what keeps a solo phone in the same party across relaunches instead of founding a new one. Either way the Settings form prefills from them. The same options are what the background runner's cold start uses after the OS kills the node, and what a push wake into a killed process starts from (`push-wake-native.ts`), again only while `autoStart` is true. A read fault shows "Could not read the saved connection settings" under the Node card and starts nothing.
- **Stored values win over build defaults.** Relays and Noise mode are saved as resolved, not as "use the build default", so a later build with a different `EXPO_PUBLIC_RELAY_ADDR` or `EXPO_PUBLIC_NOISE_CRYPTO` does not change a device that has already connected. To pick up a new default: Disconnect, clear the Relay field (empty means the build default) or choose the mode, and Connect.
- **Switching party** is Disconnect, edit Party ID, Connect. The old party's records stay on disk and are read again if the phone switches back.
- **Overlapping starts** — a launch auto-start, a push-wake cold start, the runner's resume and a Connect tap — share one start in flight, so they never build two nodes; the first caller's options win. Disconnect during a start waits for it, then stops the node it produced; a start during a Disconnect runs after it, and a cold start reading the record mid-Disconnect reads `autoStart: false`.
- **Reinstall.** On iOS the trusted-owner anchor lives in the Keychain, which survives an uninstall; this record does not. A reinstalled phone picks a new party id and the surviving anchor, filed under the old one, is never read again — the same outcome as before start options were saved.

The Maestro flows launch with `clearState: true`, so they always see a fresh, idle app.

## cadre-core React Native Compatibility

### Validated (2026-02-23)

`cadre-core` imports `createLibp2pNode` from `@optimystic/db-p2p`. That package's `exports` field includes a `react-native` condition pointing to `rn.js`, so Metro automatically selects the RN-safe entrypoint (no TCP import). Transport injection in `createControlNode()` and `StrandInstanceManager` already works.

**cadre-core** now declares a `react-native` export condition in its `package.json`. Source audit confirmed two Node-only dynamic imports — `require('path')` in `getStrandStoragePath` and `require('fs/promises')` in `ControlDatabase.loadSchema` — both runtime-guarded behind `process.versions?.node` checks and restricted to Node-only code paths.

**Quereus** has no Node-only imports. BigInt is supported in Hermes since RN 0.70. Only `TextEncoder` is used (built-in to Hermes); `TextDecoder` is not required by Quereus. However, `@optimystic/db-p2p` (and `uint8arrays`, which it pulls in transitively via libp2p/yamux/multiformats) uses `TextDecoder` at module scope — this is covered by Expo SDK 52+'s built-in `TextDecoder` global (UTF-8 only). On **bare RN** Hermes (non-Expo) `TextDecoder` is NOT present as of RN 0.85, so `@serfab/cadre-rn`'s `polyfills/hermes.js` ships a UTF-8-only fallback that becomes a no-op once the runtime provides it.

**Metro bundle** succeeds with 2790 modules (cadre-core, Quereus, db-p2p, libp2p, and all transitive deps). The only warnings are cosmetic: `multiformats` subpath export fallbacks that resolve correctly via file-based resolution.

### Polyfills

The global polyfills live in the React Native kit, [`@serfab/cadre-rn`](../packages/cadre-rn/README.md), under `packages/cadre-rn/polyfills/`. A Sereus React Native app depends on the kit rather than copying the files. In this section, `polyfills/<file>.js` means the kit's file. The Node built-in shims Metro maps (`node-os.js`, `node-crypto.js`, `empty.js`, below) are in the kit's `shims/` directory, wired in by `@serfab/cadre-rn/metro` (§ Metro Configuration).

The app's job is three imports at the top of its entry file (`index.js`), before `expo-router/entry` loads any library code. This is critical because libp2p and its dependencies reference Web APIs at import time, so `@serfab/cadre-rn/polyfills` must come first:

```js
import '@serfab/cadre-rn/polyfills';          // hermes.js, intl-pluralrules.js, event.js, in that order
import '@serfab/cadre-rn/polyfills/webrtc';   // react-native-webrtc registerGlobals(), for @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';         // audit.js and reload-reason.js, under __DEV__ only (below)
import 'expo-router/entry';                   // App code starts here
```

The boot check is imported rather than called, and its position is the point: every statement in `index.js`'s own body runs only after all of its imports have evaluated, which includes `expo-router/entry` and the app tree behind it. A global that is missing would crash at that import and the table would never print. Imported here, it prints first.

The WebRTC globals load after `Intl.PluralRules` and EventTarget. They need only `crypto.getRandomValues` from `hermes.js`. One side effect of the order: `react-native-webrtc`'s own copy of `event-target-shim` checks for a global `Event` and `EventTarget` when it loads and, if they exist, chains its classes onto them. Neither React Native 0.79 nor Expo 53 installs those globals, so before the kit it found none; now it finds `event-target-polyfill`'s.

#### Required polyfill dependencies

The pure-JavaScript libraries the polyfills use (`@ungap/structured-clone`, `web-streams-polyfill`, `event-target-polyfill`, `@noble/hashes`) are dependencies of `@serfab/cadre-rn`, so the app does not list them. The app **must** list the native modules as its own direct dependencies, because React Native autolinks only those, even though only the kit imports them:

```json
{
  "@serfab/cadre-rn": "workspace:^",
  "react-native-get-random-values": "^1.11.0",
  "react-native-webrtc": "^124.0.6"
}
```

The packages the Metro aliases point at (`buffer`, `readable-stream`, and `@noble/hashes` for `shims/node-crypto.js`; see § Metro module aliases) are kit dependencies too, so the app lists none of them. Keep this block in sync with [`packages/reference-app-rn/package.json`](../packages/reference-app-rn/package.json).

`@noble/hashes` deserves special attention: it provides the SHA-256/SHA-512 implementation used by both of the kit's `polyfills/hermes.js` (lazy `require('@noble/hashes/sha2.js')` inside `crypto.subtle.digest`, the fallback until `/native-digest` installs the native hash) and `shims/node-crypto.js` (`import { sha256 } from '@noble/hashes/sha2.js'`). The `.js` suffix matters: version 2.x lists only `./sha2.js` in its package.json `exports`. Metro still resolves a bare `@noble/hashes/sha2`, but only by falling back to file-based resolution and logging a warning on every bundle. It also resolves transitively via libp2p, but the lockfile can carry multiple major versions simultaneously. The kit uses the v2 import path and declares it `^2.0.0`.

**One copy of each native module.** The kit's files sit at `packages/cadre-rn/polyfills/`, outside the app, and Metro looks in the `node_modules` directories above the importing file before its `nodeModulesPaths`. The repo root holds a second `react-native-webrtc` (hoisted there for `@libp2p/webrtc`), so without help the kit's `webrtc.js` would bundle that copy beside the app's. `@serfab/cadre-rn/metro` therefore resolves the kit's peer dependencies as if the app imported them (§ Metro Configuration).

#### Global polyfills (`polyfills/hermes.js`)

These patch `globalThis` to provide APIs that Hermes does not yet support:

| API | Required by | Notes |
|-----|-------------|-------|
| `process.env.DEBUG` (development builds only) | `debug`, for cadre-core's `sereus:cadre:timing` bring-up and founding timings | Set to `sereus:cadre:timing` as the file's first statement. Each bundled copy of `debug` reads the variable once when it loads, so it must be set before any library module loads. A value that is already set is left alone. See "Tracing a strand founding" |
| `crypto.getRandomValues()` | @noble/hashes, @libp2p/crypto, @noble/curves | via `react-native-get-random-values` (native CSPRNG). No Math.random fallback — without the native module any libp2p key generation is unsafe, so we want loud breakage rather than silent insecurity |
| `crypto.subtle.digest()` | multiformats/hashes/sha2-browser | Async SHA-256/SHA-512 via @noble/hashes at boot; replaced with react-native-quick-crypto's native hash when `@serfab/cadre-rn/noise-crypto` loads (`/native-digest`) |
| `structuredClone()` | @optimystic/db-core (transform tracker, cache-source, coordinator) | via `@ungap/structured-clone` (spec-compliant); handles Date, Map, Set, circular refs |
| `Symbol.asyncIterator` | `for await...of` on custom iterables | Some Hermes versions omit this. Guarded definition uses `Symbol.for('Symbol.asyncIterator')` (registry) so independent polyfills converge on the same symbol |
| `ReadableStream`, `WritableStream`, `TransformStream` | Vercel AI SDK, streaming libraries | via `web-streams-polyfill`. No-op under Expo SDK 53: Expo's Metro config adds `expo/virtual/streams.js` as a bundle polyfill, which runs before the entry module, and the 2026-09-16 device audit reported all three `native` |
| `Promise.withResolvers()` | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue, mortice, abort-error | ES2024 API |
| `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/utils, @libp2p/circuit-relay-v2, it-pushable, p-retry | DOM spec addition |
| Timer `.ref()` / `.unref()` | @optimystic/db-p2p, undici, libp2p internals | Wraps Hermes numeric timer IDs in objects; also patches `clearTimeout`/`clearInterval` to unwrap (see `hermes.js` `// ── Timer .ref() / .unref() ──` section) |
| `TextDecoder` | `uint8arrays` (via libp2p / multiformats / yamux) | UTF-8 only; throws `RangeError` for any other encoding. No-op on Expo SDK 52+, which installs one in `expo/src/winter/runtime.native.ts`; the 2026-09-16 device audit under SDK 53 reported it `native` |
| `DOMException` | `p-timeout` (via `p-queue` / `p-event`); the abort reasons below; `react-native-webrtc`'s `event-target-shim` when present | A named `Error` subclass: `name`, `message`, the legacy numeric `code`, `instanceof Error`. No static code constants, and `structuredClone` copies it as a plain `Error` (below) |
| `AbortSignal.timeout()` | libp2p's dial queue, connection pruner and registrar; @libp2p/circuit-relay-v2 reservations; @libp2p/websockets; @libp2p/identify | Without it every dial that carries no signal of its own throws `TypeError: AbortSignal.timeout is not a function` |
| `AbortSignal.any()` | `p-wait-for` — reached by shipped code only through @libp2p/webrtc's `private-to-public` listener; libp2p, @libp2p/websockets, @libp2p/circuit-relay-v2 and @libp2p/tcp list it as a devDependency, so it is absent from their `dist` | Detaches its listeners from every input once the combined signal aborts. A combination none of whose inputs ever aborts keeps its listeners on those inputs, because the DOM holds combined signals weakly and Hermes offers no equivalent. No caller does that today: `p-wait-for` always pairs the caller's signal with an `AbortSignal.timeout`, which always fires. If one ever does, the fix belongs at that call site (an explicit combination it can release), not in the polyfill. `yarn lint` keeps first-party source off `AbortSignal.any`, `AbortSignal.timeout`, `Promise.withResolvers` and `new DOMException` (`PHONE_RUNTIME_GUARD` in `eslint.config.mjs`) |
| `AbortSignal` abort reasons | everything that calls `controller.abort(err)` | React Native installs `abort-controller` 3.0.0, whose `abort()` takes no argument (below) |
| `WebSocket.prototype.bufferedAmount` | @libp2p/websockets | Reports `0`. React Native hands each frame straight to the native socket and keeps no JS-side queue, so nothing is ever pending from the caller's point of view (below) |

#### Other global polyfills

| File | Target | Required by | Notes |
|------|--------|-------------|-------|
| `packages/cadre-rn/polyfills/intl-pluralrules.js` | `Intl.PluralRules` | moat-maker (error messages) | English-only ordinal/cardinal shim |
| `packages/cadre-rn/polyfills/event.js` | `EventTarget`, `Event`, `CustomEvent` | libp2p, @libp2p/interface | Imports the [`event-target-polyfill`](https://www.npmjs.com/package/event-target-polyfill) npm package (spec-complete: handles `capture`, `once`, and `signal` options on `addEventListener`), then adds a minimal `CustomEvent` shim on top — `event-target-polyfill` does not include `CustomEvent`, which libp2p's `safeDispatchEvent` uses internally |
| `packages/cadre-rn/polyfills/webrtc.js` | `RTCPeerConnection`, `RTCSessionDescription`, `RTCIceCandidate`, … | @libp2p/webrtc's private-to-public `browser` variants, which read the engine off the globals | `react-native-webrtc`'s `registerGlobals()`. Exported separately as `@serfab/cadre-rn/polyfills/webrtc`, so an app without WebRTC need not install the native module |

> A hand-rolled inline `EventTarget` class is technically sufficient for libp2p's current usage but quietly drops `once`, `signal`, and capture semantics. We prefer the npm package so future libp2p versions (or other consumers) that rely on those options keep working without surprises. It is a dependency of `@serfab/cadre-rn`; dropping it there produces `Unable to resolve module event-target-polyfill` Metro failures.

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
- Native modules (like `react-native-get-random-values`) require a dev client rebuild, and every app must list them itself for autolinking — document both when adding them
- A new global polyfill goes in `@serfab/cadre-rn`, not in an app, so every Sereus app gets it; add its probe to the kit's `polyfills/audit.js` and its name to the app's drift guard (§ Guards)

#### Metro module aliases (Node.js built-in shims)

`withCadreMetro` (§ Metro Configuration) sets these as `extraNodeModules`, under both the `node:X` and the bare `X` name. Metro consults them only after every `node_modules` lookup fails. An alias the app's config already has wins over the kit's.

| Module | Target | Source | Required by |
|--------|--------|--------|-------------|
| `os` / `node:os` | `packages/cadre-rn/shims/node-os.js` | Custom shim (networkInterfaces, platform, type, hostname) | @libp2p/utils |
| `crypto` / `node:crypto` | `packages/cadre-rn/shims/node-crypto.js` | Custom shim — `createHash()` for SHA-256/SHA-512 via @noble/hashes | The Node variants of multiformats/hashes/sha2, @chainsafe/libp2p-noise crypto/index and @libp2p/crypto's key modules. *Not* cadre-core push — the FCM/APNs notifiers moved behind the Node-only `@serfab/cadre-core/push-node` subpath. |
| `stream` / `node:stream` | `readable-stream` (npm, a kit dependency) | Metro `extraNodeModules` | libp2p stream handling |
| `buffer` / `node:buffer` | `buffer` (npm, a kit dependency) | Metro `extraNodeModules` | libp2p, multiformats |
| `net` / `node:net` | `packages/cadre-rn/shims/empty.js` | Empty stub | The Node variant of @libp2p/websockets' listener — never reached at RN runtime, but needs to resolve so the bundle builds |
| `tls` / `node:tls` | `packages/cadre-rn/shims/empty.js` | Empty stub | As `net` |

In the reference app's Android export (2026-09-26) only `node-os.js` is bundled: Metro picks the `browser` variants of the modules listed for `crypto`, `net` and `tls`, and nothing bundled imports `stream` or `buffer` by those names. The other entries are there for an app whose resolver settings land on a Node variant, where an unmapped built-in fails the whole bundle with an error naming the importer rather than the cause.

sereus-chat's config also carries a `sign()` stub on the crypto shim and `http2`, `path` and `fs` stubs. The kit does not: they served cadre-core's push notifiers and file-based helpers, which now sit behind Node-only subpaths (`@serfab/cadre-core/push-node`, `/key-store-file`, …) that a React Native app never imports, and stubbing `path` or `fs` to `{}` would break any dependency that really uses them.

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
  index.js                    # Custom entry: @serfab/cadre-rn polyfills + boot check, then expo-router/entry
  app.json                    # Expo config (SDK 53, custom dev client)
  package.json                # workspace:^ deps on cadre-core, db-p2p, etc.
  tsconfig.json
  metro.config.js             # withCadreMetro(...) with this repo's linked roots
  eas.json                    # EAS Build profiles (development, preview)
  app/
    _layout.tsx               # Expo Router root layout
    index.tsx                 # Chat screen (message list + input)
    settings.tsx              # Bootstrap config (drone address, cadre invitation, seed paste)
  src/
    cadre-phone.ts            # This app's phone node (kit's createPhoneNode): WebRTC, Noise, storage names, seed apply
    node-local-names.ts       # The storage names installed phones' records are filed under, pinned by a Node test
    chat-strand.ts            # Strand lifecycle: create/join strand, load chat schema
    chat-operations.ts        # Quereus operations: insert message, query messages
    chat-send.ts              # Composer send rule: one message id per draft, held across retries
    strand-selection.ts       # Which strand the chat screen is showing
    app-state.ts              # The AppState passed to the kit's lifecycle runner; use-cadre's spec fakes it
    push-wake.ts              # Platform-agnostic push-wake decision logic
    push-wake-native.ts       # Expo notifications wiring for push-wake
    connection-status.ts      # Derives UI connection state from node events
    relay-config.ts           # Relay multiaddr(s): Settings field, else EXPO_PUBLIC_RELAY_ADDR
    noise-crypto-config.ts    # Default Noise crypto mode: EXPO_PUBLIC_NOISE_CRYPTO, else symmetric
    cadre-context.tsx         # React context provider for the node
    use-chat.ts               # React hook: message list, send, connection status
    use-cadre.ts              # React hook: cadre lifecycle, joining a cadre, seed application
    join-failure.ts           # Plain words for each way a join can fail (NS carries a copy)
  schemas/
    chat-simple.qsql          # Simplified chat schema (or inline string)
```

The global polyfills, the Node built-in shims and the Metro helper are in the kit:

```
packages/cadre-rn/polyfills/
  index.js                    # @serfab/cadre-rn/polyfills: hermes, intl-pluralrules, event, in that order
  hermes.js                   # Runtime globals: crypto, AbortSignal, WebSocket, structuredClone, etc.
  intl-pluralrules.js         # Intl.PluralRules for moat-maker
  event.js                    # Event, CustomEvent, EventTarget globals for Hermes
  webrtc.js                   # @serfab/cadre-rn/polyfills/webrtc: registerGlobals() for @libp2p/webrtc
  boot-check.js               # @serfab/cadre-rn/boot-check: audit, then reload-reason
  registry.js                 # Records which globals each polyfill actually patched
  audit.js                    # Boot-time native/polyfilled/gap/MISSING table (__DEV__ only)
  reload-reason.js            # Logs [reload] <reason> before a JS-initiated reload (__DEV__ only)
packages/cadre-rn/shims/        # Node built-in shims, reached through @serfab/cadre-rn/metro
  node-os.js                  # Minimal os module shim for libp2p
  node-crypto.js              # createHash() shim via @noble/hashes
  empty.js                    # net / tls stubs
packages/cadre-rn/metro/
  index.cjs                   # @serfab/cadre-rn/metro: withCadreMetro(config, options)
```

### Key Dependencies

| Package | Source | Purpose |
|---------|--------|---------|
| `@serfab/cadre-core` | `workspace:^` | CadreNode, seed bootstrap, strand management |
| `@serfab/cadre-rn` | `workspace:^` | Hermes polyfills and the development-build boot check (§ Polyfills); Metro configuration (§ Metro Configuration); native Noise crypto (§ Phone (RN app) Configuration) |
| `@optimystic/db-p2p` | npm | libp2p node creation (Metro resolves RN entrypoint) |
| `@optimystic/db-p2p-storage-rn` | npm | LevelDB-backed `IRawStorage` |
| `@quereus/quereus` | npm | SQL engine for sApp schema |
| `@libp2p/websockets` | npm | WebSocket transport |
| `@libp2p/circuit-relay-v2` | npm | Circuit relay transport |
| `rn-leveldb` | npm | Native KV store (requires native compilation) |
| `react-native-quick-crypto` | npm | Native SHA-256, ChaCha20-Poly1305 and X25519 behind `@serfab/cadre-rn/noise-crypto`. 1.x needs the new architecture (`newArchEnabled` in `app.json`) and React Native 0.75 or newer; listed under `app.json` `plugins` as its Expo instructions produce (the plugin raises the iOS deployment target) |
| `react-native-nitro-modules` | npm | quick-crypto's native bridge; must be a direct dependency for autolinking. Its podspec and C++ carry explicit branches for React Native below 0.80, so 0.79 is handled |
| `react-native-quick-base64` | npm | quick-crypto peer; 3.x is a new-architecture TurboModule, supported on Expo 53 with the new architecture enabled |
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

Those last three all depend on Metro applying a package's `browser`/`react-native` subpath map to that package's own internal relative imports. `@serfab/cadre-rn/metro` hand-rewrites that map for `@libp2p/crypto` and `@libp2p/webrtc` because package `exports` resolution made it unreliable for them — so if a future bundle ever fails to resolve `@chainsafe/as-*`, or announces `browser/undefined` in identify, this is the mechanism that slipped.

**`AggregateError` is native.** `libp2p/dist/src/connection-manager/dial-queue.js` throws `new AggregateError(errors, 'All multiaddr dials failed')` when every address for a peer fails. The repo holds the `hermesc` compiler but no Hermes VM, so only a device could say whether Hermes (`hermes-2025-06-04-RNv0.79.3`) provides it. The boot audit on 2026-09-16 (Galaxy Note 9, Android 10, Expo SDK 53 dev client) found it native, with `errors` and `message` intact and `instanceof Error` true, so a fully failed dial carries its per-address causes.

**`DOMException` is absent, and `polyfills/hermes.js` supplies a stand-in.** The same boot audit found `typeof DOMException === 'undefined'`. `p-timeout` 7 constructs one without checking — `signal.reason ?? new DOMException('This operation was aborted.', 'AbortError')` — and it is pulled in by `p-queue` and `p-event`, with copies at the repo root and under `../optimystic` and `../Fret`. Without a global it throws `ReferenceError: DOMException is not defined` instead of the `AbortError` it meant. That path needs a signal aborted with no reason, which the abort-reason patch above should prevent for every `AbortController.abort()`; it has not been exercised on a device, and a signal aborted any other way would still reach it, so the stand-in makes it correct regardless. (`@expo/metro-runtime`'s `Location.native.ts` also contains `new DOMException(…)`, which is why a search of the dev bundle turns it up, but it declares its own module-local class and never reads the global.)

Three more modules check for a global `DOMException` and build their own class when there is none, so the stand-in only changes which class they use. `react-native-webrtc`'s copy of `event-target-shim` checks each time it raises an `InvalidStateError`, so it uses the stand-in. `whatwg-fetch` (React Native's `fetch`) checks once, when React Native first loads `fetch`; it uses the stand-in if that happens after `polyfills/hermes.js` runs. The streams polyfill Expo's Metro config injects (`expo/virtual/streams.js`) runs before `index.js`, so it always builds its own. The abort reasons the polyfill creates are also `DOMException`s now, as libp2p sees in browsers and Node. The stand-in is a named `Error` subclass with `name`, `message`, the DOM's legacy numeric `code` table and `instanceof Error`. It has no static code constants (`DOMException.ABORT_ERR`), and `@ungap/structured-clone` copies it as a plain `Error` with only the message. It is not the `domexception` npm package, which is a full WebIDL implementation built on `webidl-conversions` and much larger than the need.

#### Guards

| What | Where | What it catches |
|------|-------|-----------------|
| Behaviour of `polyfills/hermes.js` | `packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts` (the kit's Vitest project `polyfills`) | Evaluates the polyfill against a fake Hermes + React Native surface, then drives `@libp2p/websockets`' own `webSocketToMaConn` over a socket with no `bufferedAmount`. Deleting any arm fails a test rather than a phone |
| The next missing global | `packages/reference-app-rn/test/polyfills/dependency-globals.spec.ts` (the app's Vitest project `polyfills`) | Reads a listed set of this app's installed dependency `dist` trees and fails when a global that nothing provides starts appearing; checks the kit's polyfill files for the registry keys it relies on. It stays in the app because the dependency graph is per app. A substring search over a hand-listed set of packages — it narrows the window, it does not close it; see the spec's header for what it cannot see |
| The real runtime | `polyfills/audit.js`, loaded through `@serfab/cadre-rn/boot-check` under `__DEV__` | Prints a `native` / `polyfilled` / `gap` / `MISSING` table at boot, under `[cadre-rn] polyfill audit`, and warns loudly on anything MISSING. The only thing that notices when a React Native upgrade starts — or stops — providing one of these natively |

The audit tells `native` from `polyfilled` through `polyfills/registry.js`: each polyfill calls `markPolyfilled(key)` when its guard actually fires, so a `typeof` check at boot is not left guessing which of the two it is looking at. `EventTarget` comes from the `event-target-polyfill` package, which marks nothing itself, so `event.js` checks for it before loading the package and marks it. One limit: a row the audit cannot read (a native getter that throws when read off a prototype) counts as present rather than crashing boot.

### Metro Configuration

The app's `metro.config.js` is one call to the kit's `withCadreMetro` (`@serfab/cadre-rn/metro`), which adds what a Sereus React Native app needs to the config the app's own toolchain produced:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withCadreMetro } = require('@serfab/cadre-rn/metro');
const path = require('path');

module.exports = withCadreMetro(getDefaultConfig(__dirname), {
  projectRoot: __dirname,
  linkedRoots: [
    path.resolve(__dirname, '../..'),               // this monorepo
    path.resolve(__dirname, '../../../optimystic'), // portaled sibling checkouts
    path.resolve(__dirname, '../../../quereus'),
    path.resolve(__dirname, '../../../Fret'),
  ],
});
```

| Option | Meaning |
|--------|---------|
| `projectRoot` | The app's directory (`__dirname`). The kit's peers and `@babel/runtime` resolve from here. |
| `linkedRoots` | Local checkouts whose packages are linked into the app. Each is added to `watchFolders`, and its `node_modules` to `resolver.nodeModulesPaths`. Omit it when every package comes from npm. |

`Fret` is a linked root because `@optimystic/db-p2p` portals `p2p-fret` from the sibling `../Fret` monorepo: Metro must be allowed to follow that symlink or a local release bundle fails with "Unable to resolve module p2p-fret". On EAS the portal resolutions are stripped and `p2p-fret` comes from npm, so, like the optimystic and quereus roots, it only matters for local bundling. The app's `metro.config.js` keeps two notes beside `linkedRoots`: what happens when a fourth portaled sibling appears, and the accepted tradeoff of watching whole repository roots.

`withCadreMetro` mutates and returns the config, keeping what it already had: lists are appended to, an alias the app already set wins over the kit's, and an existing `resolveRequest` is called by the new one. It sets:

- `resolver.unstable_enableSymlinks = true`.
- `watchFolders`: the existing ones, then `linkedRoots`.
- `resolver.nodeModulesPaths`: the existing ones, then `<projectRoot>/node_modules`, then each linked root's `node_modules`, in that order. The app's `test/polyfills/metro-resolution.ts` reads this list to find installed packages the way Metro does.
- `resolver.extraNodeModules`: the Node built-in aliases (§ Metro module aliases).
- `resolver.resolveRequest`: a wrapper that applies three rules, in this order.
  1. **The kit's peers resolve from the app.** An import of a name in the kit's `peerDependencies` (`react-native`, `react-native-webrtc`, `react-native-get-random-values`, `react-native-quick-crypto`, `@craftzdog/react-native-buffer`, and quick-crypto's own native dependencies `react-native-nitro-modules` and `react-native-quick-base64`), or of a subpath of one, resolves as if a file in `projectRoot` imported it, whoever the importer is. Metro looks in the `node_modules` directories above the importing file first; in this repo the kit lives outside the app, and the repo root holds its own `react-native-webrtc` and the kit's types-only dev copy of `react-native-quick-crypto`, either of which would otherwise be bundled beside the app's. Native code is linked only for the app's own dependencies, so any second copy is JavaScript that does not match the native side. A peer the app has not installed fails with Metro's usual "unable to resolve", and only if something imports it.
  2. **`@babel/runtime/*` resolves to the CommonJS helper in the app's copy**, through Node's `require.resolve` from `projectRoot`. An app whose condition list puts `import` ahead of `require` (sereus-chat's does) otherwise gets the ESM wrapper, and the bundle fails at startup with `_interopRequireDefault is not a function`. Expo's default conditions already pick the CommonJS file, so in this app the rule only makes every importer use the app's copy, the one § Key Dependencies requires to be 7.29.2 or newer.
  3. **`browser`-field variants for `@libp2p/crypto` and `@libp2p/webrtc`.** A resolved file inside either package that the package's `browser` field lists is swapped for its target; targets that are not paths (`"node:net": false`) are skipped. The map is read from the package directory of the file actually resolved, so every installed copy is covered: this app's Android export (2026-09-26) holds 15 copies of `@libp2p/crypto` (the app's, the repo root's, and nested ones under optimystic and Fret), all on their browser key modules. In `@libp2p/webrtc` the rewrite reaches `private-to-public`'s transport and `get-rtcpeerconnection`. Its `webrtc/index.js` entry never fires: Metro applies the package's `react-native` field first and resolves `webrtc/index.react-native.js`, which imports `react-native-webrtc` directly.

It sets neither condition names nor `unstable_enablePackageExports`: both toolchains' defaults already enable package exports, and the condition order is the app's choice. The helper's comments carry the full reasoning, and `packages/cadre-rn/test/metro/with-cadre-metro.spec.ts` guards the three rules, including rules 2 and 3 under sereus-chat's condition order (`import` ahead of `require`), resolved by Metro's own resolver.

> **Why the browser rewrite matters.** `@libp2p/crypto` has parallel
> `*.browser.js` variants for every module that would otherwise call
> `crypto.generateKeyPairSync`, `createPrivateKey`, `sign`, or `verify` from
> Node.js's built-in `crypto`.  The kit's `shims/node-crypto.js` intentionally
> only implements `createHash` (SHA-256/SHA-512 via `@noble/hashes`), so
> without the rewrite the first call to `generateKeyPair('Ed25519')` (phone
> peer identity, enrollment, strand solicitation) fails with
> `undefined cannot be used as a constructor`.  With package exports enabled,
> Metro returns a file it found through a package's `exports` without the `browser`
> rewrite (`@libp2p/crypto/hmac` resolves to the Node `hmac/index.js`; relative imports
> inside the package do get the rewrite, checked against metro-resolver 0.82.5), so
> rule 3 applies it by hand (`sereus-health/apps/mobile/metro.config.js` carries the
> same pattern).

## Two-Node Startup Sequence

This section walks through starting the drone and phone from scratch, establishing a connection, and chatting. The phone dials the drone, so the drone must be reachable from the phone; [architecture.md → Which Side Dials](architecture.md#which-side-dials-the-add-a-node-flows-compared) compares this with the other ways to add a machine to a cadre.

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

> **Cold-start trust.** A seed is signature-verified and its signer key must clear a trust anchor (`SeedTrustPolicy`) before it is accepted — the secure default (`anchoredTrustPolicy`) trusts only owner keys in the phone's node-local trusted-owner anchor, which is seeded out of band and never from replicated control state. A phone that has not been given the issuing cadre's owner key will therefore **reject** a seed signed by that cadre, no matter what its `OwnerKey` table has synced. A phone that is not the founder joins instead by pasting the cadre invitation an owner issued into **Paste cadre invitation** (the Join a Cadre section) and tapping **Join cadre** (`CadreNode.redeemCadreInvitation`): that pins the invitation's owner keys into the anchor and admits the phone at one of the member machines the invitation names, so later seeds from the same owner are accepted. The seed field is for a phone that already trusts the signer.

### Step 5: Create a Strand

1. On the phone's **Settings** tab, tap **Create Strand**
2. This calls `createChatStrand(cadreNode, uuid())` which:
   - Creates a `StrandRow` with `Type: 'o'` (open)
   - Registers the simplified chat sApp schema (Participant + Message tables)
   - Starts a strand-specific libp2p network (`strand-<strandId>`)
3. The drone (`profile: storage`, `strandFilter: all`) detects the new strand and joins it as a storage replica: it stores and serves the chat's blocks without the chat schema, since no chat app runs on it. So a phone that is lost after its messages reached the drone loses none of them (see [architecture.md → Strand Filtering](architecture.md#strand-filtering))

### Step 6: Chat

Switch to the **Chat** tab. Type a message and send. The message is:

1. Inserted into the local strand's Quereus database via `insertMessage()`
2. Replicated to the drone via Optimystic's P2P consensus, where it is stored as blocks
3. Visible on every phone that runs the chat

The drone has no chat schema, so it neither reads nor writes messages itself; it keeps their blocks for the phones. The chat screen polls for new messages every 2 seconds.

A strand write can fail without settling whether it landed, so a failed send says "Not confirmed sent … Press Send again" and leaves the text in the box. Pressing Send again is safe: `src/chat-send.ts` mints the message's primary key once per draft and re-presents that same key, so however many times the user presses Send on unchanged text the message can be stored at most once. The key is let go once the box stops holding that text (a cleared and retyped message is a new one), and when a poll shows the message did land, which also clears the notice and the box. See [`schema-guide.md` → Client-Generated Keys and Retrying a Write](schema-guide.md#client-generated-keys-and-retrying-a-write).

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

The startup sequence above has you run the always-on node yourself, from the command line. The other way to get one is to ask a machine running **cadre-host** — the self-hosted manager (`docs/cadre-host.md`) — to lend your cadre a node. The phone drives that from **Settings → Host Node**. Here too the phone dials the node; [architecture.md → Which Side Dials](architecture.md#which-side-dials-the-add-a-node-flows-compared) compares this with the other ways to add a machine to a cadre.

This is a **manual acceptance check**, not something CI runs. The headless coverage is `packages/reference-app-rn/test/host-node-request.spec.ts` (the phone's side of the protocol, against a fake host) and `packages/integration-tests/src/scenarios/cadre-host-donation-phone-requester.integration.ts` (the phone's own client, `src/host-node-request.ts`, run against the host's real `/grants` server and a real lent node, with a phone-shaped requester dialing in). That scenario covers the success path, a wrong grant token and the cleanup `DELETE` after a cancel; the retry loops and the other error mappings are covered only by the fake host. Neither runs on a device, uses React Native's `fetch`, or reaches the host by a LAN address (which the host's origin guard refuses), so this manual check is still the only coverage of those.

### On the PC

A test session needs a cadre-host data directory and a host running in the foreground, not an OS service. From a repo checkout:

```bash
yarn workspace @serfab/cadre-host build
node packages/cadre-host/dist/bin/host.js install --non-interactive --no-service --no-upnp --no-invite --data-dir <dir>
node packages/cadre-host/dist/bin/host.js start --data-dir <dir>          # prints "cadre-host local UI: http://127.0.0.1:<port>"
node packages/cadre-host/dist/bin/host.js grant issue "phone test"        # add --port <port> if start bound anything but 8765
```

With cadre-host installed globally, replace `node packages/cadre-host/dist/bin/host.js` with `cadre-host`.

- `install --no-service` writes the identity key and `host.config.json` into `<dir>` and registers no OS service. It is needed once per data directory. Without `--no-service`, `install` registers and starts a service (systemd, launchd, or NSSM on Windows, where it fails if `nssm.exe` is not on the PATH).
- `start` runs the host until Ctrl+C. Run `grant issue` from a second terminal.
- `grant issue` requires a label, which can be any text. It prints the grant token to paste into the phone.

**The management port** is `uiPort` in `<dir>/host.config.json`: 8765 unless `install` was given `--ui-port`. `start` binds it, or the next free port up to `uiPort+9` if it is taken, and prints the port it bound. `grant issue` talks to 8765 (or `$CADRE_HOST_PORT`) unless given `--port`. The steps below write 8765; use the bound port if it differs.

**If cadre-host is already installed as a service** (a plain `cadre-host install`), that service is the running host. Skip `install` and `start` and run only `grant issue`. Running `start` on top of the service starts a second host on the same data directory, on the next free port.

### Reaching the host from the phone

The grant surface (`/grants`) is loopback-only in v1: the host's origin guard accepts a `Host` header of `127.0.0.1` or `localhost` and nothing else, so a LAN-IP URL answers `403 forbidden_origin`. Forward the management port instead:

```bash
adb reverse tcp:8765 tcp:8765
```

Then enter `http://127.0.0.1:8765` as the Host URL on the phone.

Two things `adb reverse` does **not** cover:

- **libp2p traffic.** The phone dials the lent node directly, so the phone must be on the **same Wi-Fi LAN** as the PC. `adb reverse` needs every port named up front, and a lent node's strand nodes listen on ports the OS picks at start, so forwarding the control port alone is not a working setup.
- **The PC's firewall.** The phone's dial reaches the lent node on the PC's LAN address, so the firewall must allow incoming connections to it. On Windows, rules apply per network profile (Private or Public), and a home Wi-Fi can be classified Public. Windows prompts about `node.exe` only while no rule for it exists, so once any rule exists (including a Block rule left by an earlier prompt) nothing prompts again. The 2026-09-17 device run hit this: the Wi-Fi was Public, `node.exe` had two inbound Block rules (TCP and UDP, named "Node.js JavaScript Runtime") on Public and no Allow rule on any profile, no prompt appeared, and the phone's dials timed out.
  - **How to check** (PowerShell): `Get-NetConnectionProfile` shows the network's `NetworkCategory`. `Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Format-Table DisplayName, Direction, Action, Profile, Enabled` lists the rules for this `node.exe` (`Get-NetFirewallRule -DisplayName "*Node*"` also finds rules for other programs with Node in the name). `adb shell nc -w 3 <pc-lan-ip> <ws-port>` tests the path from the phone; a timeout means something between the phone and the node drops the connection. The WebSocket port is described under "If the flow stalls".
  - **Fix, either one** (administrator PowerShell): mark the network Private (`Set-NetConnectionProfile -InterfaceAlias <alias> -NetworkCategory Private`, with the alias from `Get-NetConnectionProfile`), which works only when an Allow rule for `node.exe` covers the Private profile (the 2026-09-17 PC had none); or add an inbound Allow rule on the profile the network uses, for `node.exe` or for the ports the host gives lent nodes (10000–20000 by default), for example `New-NetFirewallRule -DisplayName "cadre-host lent nodes" -Direction Inbound -Protocol TCP -LocalPort 10000-20000 -Action Allow -Profile Public`. That rule opens those ports to every program on every Public network, so remove it after the session: `Remove-NetFirewallRule -DisplayName "cadre-host lent nodes"`.
  - A Block rule overrides an Allow rule. An existing Block rule for `node.exe` on the network's profile has to be disabled or removed, whichever fix you choose: `Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Where-Object Action -eq Block | Disable-NetFirewallRule` disables every Block rule for this `node.exe`.

### The run

1. Connect the phone solo (Settings → Connect, no bootstrap address).
2. Settings → **Host Node** → paste the Host URL and the grant token → **Request Node**.
3. The progress line advances through: asking the host, waiting for the node to start, adding it to the cadre, seeding it, connecting. A failure opens the usual modal, with the host's own wording underneath the plain-language message.

Expected result: the stages reach `connected`, and the lent node's peer id appears among the phone's control connections.

Disconnecting (Settings → Disconnect) while a request is running cancels it: the app drops the authorization it had given the lent node and asks the host to end the loan, then brings the node down. It waits a few seconds for that to finish — not indefinitely, so a host that has gone quiet cannot hold up a logout. If the wait runs out, the loan is left for the host's own UI or `cadre-host` CLI to end.

Relaunching the app reconnects to the same cadre by itself (see [Start options](#start-options-app-private-leveldb)), so the phone should reach the lent node again from the address it recorded when it added it. The headless proof of that reconnect is the integration scenario named above; a device run has not checked it yet (blocked ticket `rn-host-node-request-device-run`).

### If the flow stalls

- **Stuck at "Adding the node to this cadre"** (the `authorizing` stage). That step writes to the control database. Run `yarn workspace @serfab/reference-app-rn vitest run --project metro-babel` and restart Metro with `--clear`: the Babel async-generator helper defect behind `rn-solo-founding-stall-on-device` left Quereus's lock held after an early-exit read, and it only exists in Metro's compiled bundle. The device-side confirmation of that fix is ticket `rn-solo-founding-device-run`, which has since landed.
- **Stuck at "Connecting to the node"**, then failing after 180 seconds. The phone reached the host over the forwarded port but cannot reach the node itself: check the Wi-Fi network and the firewall. The phone tries every address the host reported for the node, one at a time, giving each up to 21.5 seconds, so a few unreachable addresses (the PC's other network adapters, or LAN addresses a firewall drops) delay the connection by that much each but do not prevent it. The connect wait counts from the first dial, and the phone dials again whenever an attempt ends without a connection. The host reports a TCP and a WebSocket (`/ws`) address on every address the PC has, and the phone can use only the `/ws` ones. VPN adapters are a common source of extra addresses: on the 2026-09-17 run the host reported six, on the Tailscale address, the LAN address and `127.0.0.1`.
- **Network or app?** The host also reports `/ip4/127.0.0.1/tcp/<ws-port>/ws` for the lent node, where `<ws-port>` is the node's WebSocket port. The node's page in the host's local UI (Nodes) lists it under Ports as `ws`; it was 10004 for the first loan on a fresh host, but read it rather than assume it. With `adb reverse tcp:<ws-port> tcp:<ws-port>`, the phone's dial to that address reaches the node over USB. If the flow reaches "Connected" with the forward and times out without it, the app works and the cause is the network or the firewall. The forward is only a diagnostic: strand nodes listen on ports the OS picks at start, so it does not make chat work.

### Not covered here

- Strands on the lent node. A lent node launches no strand of its own — whether it should is ticket `always-on-nodes-host-strands-of-apps-they-do-not-run`.
- Reaching a host across the internet rather than a home LAN: the host maps each lent node's ports through its router ([cadre-host.md → NAT and DDNS](cadre-host.md#nat-and-ddns)); the node announcing those addresses is ticket `cadre-host-nodes-announce-public-addresses`.
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

Ticket, doc and commit writes never need to pause. On `yarn start`, the writes that must wait until the run ends are edits to bundled source and builds that change linked `dist` output. The optional watch narrowing (a Metro `blockList` for `tickets/`, `docs/` and similar) was measured to change none of this and is not configured; the accepted-tradeoff note beside `linkedRoots` in `metro.config.js` says when to revisit it.

One reload does not come from a write. If the app's connection to Metro drops (Wi-Fi, a lost `adb reverse`, Metro restarted), the next time the app loads a module bundled lazily (a dynamic `import()` fetched from Metro, such as optimystic's `import('p2p-fret')`), it reloads with `Bundle Splitting – Metro disconnected`.

**Frozen dev server.** `yarn workspace @serfab/reference-app-rn start:frozen` runs `expo start --dev-client` with `CI=1`, which turns Metro's file watching off. No write anywhere reaches the phone, so other work does not need to pause. Differences from `yarn start`:

- A reload (from the dev menu or a red box) serves each module as Metro first read it, not as it is on disk now. To put a rebuilt dependency on the phone, restart Metro.
- There is no interactive terminal: no QR code and no `r`/`m`/`j` keys. Metro prints `Metro is running in CI mode, reloads are disabled. Remove CI=true to enable watch mode.` followed by `Waiting on http://localhost:8081`, and the dev client connects as usual (its recent-servers list, or `adb reverse tcp:8081 tcp:8081`).
- Expo does not register the session with its servers, so a signed-in dev client does not suggest the project in its list.
- A port in use is not replaced by a prompt for another one; pass `--port <n>`.

Confirmed on a device (2026-09-16): the dev client connected through `adb reverse tcp:8081 tcp:8081` and the deep link `sereus-chat://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081`, and editing `polyfills/event.js` (a module imported outside components) and reverting it caused no reload, no JavaScript log lines and no `metro:observe` output.

**First launch on a cold Metro.** This applies to `yarn start` and `start:frozen` alike. After `yarn start --clear`, the dev client's first launch from the deep link gave up after about 10 s with "There was a problem loading the project. timeout" (okhttp `readResponseHeaders`): building the Android bundle on a cold cache takes about 20 s (4825 modules). Fetching the bundle once from the PC, then launching again, worked. Build the bundle before opening the app: start `metro:observe` first, which builds it when no client has loaded it yet (see below). To fetch it by hand instead, use the URL the observer prints on its first line (`bundle <url>`), which comes from Expo's manifest. Do not shorten it to `index.bundle?platform=android&dev=true`: the query carries transform options (`transform.engine=hermes` and others), and a bundle requested with different options is a different build.

**Why it reloaded.** Development builds log a line before any reload that starts in JavaScript (`polyfills/reload-reason.js` in `@serfab/cadre-rn`, loaded through `@serfab/cadre-rn/boot-check`), as a warning that logcat shows before the next `Running "main"`:

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

Only when `rn-leveldb` or another native dependency is added or changes version. Adding `react-native-quick-crypto`, `react-native-nitro-modules` and `react-native-quick-base64` (native Noise crypto) is such a change: a dev client built before them throws nitro's `ModuleNotFoundError` when the bundle first evaluates quick-crypto, which the app imports from its root (read from nitro's source, not yet seen on a device). Otherwise, JS-only iteration via the dev client.

### Tracing a strand founding

While a strand is being created, the pressed create button in Settings shows elapsed seconds, both create buttons are disabled until it settles, and a "still running" hint appears under the pressed button after 30 s. Nothing gives up at that point: founding is resumable, so reporting a failure would leave a strand the user believes was never created. The result modal reports the elapsed time on a line under its title.

Every build logs the Settings handler at both ends (`adb logcat -s ReactNativeJS`):

```
I ReactNativeJS: [settings] create strand 1a2b3c4d pressed
I ReactNativeJS: [settings] create strand 1a2b3c4d succeeded in 1400 ms
```

A failure is a `W` line, `failed after <n> ms:` followed by the error. No `pressed` line after a tap means the tap never reached the handler.

Development builds also log cadre-core's `sereus:cadre:timing` lines as `D ReactNativeJS` (enabled in `@serfab/cadre-rn`'s `polyfills/hermes.js`). Each awaited step of `CadreNode.foundStrand` and of the strand launch logs a line when it starts and another when it ends, so a step with a start and no end is the one that hung:

```
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: start +0ms
D ReactNativeJS: sereus:cadre:timing [foundStrand:<id>] publishStrand: 21ms +21ms
D ReactNativeJS: sereus:cadre:timing [startOrFoundStrand:<id>] strandManager.startStrand: start +0ms
D ReactNativeJS: 'sereus:cadre:timing [buildStrandRuntime:%s] createLibp2pNode: %dms +35ms', '<id>', 35
```

The trailing `+<n>ms` is `debug`'s time since that namespace's previous line. The last line shows how the older timing lines print on the device: they pass their values as `%s`/`%d` arguments, and React Native's console prints the placeholders unfilled with the values after them, rather than substituting them as a browser console does.

The headless counterpart is `test/solo-founding.spec.ts`: it builds the node from the kit's `buildPhoneNodeConfig`, with this app's override, over the rn-leveldb adapter (with an in-memory fake of the native module) and founds an open and a closed strand under a 10 s deadline. It runs library code as published, so it cannot catch a stall that only occurs in Metro's Babel-compiled bundle; Maestro flow 4 covers the device. The one such stall found so far, the Babel helper defect under Key Dependencies, has its own headless guard in `test/metro-babel/async-generator-cleanup.spec.ts`.

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
   `strandId`, `cadreInvitation`
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
| `flows/1-connect-and-send.yaml` | Cold launch → connect → join → create strand → send message → local echo |
| `flows/2-drone-to-phone.yaml` | Drone-side HTTP insert appears in phone chat within 5s |
| `flows/3-round-trip.yaml` | Bidirectional: phone send seen by drone; drone send seen by phone; both visible |
| `flows/4-solo-create-strand.yaml` | No drone: connect alone (empty party id and bootstrap) → create strand → result modal with its elapsed time |

Flows 1–3 share `_setup.yaml` for the connect/join/strand bootstrap. Flow 4 connects alone and does not use it; the orchestrator still runs it with the rest of the directory, and it can be run by itself with `maestro test -e MAESTRO_APP_ID=… maestro/flows/4-solo-create-strand.yaml`.

The cold phone has nothing in its node-local trusted-owner anchor, and
control-sync can never put the drone's owner key there. The phone therefore
joins the drone's cadre the way a real device would: the fixture enrolls its own
owner key (`ensureOwnerKey`) and mints a cadre invitation
(`createCadreInvitation`) whose member address is the drone's ws listener;
`start.mjs` writes it as `cadreInvitation`, the orchestrator threads it in as
`CADRE_INVITATION`, and `_setup.yaml` pastes it into `input-cadre-invitation`
and taps **Join cadre**, asserting the `Joined cadre` modal. Redeeming it pins
the drone's owner key and admits the phone at the drone, after which the control
database syncs under a trusted anchor.

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

