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

`denyDialMultiaddr` is set because libp2p's `connection-gater` points its `react-native` package field at the browser build, which refuses to dial insecure `ws://` and private addresses — LAN and loopback. A cadre-host node claimed on the same Wi-Fi is exactly that, in normal use rather than only in development, so the phone opts out of that default the same way the web reference app does. Only the dial is permitted: the connection is still Noise-encrypted, and membership is still gated by cadre-core's `denyDialPeer` plus its inbound and relay hooks. cadre-core threads this to strand nodes as well, which is wanted — they dial LAN addresses too.

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

Switching modes is Disconnect → choose → Connect, which builds a new node. The choice exists only in the disconnected form, so a strand founding or node claim in flight never sees a rebuild. The connected Node card's **Encryption** row names the mode the running node was built with. `cadre-phone.ts` records it when it builds the node (cadre-core keeps only the implementation), so a device run can confirm what it measured. Adding the native modules needs a native rebuild (§ When Native Rebuild Is Needed). Whether each mode stops the connection-monitor drops on a real device has not been measured yet: blocked ticket `rn-native-noise-crypto-device-run`.

**The ping deadline is already widened, for every node.** While the phone runs pure-JS crypto (`off` mode, or any build before the native crypto above) its event loop can stay busy for longer than libp2p's 5 second liveness-ping deadline, and libp2p aborts a connection on the first missed ping. Each redial costs another handshake, which keeps the phone busy — measured on a Galaxy S7's crypto cost, a two-party bring-up never finished. cadre-core therefore defaults `network.connectionMonitor` to a 30 second deadline, pinged every 35 seconds, on every node it builds (`DEFAULT_CONNECTION_MONITOR`), not only under React Native: the peer at the other end of the connection runs the monitor too, and its abort closes the connection just as effectively. The gap between pings has to exceed the deadline, or libp2p starts a second ping over the same connection while the first is still waiting and drops the connection for that instead. This app sets nothing for it.

**The first-sync wait is widened for the same reason, also for every node.** A phone that has just redeemed an invitation holds none of the strand's data, so cadre-core withholds the strand database until that data arrives from another member and rejects `addStrand` with the retryable `StrandAwaitingFirstSyncError` if it has not arrived within `strandFirstSync.timeoutMs` (see [`strands.md` → Joining](strands.md#joining-no-writes-before-the-first-sync)). Through a relay on a slow link that first sync is not quick: on a measured path with a round trip of a couple of seconds it takes tens of seconds, not the second or two a direct connection takes, and a phone re-attaching after being away can take longer than a first join. cadre-core's default wait (`DEFAULT_STRAND_FIRST_SYNC_TIMEOUT_MS`, whose doc comment carries the number, the measurements and what the budget costs) is sized for that re-attach. This app sets nothing for it. The chat screens re-render on `strand:writable` ([`use-cadre.ts`](../packages/reference-app-rn/src/use-cadre.ts)), so a sync that lands after any budget still opens the screen — but [`joinClosedChatStrand`](../packages/reference-app-rn/src/chat-strand.ts) writes the joiner's app-level role right after `addStrand` resolves, so a join that times out has to be retried before that role exists.


**The per-peer read deadline is widened for every node too.** Before serving a read whose local copy may be stale, a node asks the other holders of that block which revision is newest, and believes an answer only if it arrives inside a per-peer deadline. Optimystic's own default for that is 1000 ms — a LAN budget, and shorter than one round trip between two phones that reach each other only through a relay, so every holder read as silent and the read was declined and retried. cadre therefore derives it from the declared link on both the control node and every strand node: two link round trips, **7000 ms** at the default declaration (`COHORT_READ_DEADLINE_MS` in [`cluster-size.ts`](../packages/quereus-plugin-sereus/src/cluster-size.ts), whose doc comment carries the derivation, the measurement history and what the wider budget costs). This app sets nothing for it; `network.linkRoundTripMs` moves it with every other link budget if a deployment's link is slower, and `network.cohortQueryTimeoutMs` overrides it on both networks at once.

### Release builds: cleartext WebSocket

Android refuses connections without TLS unless the app opts in, and it counts `ws://` as cleartext by its scheme. React Native's template opts in for debug builds only (`android/app/src/debug/AndroidManifest.xml`), so without an opt-in a debug build dials `/ws` addresses and a release build from the same project dials none of them: no drone, no cadre-host node, no relay (gotchoices/sereus#38). The kit's Expo config plugin opts in for every build. `app.config.ts` adds `"@serfab/cadre-rn"` to `app.json`'s `plugins`, and the plugin sets `android:usesCleartextTraffic="true"` on the main manifest's `<application>` element at prebuild. [The kit's README](../packages/cadre-rn/README.md#config-plugin-expo) has the line to add by hand in a bare React Native app.

**Why this is safe.** Every libp2p connection is encrypted and authenticated by the Noise handshake against the peer id in the dialed address, so a party between the phone and the node can neither read the traffic nor pose as the node. TLS underneath would add a dependency on certificate authorities and no security, and Sereus is designed to need no certificate authority. A claim's secret does not cross the wire either: `claimNode` sends an HMAC proof of it ([`claim-proof.ts`](../packages/cadre-core/src/claim-proof.ts)) inside the Noise channel.

**A network security config takes precedence.** If the app sets `android:networkSecurityConfig` and that file forbids cleartext, for its base config or for a domain, Android follows the file over the manifest flag and `/ws` dials stay blocked. Such an app permits cleartext in its own network security config; the plugin does not edit that file.

**iOS is unverified.** This app does not set `NSAllowsArbitraryLoads`, and whether App Transport Security (ATS) applies to React Native's WebSocket on iOS has not been checked. An iPhone release build dialing a public `/dns4/…/ws` address over cellular settles it. If ATS refuses the dial, the same reasoning supports an ATS exception in the kit's plugin.

### Reachability: configuring a relay

A React Native app cannot open a listener, so on its own the phone node has **no multiaddr at all**. That is fine for almost everything the app does — founding and reading strands, dialling out to a drone or to a cadre-host node it claimed, joining somebody else's invitation — because in all of those the phone is the side that dials. It is not fine for **inviting**: the phone runs the strand it invites to, so the joiner must be able to reach the phone itself, and the app refuses to mint an invitation while the phone has no address (`use-cadre.ts`). `CadreNode.createOpenInvitation` alone would still mint one that names only the party's other machines, which may not run a strand the phone has just founded yet.

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
| Dial a drone / a claimed cadre-host node, sync, chat | yes | yes |
| Join a closed strand from someone else's invitation | yes | yes |
| **Create a closed strand + invite** | yes | **no** — refused before anything is founded, with a message naming this field |

**It never blocks startup.** The config sets `requireRelay: false`, so a relay that is unreachable at launch is logged and retried in the background instead of failing `start()` — a phone has to work on a dead network. The posture is visible as **Reachable** on the Settings Node card and in the chat screen's connection banner, and it is read live at the moment Invite is tapped, so a relay that comes back mid-session starts working with no restart.

**Two costs worth knowing.** A configured-but-unreachable relay adds one reservation drive to `start()` and one more to **every** strand launch: cadre-core waits out each reservation supervisor's first attempt, and a refused dial spends that attempt's whole deadline polling for a circuit address (18 s at the default declared link; `relayReservationBudgetMs` in `link-budget.ts`). Nothing fails — founding is just slower while the relay is down, which the Settings screen's slow-founding hint will surface.

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

## Messages Not Yet Delivered

A message this phone sends is stored even when no other member is connected to take a copy, and is then lost if the phone is lost before it reconnects. The chat shows such a message as "Not yet delivered" ([`strands.md` → A commit's durability](strands.md#a-commits-durability)): `insertMessage` ([`chat-operations.ts`](../packages/reference-app-rn/src/chat-operations.ts)) inserts with `returning StampId() as Tx`, and [`use-chat.ts`](../packages/reference-app-rn/src/use-chat.ts) reads that commit's durability in the same step that records the mark (an earlier read could miss a `strand:commit-held` emitted while the send's awaits unwound) and clears the mark when `strand:commit-held` names the commit. The NativeScript (`chat-vm.ts`) and web (`messages.svelte.ts`) reference apps do the same. A founder alone in its strand sees every message marked until a member joins and takes the copies. The marks are held in memory: a message read from storage carries none, and a mark whose commit nothing follows (or whose follow a hibernation forgot) stays until the app restarts: it means "not confirmed delivered", not "lost".

## Node-Local Persistence

What the phone node keeps *locally* — never replicated, never derivable from the network — and where each lives.

### Peer identity (secure enclave)

The phone node maintains a stable PeerId across app restarts:

1. **First launch** — cadre-core generates an Ed25519 keypair and stores it through `SecureStoreKeyStore` (`@serfab/cadre-rn/key-store`), a `KeyStore` over `expo-secure-store`: iOS Keychain / Android Keystore-encrypted preferences, under the reserved `sereus.ks.` key prefix plus a `__index` entry listing the keyIds it holds.
2. **Subsequent launches** — the key is loaded from the enclave, producing the same PeerId every time.
3. **Single identity** — the same key is used for both the control network and all strand networks, matching the one-key-per-device architecture.

`CadreNode` resolves the key from that store when it starts. A locked/refused enclave read propagates and **fails the start** rather than booting on a replacement key.

Gating: the store is opened **ungated** (no `requireAuthentication`) with `keychainAccessible: AFTER_FIRST_UNLOCK`, because the node must come up headless on a push wake while the device is locked, and because a biometric-set change would invalidate the entry. Earlier development builds kept the key in plaintext MMKV, then plaintext LevelDB; there is no upgrade path from either, and none was ever needed. The app reads its identity only from the enclave and generates one there on first run.

### Owner key (secure enclave)

The phone's owner key, when it holds one, sits in the same `SecureStoreKeyStore` as the identity, in a slot of its own (`cadre/owner`), with the same ungated options: background owner writes sign with no user present. It is never derived from the identity. The kit creates it only when this app founds a party that has no owner yet, or redeems or joins with an owner grant while the slot is empty; otherwise it arrives by import under Settings → [Owner Keys](#owner-keys) ([kit README → The phone's owner key](../packages/cadre-rn/README.md#the-phones-owner-key)). One per install, not per party. An iOS reinstall keeps it with the identity, so a fresh install that founds a party founds it with the surviving key; an Android uninstall loses it, and the phone is then an owner of nothing until it imports a backup.

### Trusted-owner anchor (secure enclave)

The set of owner public keys this device believes speak for its party — what seed acceptance, wake authorization, and vouching all check against. Persisted by cadre-core's `PersistentTrustedOwnerStore` over a `DurableSlot` the app supplies: one `expo-secure-store` entry under its own `sereus.anchor.<base64url partyId>` key (`@serfab/cadre-rn/node-local`). Deliberately *not* under the key store's `sereus.ks.` prefix, whose `__index` must never see a foreign entry.

The anchor is not secret but it **is** trust-bearing — anything that can silently edit it can make this device trust a stranger — so it gets the most tamper-resistant store the app has, and shares the identity key's fate (including surviving an iOS reinstall, which is the desirable direction: same peer id, same trusted owners). The slot is ungated for the same headless reason as above, and `secureStoreSlot` **refuses** a gated slot outright: its "a `null` read means absent" mapping would misreport a biometric-invalidated anchor as empty, and the next snapshot write would make that permanent.

### Bootstrap dial targets (app-private LevelDB)

The dial targets the node learned out of band: the preferred peers (the minter and the always-on machines) of every seed it has applied, and every node it added (a claimed cadre-host node, a provider drone). They are the only addresses a stranded node has to re-dial its way back into the party, and the only ones the phone has for a node it added until that node publishes a signed address record. Persisted by cadre-core's `PersistentBootstrapPeerStore` over a `kvStoreSlot`: one key of a `LevelDBKVStore` in the app-private `sereus-node-local` database, separate from any strand's database so clearing it cannot disturb replicated data.

Not the enclave, for two reasons: dialing grants no authority (`CadreNode` re-binds every retained address to the peer id it was recorded under before dialing), and multiaddrs run 80–120 characters each with several per peer and the snapshot growing for the node's whole lifetime — it would cross SecureStore's ~2048-byte value limit and simply fail the write.

Both records are party-scoped, as are the enrolled-machine count and the strand network state beside them in the same database. They are read back on a relaunch because the party id itself is remembered, below.

### Start options (app-private LevelDB)

What the node last started with — party id, bootstrap addresses, relay addresses, Noise crypto mode, and how the app came to that party (`origin`, `formerPartyId`, below) — plus `autoStart`, whether to start again unattended. One record under the key `start-options` in the same `sereus-node-local` database, deliberately **not** party-scoped: it is what selects the party every record above is filed under. The kit's `parseSavedStart` (`@serfab/cadre-rn/phone-node`) parses it: unparseable JSON, an unknown version or a missing party id counts as no record (logged), while a malformed address list or Noise mode falls back to its default rather than costing the phone its party id. Not the enclave: nothing in it is secret or trust-bearing, and a relay list can outgrow SecureStore's value limit.

- **Written** only by the kit's `PhoneNode` (`cadre-phone.ts` is this app's): after every successful start and after a join a member admitted (`autoStart: true`, with the options exactly as the node ran with them), and on Settings → **Disconnect** (`autoStart: false`, same options — Disconnect is logging out, which also clears the push-wake device token). A failed start writes nothing, so a typo in Settings cannot replace the last configuration that came up. An OS kill runs no code, so `autoStart` stays true across one. Both writes are best-effort: a failure is logged and the node carries on.
- **Read** once at app launch (`use-cadre.ts`). With `autoStart` true the app connects by itself with those options, exactly as a Connect tap would — this is what keeps a solo phone in the same party across relaunches instead of founding a new one. Either way the Settings form prefills from them. The same options are what the background runner's cold start uses after the OS kills the node, and what a push wake into a killed process starts from (`push-wake-native.ts`), again only while `autoStart` is true. A read fault shows "Could not read the saved connection settings" under the Node card and starts nothing. After a join, or the removal of the cadre it left, the form refills from the options the node then runs with, so a later Disconnect → Connect starts the joined party.
- **Stored values win over build defaults.** Relays and Noise mode are saved as resolved, not as "use the build default", so a later build with a different `EXPO_PUBLIC_RELAY_ADDR` or `EXPO_PUBLIC_NOISE_CRYPTO` does not change a device that has already connected. To pick up a new default: Disconnect, clear the Relay field (empty means the build default) or choose the mode, and Connect.
- **Switching party** is Disconnect, edit Party ID, Connect. The old party's records stay on disk and are read again if the phone switches back.
- **Joining another cadre** is Settings → **Join my existing cadre** ([Joining an Existing Cadre](#joining-an-existing-cadre)): the kit's `joinCadre` stops this app's node, starts one in the invitation's party, and waits there until a member the invitation names admits the phone ([architecture.md → An app joins an existing cadre](architecture.md#an-app-joins-an-existing-cadre)). Only then is the record saved, with `origin: 'joined'` and `formerPartyId`, the party this app founded and left; a failed join puts the left party's node back and saves nothing. Leaving a party it founded, the join also moves that party's chat strands into the joined one, and is refused up front when the credential is a machine invitation, since only an owner can seat the moved rows ([kit README → Moving the app's strands](../packages/cadre-rn/README.md#moving-the-apps-strands)).
- **`origin`** is `'founded'` (or absent) for a party this app started itself, which runs owner genesis on every start (creating the owner key only while the party has no owner), and `'joined'` for one it joined, which never does: the phone is an owner there only when the party lists its owner slot's key, and the Node card shows no owner key otherwise. A Connect whose Party ID is the saved party keeps the saved `origin`.
- **Overlapping starts** — a launch auto-start, a push-wake cold start, the runner's resume and a Connect tap — share one start in flight, so they never build two nodes; the first caller's options win. Disconnect during a start waits for it, then stops the node it produced; a start during a Disconnect runs after it, and a cold start reading the record mid-Disconnect reads `autoStart: false`.
- **Reinstall.** On iOS the trusted-owner anchor lives in the Keychain, which survives an uninstall; this record does not. A reinstalled phone picks a new party id and the surviving anchor, filed under the old one, is never read again — the same outcome as before start options were saved.

The Maestro flows launch with `clearState: true`, so they always see a fresh, idle app.

### Dissolve marker (app-private LevelDB)

The party whose local storage the kit is deleting, while `PhoneNode.dissolveFormerParty` removes the cadre this app founded and left ([architecture.md → Dissolving the party it left](architecture.md#dissolving-the-party-it-left)). One record under the kit's default key `dissolving-party` in the same `sereus-node-local` database, beside the start options and, like them, one per install rather than party-scoped. It is written before the first deletion and deleted after the start options stop naming that party as `formerPartyId`, so a launch after a crash partway finishes the deletion before it starts the node. Settings → Join my existing cadre runs the dissolve after a join ([Joining an Existing Cadre](#joining-an-existing-cadre)); `cadre-phone.ts` passes rn-leveldb's `LevelDB.destroyDB` to the kit for it.

### Open link request (app-private LevelDB)

The join request this app opened as a link to an owner app on this phone and has not taken an answer to: `{ nonce, ownerAppName, startedAtMs }` (the kit's `LinkRequestStore` in `@serfab/cadre-rn/app-link`, over `PhoneNode.linkRequestSlot()`). One record under the kit's default key `link-join-request` in the same `sereus-node-local` database, one per install. It is saved before the owner app opens, so an answer that cold-starts this app after the OS killed it is still taken; it is cleared by Cancel, by the answer it takes, by a join from a pasted or scanned response, and when this app's own request opens it. A record older than 30 minutes reads as none. The nonce is what an answer must carry, so the record is kept out of logs; nothing in it is trust-bearing beyond that. Read at launch for the waiting line ([Joining an Existing Cadre](#joining-an-existing-cadre)) and again by each answer.

### Recommended apps (app-private LevelDB)

The Sereus apps the user allowed to join before they asked, under [Recommend an app](#recommend-an-app): a list of `{ scheme, appName, partyId, approvedAtMs }`, at most one entry per scheme (the kit's `AppRecommendationStore` in `@serfab/cadre-rn/app-link`, over `PhoneNode.recommendationSlot()`). One record under the kit's default key `recommended-apps` in the same `sereus-node-local` database, one per install; each entry names the party it was allowed in and is returned only for that party.

- **Single use, one hour.** The request an entry answers removes it, and an entry older than an hour reads as none.
- **Trust-bearing.** An entry lets this app make an invitation without a prompt, so logs name only the app.
- **Cleared** by Withdraw, by the request it answers, and by expiry. Allow and a use also drop every other party's entries as they write.

### Provider tokens (secure enclave)

The access and refresh tokens this app holds for a hosting provider's account, after the user signed in under [Renting a Provider Node](#renting-a-provider-node): `{ accessToken, refreshToken, expiresAt, scopes }`, one `expo-secure-store` entry per provider under `sereus.provider-tokens.<base64url provider id>` (the kit's `providerTokensSlot` in `@serfab/cadre-rn/provider`), ungated, with the default accessibility since the tokens are used only while the app is in front. They are credentials for the customer's account at the provider, which is why they sit with the identity key rather than in LevelDB, and why nothing logs them. Every refresh rotates the pair and overwrites the entry (`createTokenSource`'s `persist`); Sign out deletes it; a refresh the provider refuses deletes it too, and the rows say to sign in. One per install, not per party: the account is the user's, whatever cadre the app is in.

### Provider rentals (app-private LevelDB)

The nodes this app rented from a hosting provider, by party: a list of `{ providerId, providerName, containerId, join, peerId?, createdAt, finished }` under the kit's `rentals.<partyId>` key in the same `sereus-node-local` database (the kit's `rentalStore` in `@serfab/cadre-rn/provider`, over `PhoneNode.nodeLocalRecords()`). cadre-core's `rentNode` persists nothing, so this record is what lets the app find a rental it was killed in the middle of (`finished: false`) and offer Finish adding, poll the provider for each node's standing, and mark a rented node in Devices and nodes. Not trust-bearing: it names a container to ask the provider about, and the provider's answer, not the record, is what the app shows; a record that cannot be read reads as no rentals, logged, since the containers still exist on the provider's own pages. Written when the provider creates the container, updated when `rentNode` or `finishRental` returns and when a status read first reports the node's peer id, and dropped by Cancel, Forget and Remove from cadre.

## cadre-core React Native Compatibility

### Validated (2026-02-23)

`cadre-core` imports `createLibp2pNode` from `@optimystic/db-p2p`. That package's `exports` field includes a `react-native` condition pointing to `rn.js`, so Metro automatically selects the RN-safe entrypoint (no TCP import). Transport injection in `createControlNode()` and `StrandInstanceManager` already works.

**cadre-core** now declares a `react-native` export condition in its `package.json`. Source audit confirmed two Node-only dynamic imports — `require('path')` in `getStrandStoragePath` and `require('fs/promises')` in `ControlDatabase.loadSchema` — both runtime-guarded behind `process.versions?.node` checks and restricted to Node-only code paths.

**Quereus** has no Node-only imports. BigInt is supported in Hermes since RN 0.70. Only `TextEncoder` is used (built-in to Hermes); `TextDecoder` is not required by Quereus. However, `@optimystic/db-p2p` (and `uint8arrays`, which it pulls in transitively via libp2p/yamux/multiformats) uses `TextDecoder` at module scope — this is covered by Expo SDK 52+'s built-in `TextDecoder` global (UTF-8 only). On **bare RN** Hermes (non-Expo) `TextDecoder` is NOT present as of RN 0.85, so `@serfab/cadre-rn`'s `polyfills/hermes.js` ships a UTF-8-only fallback that becomes a no-op once the runtime provides it.

**Metro bundle** succeeds with 2790 modules (cadre-core, Quereus, db-p2p, libp2p, and all transitive deps). The only warnings are cosmetic: `multiformats` subpath export fallbacks that resolve correctly via file-based resolution.

### Polyfills

The global polyfills live in the React Native kit, [`@serfab/cadre-rn`](../packages/cadre-rn/README.md), under `packages/cadre-rn/polyfills/`. A Sereus React Native app depends on the kit rather than copying the files. In this section, `polyfills/<file>.js` means the kit's file. The Node built-in shims Metro maps (`node-os.js`, `node-crypto.js`, `empty.js`, below) are in the kit's `shims/` directory, wired in by `@serfab/cadre-rn/metro` (§ Metro Configuration).

The app's job is four imports at the top of its entry file (`index.js`), before `expo-router/entry` loads any library code. This is critical because libp2p and its dependencies reference Web APIs at import time, so `@serfab/cadre-rn/polyfills` must come first:

```js
import '@serfab/cadre-rn/polyfills';          // hermes.js, intl-pluralrules.js, event.js, in that order
import '@serfab/cadre-rn/polyfills/native-crypto';   // native Ed25519 and digest from react-native-quick-crypto
import '@serfab/cadre-rn/polyfills/webrtc';   // react-native-webrtc registerGlobals(), for @libp2p/webrtc
import '@serfab/cadre-rn/boot-check';         // audit.js and reload-reason.js, under __DEV__ only (below)
import 'expo-router/entry';                   // App code starts here
```

The boot check is imported rather than called, and its position is the point: every statement in `index.js`'s own body runs only after all of its imports have evaluated, which includes `expo-router/entry` and the app tree behind it. A global that is missing would crash at that import and the table would never print. Imported here, it prints first.

Native crypto loads before anything imports libp2p because `@libp2p/crypto` probes for WebCrypto Ed25519 once, when its `keys/ed25519` module evaluates, and signs in pure `@noble/curves` for the rest of the run if the probe failed. It loads after `/polyfills` because requiring quick-crypto loads its `readable-stream`, which reads globals `hermes.js` installs.

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
| `crypto.subtle.digest()` | multiformats/hashes/sha2-browser | Async SHA-256/SHA-512 via @noble/hashes at boot; replaced with react-native-quick-crypto's native hash when `@serfab/cadre-rn/polyfills/native-crypto` or `@serfab/cadre-rn/noise-crypto` loads (`/native-digest`) |
| `structuredClone()` | @optimystic/db-core (transform tracker, cache-source, coordinator) | Copies plain objects, arrays, primitives, the standard typed arrays, `ArrayBuffer`, `DataView`, `Date`, `RegExp`, `Map` and `Set` itself, keeping shared references and cycles. A value holding anything else (a class instance, an `Error`, a `Buffer`), or a call with options, goes whole to `@ungap/structured-clone`, which is several times slower |
| `Symbol.asyncIterator` | `for await...of` on custom iterables | Some Hermes versions omit this. Guarded definition uses `Symbol.for('Symbol.asyncIterator')` (registry) so independent polyfills converge on the same symbol |
| `ReadableStream`, `WritableStream`, `TransformStream` | Vercel AI SDK, streaming libraries | via `web-streams-polyfill`. No-op under Expo SDK 53: Expo's Metro config adds `expo/virtual/streams.js` as a bundle polyfill, which runs before the entry module, and the 2026-09-16 device audit reported all three `native` |
| `Promise.withResolvers()` | @libp2p/utils, @chainsafe/libp2p-yamux, it-queue, mortice, abort-error | ES2024 API |
| `AbortSignal.prototype.throwIfAborted()` | libp2p, @libp2p/utils, @libp2p/circuit-relay-v2, it-pushable, p-retry | DOM spec addition |
| Timer `.ref()` / `.unref()` | @optimystic/db-p2p, undici, libp2p internals | Wraps Hermes numeric timer IDs in objects; also patches `clearTimeout`/`clearInterval` to unwrap (see `hermes.js` `// ── Timer .ref() / .unref() ──` section) |
| `TextDecoder` | `uint8arrays` (via libp2p / multiformats / yamux); Optimystic decodes every block it reads from storage | UTF-8 only; throws `RangeError` for any other encoding. Invalid input decodes as the Encoding Standard says, one U+FFFD per invalid sequence. No-op on Expo SDK 52+, which installs one in `expo/src/winter/runtime.native.ts`; the 2026-09-16 device audit under SDK 53 reported it `native` |
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
| `packages/cadre-rn/polyfills/native-crypto.js` | `crypto.subtle` `generateKey`, `importKey`, `exportKey`, `sign`, `verify`; native `digest` | @libp2p/crypto's `keys/ed25519/index.browser.js`, which signs through WebCrypto when its load-time probe succeeds | react-native-quick-crypto's `subtle`, through `@serfab/cadre-rn/native-ed25519`. Exported separately as `@serfab/cadre-rn/polyfills/native-crypto`, so an app without quick-crypto need not install it |
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
  app.config.ts               # app.json plus the kit plugin with its appLinks extras, and the APP_VARIANT=second install
  package.json                # workspace:^ deps on cadre-core, db-p2p, etc.
  tsconfig.json
  metro.config.js             # withCadreMetro(...) with this repo's linked roots
  eas.json                    # EAS Build profiles (development, development-second, preview)
  app/
    _layout.tsx               # Expo Router root layout
    index.tsx                 # Chat screen (message list + input)
    settings.tsx              # Bootstrap config (drone address, join an existing cadre, add a device or app, devices and nodes, seed paste, always-on node), and the card after this app was removed
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
    use-chat.ts               # React hook: message list, send, "not yet delivered" marks
    use-cadre.ts              # React hook: cadre lifecycle, seed application, strands, invitations
    use-join-flow.ts          # Its part behind Join my existing cadre: the join, moving chats, removing the old cadre
    use-link-request.ts       # Its part behind Choose the app that holds your cadre: the request opened as a link, the answer taken
    join-link.ts              # The links to and from another Sereus app on this phone (a recommended one too), and the words for an answer
    recommended-by.ts         # Which Sereus app recommended this one: the Android install referrer or a link, checked against the known apps
    use-recommending-app.ts   # Settings' part of joining that app: which app the first-launch question names, and the prompt while this app has a cadre
    join-flow.ts              # The steps after Join (joining, moving chats, removing the old cadre) and their words
    join-failure.ts           # Plain words for each way a join can fail before admission (NS carries a copy)
    settings-controls.tsx     # Section, button, input, confirmation prompt and styles shared by Settings and its sections
    owner-standing.ts         # Whether this app is an owner of its cadre, for the sections with owner-only actions
    add-node-section.tsx      # Settings → Add an always-on node: scan or paste a cadre-host code, approve, claim
    add-device-section.tsx    # Settings → Add a device or app: mint a cadre invitation for another app; list and withdraw open ones
    machines-section.tsx      # Settings → Devices and nodes: the cadre's machines and the devices invited; an owner removes one
    machine-removal.tsx       # Removing a machine: the plan, the confirmation, removeMachine; shared with the provider section
    machines.ts               # What Devices and nodes shows: a machine's kind and last-seen time, the devices invited, a rented node's provider
    owner-keys-section.tsx    # Settings → Owner keys: the cadre's owner keys; make an owner grant or a backup, redeem one, export, import, remove a key
    owner-grant-views.tsx     # Owner keys' grant parts: the grant form, the grant shown once, the outstanding grants, Redeem an owner grant
    owner-keys.ts             # What Owner keys shows: a key's name and facts, the forms' checks, an import's or a redemption's outcome, the removal's Keep switches and grant lines, the refusals' words
    provider-store-section.tsx # Settings → Rent an always-on node: the provider, sign-in in the browser, rent, the rows for rented nodes
    use-rental-poll.ts        # The rows' re-read from the provider every few seconds, only while Settings is in front and the app is in the foreground
    provider-session.ts       # One provider's descriptor, tokens and client; sign-in again, once, when the provider refuses the tokens
    providers.ts              # The configured provider (EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL), the redirect URI, the plan list
    rentals.ts                # What a rented node's row shows and offers; the words for each way renting fails
    recommend-app-section.tsx # Settings → Add a device or app → Recommend an app: allow another app to join, then get or open it
    join-cadre-section.tsx    # Settings → Join my existing cadre: choose the app holding the cadre, this app's request, paste or scan the answer, the join's steps
    code-scanner.tsx          # Full-screen camera (expo-camera) that reads a QR code of the kind its caller accepts
    share-code.tsx            # Text to hand another app: QR code (react-native-svg), Copy (expo-clipboard), selectable text
    qrcode-core.d.ts          # Types for importing the qrcode package's encoder without its renderers
    node-claim.ts             # Reads a node code; plain words for each way a claim can fail
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
  native-crypto.js            # @serfab/cadre-rn/polyfills/native-crypto: native Ed25519 and digest behind crypto.subtle
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
| `@serfab/cadre-rn` | `workspace:^` | Hermes polyfills and the development-build boot check (§ Polyfills); Metro configuration (§ Metro Configuration); native Noise crypto (§ Phone (RN app) Configuration); the Expo config plugin that lets release builds dial `/ws` (§ Release builds: cleartext WebSocket) |
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
| `expo-camera` | npm | Scans a cadre-host node code (§ Adding a Home Machine's Node). Native: needs a rebuilt dev client (§ When Native Rebuild Is Needed). Its `app.json` plugin entry sets the camera usage text; its microphone text repeats the WebRTC plugin's "Unused" one, because `microphonePermission: false` deletes the iOS key that plugin sets |
| `expo-clipboard` | npm | The Copy button of a shown invitation (§ Adding a Device or App). Native: needs a rebuilt dev client |
| `expo-application` | npm | Reads the Android install referrer, which names the Sereus app whose store link installed this one (§ Joining an Existing Cadre). Native, but already linked through `expo-notifications` (§ When Native Rebuild Is Needed) |
| `react-native-svg` | npm | Draws an invitation's QR code. Native: needs a rebuilt dev client |
| `qrcode` | npm | Encodes the QR code. Only its encoder is imported (`qrcode/lib/core/qrcode`); the package root also loads canvas and SVG-string renderers the app does not draw with |
| `@libp2p/utils` | npm | `isPrivateIp`, which decides whether a node code's addresses reach beyond the machine's home network |
| `@babel/runtime` | npm | Helpers imported by Metro's Babel output; must be 7.29.2 or newer (below) |

**Babel helpers must be 7.29.2 or newer.** Hermes has no native async generators, so Metro's Babel transform rewrites them onto Babel's `wrapAsyncGenerator` helper, imported from `@babel/runtime` (or inlined from `@babel/helpers` for script sources). Before 7.29.2 that helper stopped a generator's `finally` at its first `await` when the consumer left a `for await` loop early. Quereus releases its execution lock in such a `finally`, so on the phone the first early-exit read (`strandTableCount`) left the lock held, and founding a strand hung at `StrandDatabase.bootstrapFounder`. Node runs async generators natively, so no headless test saw it. The app declares `@babel/runtime` `^7.29.2`, and `test/metro-babel/async-generator-cleanup.spec.ts` (Vitest project `metro-babel`) compiles an early-exit probe with the app's own Metro Babel transformer and fails, naming the upgrade, if any helper a bundle would use drops that cleanup. Upgrade inside Babel 7 with `yarn up -R @babel/runtime @babel/helpers` (a bare `yarn up` moves to Babel 8), then restart Metro with `--clear` so it recompiles.

#### The web APIs the phone's connectivity depends on

**Three of them decide whether the phone can dial at all.** Hermes provides no `AbortSignal.timeout`, no `AbortSignal.any`, and React Native's WebSocket has no `bufferedAmount` — on the instance or on the prototype — and libp2p reads all three on the dial path. `connection-manager/dial-queue.js` calls `AbortSignal.timeout(this.dialTimeout)` for any dial that does not carry its own signal, so without it every such dial threw `TypeError: AbortSignal.timeout is not a function`. `@libp2p/websockets` gates each write on `websocket.bufferedAmount < 4194304`, and `undefined < 4194304` is `false` — so the transport concluded the socket was full, waited for a drain event that could never arrive, and the dial died on the ten-second timeout as `AbortError: The operation was aborted` with nothing naming the cause. `polyfills/hermes.js` supplies all three. With them, a device session on 2026-09-16 connected in 1.6 s, held a relay reservation for the first time, and completed a cross-party `formStrand` through that relay.

**React Native drops abort reasons, which is why that failure was opaque.** `Libraries/Core/setUpXHR.js` installs the `abort-controller` npm package (3.0.0) as the global `AbortController`/`AbortSignal`, unconditionally replacing whatever the engine had. That release predates the DOM's `reason`: its `abort()` takes no argument and nothing ever defines `signal.reason`. Every `controller.abort(err)` in the bundle therefore lost its error, and `throwIfAborted` fell back to a generic `AbortError`. `polyfills/hermes.js` records the reason on the signal before delegating, so a dial timeout now surfaces as `TimeoutError` and a cancelled operation carries whatever the caller passed.

**`crypto.subtle` has no AES-GCM surface.** `polyfills/hermes.js` defines a `crypto.subtle` object with a single `digest` method, and `polyfills/native-crypto.js` (which this app imports) adds react-native-quick-crypto's `generateKey`, `importKey`, `exportKey`, `sign` and `verify`. Those serve every algorithm quick-crypto supports, so besides Ed25519 signing, `@libp2p/crypto`'s `keys/index.js` ECDSA and RSA `importKey`/`exportKey` calls reach quick-crypto; the phone uses only Ed25519, so that path is unexercised here. `@libp2p/keychain` calls `encrypt`, `decrypt` and `deriveKey` through `ciphers/aes-gcm.browser.js`; nothing installs them, so any of them throws a `TypeError` the moment it is reached. The phone does not use the keychain. This is a dormant path, not a working one — anything that wants the keychain breaks immediately and needs those methods first.

An app without `/polyfills/native-crypto` has only `digest`: libp2p signs Ed25519 in pure `@noble/curves` (169 ms per verify on a Galaxy S7, against 0.72 ms native), and the ECDSA and RSA calls throw a `TypeError` as well.

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
2. Go to the **Settings** tab. On a first launch the Node card asks "Do you already use Sereus apps?" ([Joining an Existing Cadre → First launch](#joining-an-existing-cadre)); tap **No, start fresh** for the Connect form
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

> **Cold-start trust.** A seed is signature-verified and its signer key must clear a trust anchor (`SeedTrustPolicy`) before it is accepted — the secure default (`anchoredTrustPolicy`) trusts only owner keys in the phone's node-local trusted-owner anchor, which is seeded out of band and never from replicated control state. A phone that has not been given the issuing cadre's owner key will therefore **reject** a seed signed by that cadre, no matter what its `OwnerKey` table has synced. A phone that is not the founder joins instead by pasting the cadre invitation an owner issued into **Paste response or invitation** (the Join my existing cadre section) and tapping **Join** (the kit's `PhoneNode.joinCadre`, which redeems with `CadreNode.redeemCadreInvitation`): that switches the app to the invitation's party, pins the invitation's owner keys into the anchor and admits the phone at one of the member machines the invitation names, so later seeds from the same owner are accepted. The seed field is for a phone that already trusts the signer.

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


## Adding a Home Machine's Node (cadre-host)

The startup sequence above has you run the always-on node yourself, from the command line. The other way to get one is a machine running **cadre-host**, the self-hosted manager ([cadre-host.md](cadre-host.md)). Choosing **Join a cadre** there starts a node waiting to be claimed and shows a code, as a QR code and as text ([cadre-host.md → Join by QR code](cadre-host.md#join-by-qr-code)). The phone reads that code in **Settings → Add an always-on node** and claims the node with `CadreNode.claimNode`: it dials the node, proves it holds the code's secret, and once the node accepts, writes the node's `CadrePeer` row and keeps its addresses as a dial target. The phone is the side that dials; [architecture.md → Which Side Dials](architecture.md#which-side-dials-the-add-a-node-flows-compared) compares this with the other ways to add a machine to a cadre.

This is a **manual acceptance check**, not something CI runs. The headless coverage is `packages/reference-app-rn/test/node-claim.spec.ts` (what the user is told about a code and about each way a claim fails) and `packages/integration-tests/src/scenarios/cadre-host-join-by-qr.integration.ts` (a phone-shaped claimant against a real cadre-host node, over LAN addresses on the same machine). Neither scans a QR code, runs on a device, or dials across a Wi-Fi network; that is blocked ticket `rn-node-claim-by-qr-device-run`.

### On the PC

A test session needs a cadre-host data directory and a host running in the foreground, not an OS service. From a repo checkout:

```bash
yarn workspace @serfab/cadre-host build
node packages/cadre-host/dist/bin/host.js install --non-interactive --no-service --no-upnp --no-browser --data-dir <dir>
node packages/cadre-host/dist/bin/host.js start --data-dir <dir>          # prints "cadre-host local UI: http://127.0.0.1:<port>"
node packages/cadre-host/dist/bin/host.js join                            # add --port <port> if start bound anything but 8765
```

With cadre-host installed globally, replace `node packages/cadre-host/dist/bin/host.js` with `cadre-host`.

- `install --no-service` writes the identity key and `host.config.json` into `<dir>` and registers no OS service. It is needed once per data directory. Without `--no-service`, `install` registers and starts a service (systemd, launchd, or NSSM on Windows, where it fails if `nssm.exe` is not on the PATH).
- `--no-upnp` leaves the router alone, so the code carries the node's LAN addresses only: the same-Wi-Fi case this check covers.
- `start` runs the host until Ctrl+C. Run `join` from a second terminal.
- `join` starts a node, prints its QR code and the code's text, and waits for the claim. The local UI's Join page (the **Join a cadre** button) does the same and shows the code larger, which is easier to scan.

**The management port** is `uiPort` in `<dir>/host.config.json`: 8765 unless `install` was given `--ui-port`. `start` binds it, or the next free port up to `uiPort+9` if it is taken, and prints the port it bound. `join` talks to 8765 (or `$CADRE_HOST_PORT`) unless given `--port`. Only the PC talks to this port; the phone never does.

**If cadre-host is already installed as a service** (a plain `cadre-host install`), that service is the running host. Skip `install` and `start` and run only `join`. Running `start` on top of the service starts a second host on the same data directory, on the next free port.

### The PC's firewall

The phone dials the node on the PC's LAN address, so the phone must be on the **same Wi-Fi** as the PC and the PC's firewall must allow incoming connections to the node. On Windows, rules apply per network profile (Private or Public), and a home Wi-Fi can be classified Public. Windows prompts about `node.exe` only while no rule for it exists, so once any rule exists (including a Block rule left by an earlier prompt) nothing prompts again. The usual failure: the Wi-Fi is Public, `node.exe` has inbound Block rules (TCP and UDP, named "Node.js JavaScript Runtime") on Public and no Allow rule on any profile, no prompt appears, and the phone's dials time out.

- **How to check** (PowerShell): `Get-NetConnectionProfile` shows the network's `NetworkCategory`. `Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Format-Table DisplayName, Direction, Action, Profile, Enabled` lists the rules for this `node.exe` (`Get-NetFirewallRule -DisplayName "*Node*"` also finds rules for other programs with Node in the name).
- **Network or app?** `adb shell nc -w 3 <pc-lan-ip> <ws-port>` opens a plain TCP connection from the phone to the node; `<ws-port>` is the node's WebSocket port, which the node's page in the host's local UI (Nodes) lists under Ports as `ws`. A timeout means something between the phone and the node drops the connection, so a claim that fails to reach the node is the network's or the firewall's fault, not the app's.
- **Fix, either one** (administrator PowerShell): mark the network Private (`Set-NetConnectionProfile -InterfaceAlias <alias> -NetworkCategory Private`, with the alias from `Get-NetConnectionProfile`), which works only when an Allow rule for `node.exe` covers the Private profile, and there may be none; or add an inbound Allow rule on the profile the network uses, for `node.exe` or for the ports the host gives its nodes (10000–20000 by default), for example `New-NetFirewallRule -DisplayName "cadre-host nodes" -Direction Inbound -Protocol TCP -LocalPort 10000-20000 -Action Allow -Profile Public`. That rule opens those ports to every program on every Public network, so remove it after the session: `Remove-NetFirewallRule -DisplayName "cadre-host nodes"`.
- **A Block rule overrides an Allow rule.** An existing Block rule for `node.exe` on the network's profile has to be disabled or removed, whichever fix you choose: `Get-NetFirewallApplicationFilter -Program (Get-Command node).Source | Get-NetFirewallRule | Where-Object Action -eq Block | Disable-NetFirewallRule` disables every Block rule for this `node.exe`.

### The run

1. Connect the phone solo (Settings → Connect, no bootstrap address). The device must be an owner of the cadre it is connected to; a phone that founded its own party is one.
2. Settings → **Add an always-on node** → **Scan code**, and point the camera at the code. Or copy the code's text to the phone, paste it into the field and tap **Use code**. The first scan asks for camera permission.
3. The approval prompt names the cadre the node will join (the full Party ID, as the Node card shows it), the owner key that signs the claim by its name and fingerprint (the first 8 characters of the key, as [Owner Keys](#owner-keys) lists it), the node's peer id, and whether the node is reachable from anywhere or only on the machine's home network. Nothing is claimed until **Add to this cadre**.
4. The progress line reads "Reaching the node and adding it to this cadre…". After 20 seconds it adds that some addresses are not answering: each address the phone cannot reach costs up to 21.5 seconds before the next is tried, so a code none of whose addresses answer takes about two minutes to fail.

Expected result: the alert "Node added" with the node's peer id, and the host's page for the node reading "Claimed by owner `<fingerprint>` into cadre `<party>`", with the fingerprint and Party ID the prompt showed. The node then restarts itself once under the cadre, which drops the connection the claim used; the phone's next reconcile pass (within 15 seconds) connects again, and the host then reports the node connected. "Node added" means the node accepted the claim, not that a connection is open.

Relaunching the app reconnects to the same cadre by itself (see [Start options](#start-options-app-private-leveldb)), and the phone dials the node again from the addresses it kept ([Bootstrap dial targets](#bootstrap-dial-targets-app-private-leveldb)).

The section shows only while the node is connected. Switching tabs does not stop a claim. Disconnect during a claim stops the node and the claim fails; before the node accepted, nothing changed on either side, so scan again.

### What a failure says

Every failure opens the usual alert, with the underlying error under the title for bug reports. When the same code can succeed again, the section keeps it and offers **Try again** (no rescan and no second approval) and **Discard**. That matters once the node has accepted: the host stops showing the code within about 2 seconds of a claim.

| Alert | Cause | Same code again? |
|---|---|---|
| "…can only be reached on the machine's home network so far, and this phone could not reach it…" | No address answered, and the code holds LAN addresses only: the phone is on another network, or the firewall drops the dial | yes |
| "This phone could not reach the node at any of its addresses…" | No address answered, though the code has a public address: the machine is off or offline, the router does not forward the mapped port, or (on the same Wi-Fi) the firewall drops the dial | yes |
| "This node already belongs to another cadre…" | Someone else claimed the node first (`already-claimed`). Reset the node on the machine and scan the new code | no |
| "The node did not accept this code…" | The secret does not match (`claim-proof-invalid`): the node was reset after the code was shown | no |
| "The node is refusing claims for a while…" | Several wrong codes in a short time (`claim-rate-limited`) | yes, after a minute |
| "The node could not save its new owner…" | The node could not write its claim to disk (`claim-not-persisted`) | yes |
| "Adding the node did not finish…" | The node was reached and the exchange, or a step on the phone, failed. The node accepts a repeat claim from the same owner | yes |
| "Only an owner can add a node" | This device is a member of the cadre, not one of its owners, so nothing was sent | — |

A code that is not a node code, comes from a newer cadre-host, or is cut short is refused before the approval prompt, with a line saying which.

### Opening a code from the system camera (Android only)

The node code is a URI with the scheme `sereus-join`, and on Android the app registers that scheme (`app.json` → `expo.android.intentFilters`). Pointing the stock camera app or Google Lens at the code then offers to open it in this app; when several Sereus apps register the scheme, Android shows a chooser listing them. `app/+native-intent.tsx` rewrites the link to `/settings?nodeCode=…`, and the add-node section reads it like a pasted code and shows the approval prompt. A link never claims without that approval.

- **Before the node is connected:** the code waits. While auto-start is still connecting, the prompt opens once it connects; otherwise the Node card says a code is waiting and asks for Connect.
- **During a claim or with a prompt already open:** the new code is ignored, with a note in the section. One claim at a time.
- **The intent filter is native configuration:** a dev client built before it does not offer the app to the camera; rebuild it (§ When Native Rebuild Is Needed).
- **Join requests open the app too:** on Android the kit's config plugin (`appLinks` on `@serfab/cadre-rn` in `app.config.ts`) registers the `sereus-join-request` scheme, so a join request's QR code read by the camera opens the app chooser, and the request goes to Add a device or app ([Opened from another app on this phone](#adding-a-device-or-app)).
- **iOS is left out on purpose:** when two iOS apps register the same custom scheme, which one opens is undefined, so a code could open a Sereus app whose cadre the user did not mean. `sereus-join` is therefore not in `expo.scheme`, and iOS users scan inside the app.

### Not covered here

- Strands on the node. A cadre-host node launches no strand of its own; whether it should is ticket `always-on-nodes-host-strands-of-apps-they-do-not-run`.


## Renting a Provider Node

The third way to get an always-on node is to rent one from a hosting provider running `@serfab/cadre-provider` ([architecture.md → Renting a node from an app](architecture.md#renting-a-node-from-an-app)). **Settings → Rent an always-on node** (`src/provider-store-section.tsx`) shows one configured provider, its plans and terms, and **Subscribe and add node**; the user signs in and pays on the provider's own pages in the system browser, the app rents a container and adds it to the cadre, and afterwards the section shows the node's standing and the subscription's dates. Where a list of providers would come from, and whether paying on the provider's page is acceptable under the app stores' rules, is `tickets/blocked/decide-provider-directory.md`; until then one provider is configured per build. The section has not had a device run yet: blocked ticket `rn-device-run-rent-provider-node`.

**The configured provider.** `src/providers.ts` reads `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL`, the provider's descriptor URL (`http://192.168.1.20:3000/api/v1/descriptor` for a cadre-provider on the dev machine, as the phone reaches it), and `EXPO_PUBLIC_PROVIDER_CLIENT_ID`, the client id this app registered with it, `sereus-chat` by default for both installs. Unset, the section does not show. The redirect URI is `<own scheme>://provider-auth`, so `sereus-chat://provider-auth` for the main install and `sereus-chat-second://provider-auth` for the second; the provider compares it with the registered one by exact string equality, which is why it is built from the scheme rather than `Linking.createURL`. The descriptor is fetched when the section opens and parsed with cadre-core's `parseProviderDescriptor`; a fetch that fails (the dev machine is off) shows the error and **Retry**, and nothing else in Settings is affected. The plans come from the descriptor's `plansUrl` (name and price per hour).

**Sign-in.** The first Subscribe and add node, and any action after Sign out, opens the provider's authorize page in the system browser (`expo-web-browser`'s `openAuthSessionAsync`, through the kit's `signInWithProvider` in `@serfab/cadre-rn/provider`, which mints the PKCE pair and the state, reads the redirect and exchanges the code). The browser comes back to `<own scheme>://provider-auth?code=…&state=…`; the session that opened it takes that URL, and `app/+native-intent.tsx` rewrites the same link, which the OS also delivers to the app, to `/settings` with no query, so the single-use code never sits in navigation state. Closing the browser is a cancel: nothing is created and nothing is stored. The tokens go in the secure store ([Provider tokens](#provider-tokens-secure-enclave)); a token the provider refuses to refresh is dropped, the user signs in again, and the step they asked for runs once more, never in a loop. "Signed in to ‹name›. Sign out" under the section clears the tokens; the rentals stay, their rows read "Sign in to see its status", and **Sign in to ‹name›** is offered.

**The approval.** Only an owner can rent (the node is claimed or invited under this device's owner key); a member sees one line saying so. Subscribe and add node opens "Rent a node from ‹name›?", naming the cadre (the full Party ID), the owner key that signs the claim or the invitation (its name and fingerprint) and the provider, and nothing is created until **Subscribe and add node** in the prompt. The approval, then sign-in, then `useCadre`'s `rentProviderNode`, which is cadre-core's `rentNode` with the rental recorded ([Provider rentals](#provider-rentals-app-private-leveldb)) as soon as the provider creates the container and marked finished when `rentNode` returns.

**The two join paths**, chosen by cadre-core from `CadreNode.invitationReach()`:

- **Claim**, when this phone is the cadre's only member or its other machines are reachable only on their LAN: the provider creates the container, the phone polls for its node code (up to 120 s, since an image pull can precede the provider's 60 s enrolment window) and claims the node as it would a cadre-host node. The progress line reads "Asking ‹name› for a node…", "Waiting for the node to start…", then "Reaching the node and adding it to this cadre…", which after 20 seconds adds that some addresses are not answering. The alert is "Node added" with the peer id, and the node restarts once under the cadre.
- **Invitation**, once the cadre has a member with a relayed or public address, a first rented node included: the phone mints a single-use invitation, hands it to the provider with the create, and returns at once ("Node requested"); the container redeems it at a member by itself, and the row shows "Joining through a machine of this cadre" until it reads "Joined through ‹member›". A second rental from a phone whose first rented node is running therefore takes this path.

**The rows.** One per rental, re-read from the provider every 5 seconds while the Settings tab is in front and the app is in the foreground (`src/use-rental-poll.ts`: `getContainer` per rental, plus `getBillingStatus` once; Settings stays mounted behind the Chat tab and Android keeps timers running in the background, so the poll pauses there and reads again at once on return): the node's standing (Starting, Starting its node, Running, Running, not healthy, Stopping, Stopped, Failed), the join in words ("Waiting for this phone to claim it", "Joining through a machine of this cadre", "Joined", "Joined through ‹member›", "Could not join: ‹error›"), the peer id's short form, and under the list the subscription: "Renews ‹date›", "Unpaid, stops ‹date›" or "Subscription lapsed". What a row offers depends on its state (`src/rentals.ts`, pinned by `test/rentals.spec.ts`):

| State | Row | Buttons |
|---|---|---|
| A claim this phone did not finish (killed mid-flow, or the node code did not arrive in time) | "Waiting for this phone to claim it" | **Finish adding** (`finishRental`: the code, then the claim; a node already claimed into this cadre is reported done without a second claim) and **Cancel** (deletes the container at the provider, drops the record) |
| An invitation node whose join failed | "Could not join: ‹error›" | **Try again** (Cancel, then rent again, by whichever path fits now) and **Cancel** |
| Stopped for non-payment | "‹name› stopped this node for non-payment." | **Remove from cadre** (the Devices and nodes confirmation, then `removeMachine`, which works with the node unreachable; the record goes on success) while the node is still a member, and **Forget** (drops the record only) |
| Stopped from the provider's site, or a container the provider no longer knows | "This node was stopped from ‹name›'s site." / "‹name› no longer knows this node." | **Remove from cadre** while still a member, and **Forget** |
| Running and joined | its standing and join | nothing: a subscription ends on the provider's own site, which the card links to |

Cancel asks once ("Cancel this node?"), since the provider deletes the node and whatever it holds. Devices and nodes shows "Rented from ‹name›" on a machine whose peer id a rental names, and nothing else changes there.

**What a failure says.** Every failure opens the usual alert, with the underlying error under the title. A lapsed subscription or a plan at its node limit is the provider's `403 QUOTA_EXCEEDED`: "‹name› refused: the subscription has lapsed or the plan's node limit is reached." A node that did not start in time: "The node has not started yet … its row offers Finish adding." A node another cadre's owner claimed: "This node was claimed into another cadre. Cancel it and rent again." A refused sign-in names the provider's error code. Killed after the node accepted the claim but before `claimNode` wrote the row, Finish adding reports done without a row, because the provider withholds the code once the claim is folded (the accepted-tradeoff NOTE in `use-cadre.ts` about this window for cadre-host claims, and cadre-core's `judgeClaimed`); the remedy is Cancel and rent again.

**Dev setup.** Run cadre-provider on the dev machine with Docker available, `docker.publicHost` set to the address the phone reaches the machine at (the container's WebSocket address is built from it, and a claim dials it), `auth.mode: oauth` with `devConsentPage: true` and `allowInsecureNoAuth: true` (the built-in consent form, for development only), a `provider` block (`id`, `name`, `publicUrl: http://<dev machine>:3000`, which the descriptor's URLs are built from; plain `http` is accepted at a loopback host only, so put the provider behind `https` or use loopback with `adb reverse`), and one registered client:

```yaml
auth:
  mode: oauth
  allowInsecureNoAuth: true
  oauth:
    devConsentPage: true
    clients:
      - clientId: sereus-chat
        redirectUris: ["sereus-chat://provider-auth", "sereus-chat-second://provider-auth"]
        scopes: ["containers:*", "billing:read"]
```

Then start the dev client with `EXPO_PUBLIC_PROVIDER_DESCRIPTOR_URL=<publicUrl>/api/v1/descriptor`. On the consent page, type any customer id and pick a plan; the provider's `GET /billing/status` answers for that customer from the first code. To see the non-payment row, lapse the subscription on the provider's side ([cadre-provider README → Subscription state and termination for non-payment](../packages/cadre-provider/README.md#subscription-state-and-termination-for-non-payment)) and wait for the next poll.

The section shows only while the node is connected. Switching tabs does not stop a rental in flight (the tab navigator keeps Settings mounted); Disconnect stops the node, and a claim in flight fails, leaving the record for Finish adding.


## Adding a Device or App

**Settings → Add a device or app** is the owner's side of [architecture.md → Handing an invitation from app to app](architecture.md#handing-an-invitation-from-app-to-app): this app makes an invitation another Sereus app redeems to join this cadre. An invitation admits the app as a machine, never as an owner; an app that should be an owner is given an owner grant under [Owner Keys](#owner-keys) → Add an owner key, which its join field takes too. The section shows while the node is connected. A member that is not an owner sees one line saying only an owner can add a device or app; the check reads the cadre's owner keys when the section appears, after a join, and on Refresh.

**Paste request** (recommended). The other app's request (`sereus-join-request:1.…`) is pasted, or scanned with **Scan request**, then **Use request**. Before anything is made, the section refuses this app's own request and a request from a machine already in the cadre (a `CadrePeer` row). The approval prompt names the app (what it calls itself, unverified) and its peer id shortened to the first 12 and last 6 characters, for the user to compare with what the other app shows. **Add** makes an invitation for that peer id alone, valid for 24 hours.

**Copy invitation.** **Make invitation** makes an open invitation, valid for 24 hours: whichever app redeems it first joins, which is why the line above the button says to send it only to one's own app.

**The invitation** replaces the two inputs until **Done**: a QR code, **Copy**, the selectable text, the time it is valid until, and a line for its reach. This phone keeps no copy of the text; the cadre keeps the invitation's row. A text too long for a QR code shows "Too long for a QR code; use Copy instead."

| Reach | Line shown |
| --- | --- |
| `anywhere` | none |
| `local-network` | the new app must be on the same Wi-Fi as the cadre's other machines |
| `issuer-only` | (warning colour) no always-on machine can answer, so the new app can join only while this app is open and reachable; add an always-on node |

**Outstanding invitations** lists the open invitations that can still be redeemed, latest expiry first: expiry, and uses when it allows more than one. An invitation made for one app is listed under [Devices and Nodes](#devices-and-nodes) instead, as a device invited and not joined yet, so each invitation shows once. **Withdraw** asks once, then files the withdrawal (`withdrawCadreInvitation`), which reaches the cadre's other machines like any other control write. The list refreshes when the section appears, after an invitation is made or withdrawn, and on **Refresh**; it is not polled.

**When no invitation can be made.** `createCadreInvitation` needs an address a device could dial: this phone's relay address, or another machine of the cadre's. With neither, the alert "Could not make an invitation" carries the core error, and says this phone has no relay address when it holds no relay reservation. A joined app whose owner slot's key is not an owner of this cadre is shown the member line.

**Opened from another app on this phone.** Another Sereus app on this phone can open this one with its join request ([architecture.md → Between apps on one phone](architecture.md#between-apps-on-one-phone)). `app/+native-intent.tsx` routes the link to Settings, which holds the request until this section can take it. A request that carries a reply, saying where to send the answer, is answered by opening the asking app with a link (`src/join-link.ts`); the user copies nothing. The invitation admits the app as a machine only, here and under Recommend an app; whether a join answered by link between two apps on one phone should carry ownership is `tickets/blocked/decide-app-link-join-carries-ownership.md`.

- **The prompt** is titled "An app on this phone asks to join your cadre". It says what the app calls itself and that the name cannot be checked, shows the shortened peer id as **Code** to compare with the code the asking app showed, and says that allowing lets the app take part and does not make it an owner.
- **Allow** makes the invitation for that peer id (valid 24 hours) and opens the asking app with it. The section says "Sent an invitation to ‹app›", and the invitation is listed under Devices and nodes as invited, not joined yet. When no invitation can be made, the alert shows as for a pasted request and nothing is sent, since no refusal names that case; the asking app's Cancel covers it.
- **Deny**, or the system back button, opens the asking app with the refusal `denied`.
- **Answered without a prompt:** `no-cadre` while this app has no cadre (the first-launch question's condition), `not-owner` on a member that is not an owner, and `already-member` for a machine already in the cadre. When the cadre's owners and machines cannot be read, the alert shows as for a pasted request and nothing is sent; the asking app's Cancel covers it.
- **An app the user recommended here** within the past hour gets its invitation without a prompt, after the Deny cooldown and the not-owner and already-member checks ([Recommend an app](#recommend-an-app)).
- **Before the node is connected** the request waits, as a node code does. While auto-start or a join is connecting, the prompt opens once it connects; otherwise the Node card says a join request from ‹app› is waiting and asks for Connect. A newer request replaces a waiting one, which gets no answer.
- **After a Deny**, for 30 seconds, every request opened from another app with a reply is answered `denied` without a prompt. That bounds the prompts to one per 30 seconds after a denial, whatever peer ids a repeating app sends; a pasted request is never affected. The cooldown and a waiting request are screen state, lost if Settings is remounted; the asking app's Cancel and a new request recover.
- **One at a time:** a request arriving while a prompt is open or an invitation is being made is ignored with a note in the section, and gets no answer.
- **When the asking app cannot be opened** (uninstalled meanwhile, or the answer would be too long for a link), the invitation shows for copying as for a pasted request, under "Could not open ‹app›; copy this invitation into it". An unused invitation expires, or can be withdrawn.
- **A request without a reply** (a request QR code read by the Android system camera, or a plain link) is handled exactly as a pasted one: the usual prompt, and the invitation shows for copying.
- **This app's own request** coming back means the user picked this app in Android's chooser: Join my existing cadre cancels its open request and says so ([Joining an Existing Cadre](#joining-an-existing-cadre)).

Neither side has had a device run yet: `tickets/blocked/rn-device-run-join-existing-cadre.md` covers copy and paste, and `tickets/blocked/rn-device-run-same-phone-join-by-link.md` the links between two apps on one phone.

### Recommend an app

Below **Copy invitation**, the owner can recommend another Sereus app, so that it joins this cadre with nothing to copy and no second confirmation ([architecture.md → Recommending another app](architecture.md#recommending-another-app)). It is `src/recommend-app-section.tsx`, and has not had a device run yet.

**The list** shows the other Sereus apps this build knows: the kit's `KNOWN_SEREUS_APPS` and the app config's `extra.sereusApps`, one per scheme, this app left out, the same list Join my existing cadre offers on iOS. An app `canOpenURL` reports installed shows **Open ‹app›**; one with a store id for this platform (`androidPackage`, `iosAppStoreId`) shows **Get ‹app›**; one with neither is left out, and with none left the line reads "No other Sereus app to recommend". No entry in this repo has a store id yet, so in practice the list shows the [second install](#device-test-runs) when it is installed. The list is read when the section appears and on **Refresh**, and its buttons wait while an invitation is being made.

**The prompt**, "Let ‹app› join your cadre?", says that if the app asks to join within the next hour, this app lets it in without asking again. **Cancel**, or the system back button, saves nothing.

**Allow and get ‹app›** (or **Allow and open ‹app›**) saves the permission first, since the other app may ask before this one is in front again ([Recommended apps](#recommended-apps-app-private-leveldb)). It then opens the app's store page, which on Android names this app in the install referrer, or the installed app at `‹its scheme›://cadre-recommended-by/‹this app's scheme›`. Either way the other app offers to join through this one ([Joining an Existing Cadre](#joining-an-existing-cadre)).

- **When the link does not open** (no Play Store on an emulator, say, or the app uninstalled meanwhile), an alert says so and the permission stays, so the user can open the app themselves or withdraw it.
- **When the permission cannot be saved**, an alert says so and nothing opens.

**Allowed to join** lists the permissions not yet used for this cadre, newest first: the app's name and the time it lapses, an hour after Allow. **Withdraw** removes one without asking, since nothing has been issued. The list is hidden while empty; it is read when the section appears, after Allow and Withdraw, after a permission is used, and on **Refresh**, and is not polled, so a lapsed row stays until the next read.

**Answered without a prompt.** A request opened as a link whose reply scheme is an allowed app's scheme uses up that permission (`AppRecommendationStore.take`). This app makes the invitation for the request's peer id and opens the asking app with it. The section says "Sent an invitation to ‹app›, which you allowed when you recommended it", naming the app as this app's list does, never as the request calls itself, and the invitation is listed under Devices and nodes as invited, not joined yet. A pasted request never uses a permission.

- **Checked after the other answers.** The Deny cooldown comes first: a request within 30 seconds of a Deny is denied and leaves the permission for the next request. A request from an app already in the cadre is answered `already-member` and leaves the permission to lapse.
- **When no invitation can be made**, the usual alert shows and the permission is gone: recommend the app again. When the asking app cannot be opened, the invitation shows for copying.
- **When the permissions cannot be read**, the request gets the usual prompt rather than no answer.
- **An app answering to the allowed app's scheme** within the hour is admitted the same way, whichever app it is: the accepted tradeoff in architecture.md → Recommending another app. The notice and Devices and nodes show it, and Withdraw there retires the invitation.


## Devices and Nodes

**Settings → Devices and nodes** lists every machine of this cadre and lets an owner remove one: an uninstalled app, a lost or stolen phone, an always-on node whose machine died ([architecture.md → Removing a machine](architecture.md#removing-a-machine)). It is `src/machines-section.tsx`, shown below Add a device or app while the node is connected, and has not had a device run yet.

**The list** has one row per machine `CadreNode.listMachines` reports:

- **Title**: what the machine is, from the node profile it published: "App" (an app on a phone or in a browser), "Always-on node", or "Machine" until it has published one; "(this device)" on this phone's own row.
- **Facts**: "Last seen" from its last self-signed record (just now, or minutes, hours or days ago; "never" when this phone holds none it can verify); and "Key", the first 8 characters of its identity key, in the fingerprint form cadre-host uses. A running machine re-stamps its record every 7.5 minutes, so "Last seen 3 minutes ago" means it is running, and over about 15 minutes means it is stopped or cannot reach the cadre.
- **Not trusted here** (warning colour): its row no longer passes this phone's membership check, as for a device whose owner key was removed without keeping the device.

Owner keys are not machines and are not listed here; [Owner Keys](#owner-keys) lists them ([architecture.md → Owner Keys](architecture.md#owner-keys)).

Below the machines, each live invitation made for one app that has not joined is a row "Invited, not joined yet", with the app's shortened peer id and expiry, and **Withdraw** (asks once). Open invitations stay under Add a device or app.

The list is read when the section appears, when a join replaces the node, after each removal or withdrawal here, after Add a device or app makes or withdraws an invitation, and on **Refresh**; it is not polled. A read that finishes after the node was replaced is dropped.

**Who can remove.** On an owner device every row has **Remove** except this device's, under which a line says "A device does not remove itself from its cadre: to remove this device, use another owner device." A machine does not remove itself (`self`), because leaving a cadre stops the node and deletes its data; another machine removes it, and this app then learns of it and forgets the cadre ([When this app is removed](#when-this-app-is-removed)). A member sees the list with one line saying only an owner can remove machines, and no buttons.

**The confirmation.** Remove reads `planMachineRemoval` and opens "Remove this ‹app, always-on node or machine›?" with the machine's key and:

- **What happens**: it is removed from this cadre, and the invitations it could join again with are withdrawn, counted. Owner keys stay, including one the machine held.
- **A lost or stolen phone**: "If this was a lost or stolen phone that held an owner key, remove that key too in Owner keys; otherwise whoever has the phone can still act as an owner.", with **Go to Owner keys**, which closes the prompt and scrolls Settings to [Owner Keys](#owner-keys). Rent an always-on node's removal of a node its provider stopped shows neither, since a rented node never holds an owner key.
- **What removal does not do**: the machine keeps whatever it already copied, including the cadre's shared data, and removing it stops it syncing with this cadre's machines. It also keeps the strands' member keys (`tickets/blocked/decide-removed-machine-strand-access.md`), which is why the prompt says "this cadre's machines" and not more.

**Remove** runs `removeMachine` and the list refreshes; **Cancel**, or the system back button, does nothing. A machine another owner removed meanwhile shows "Already removed", whether the plan or the removal finds it gone, and the list refreshes. Any other failure shows its error in an alert.

**Uses.**

- **An uninstalled app, or a lost or stolen phone**: remove it from another owner device. Its push token goes with it, so the cadre stops waking it. A lost phone's owner key is removed separately, under [Owner Keys](#owner-keys).
- **A dead always-on node, or a replaced host**: remove the old node here, then add the new one with [Add an always-on node](#adding-a-home-machines-node-cadre-host) (the QR claim). [cadre-host.md → Remove, reset and a lost host](cadre-host.md#remove-reset-and-a-lost-host) links here.
- **Leaving the cadre from an owner device**: another owner device removes it.

### When this app is removed

When an owner removes this app from its cadre while the app runs, the kit stops the node and deletes that cadre's data from this phone ([cadre-rn README → Removed from the cadre](../packages/cadre-rn/README.md#removed-from-the-cadre)). `use-cadre.ts` follows the kit's `removed` status, and the Node card reads "This device was removed from cadre ‹party id› by an owner (‹its key's fingerprint›). Its copy of that cadre has been deleted from this phone.", with:

- **Go back to your own cadre**, when this app founded a cadre of its own before it joined: starts it from the start the kit saved, which has auto-start off until then.
- **Join a cadre**: shows Join my existing cadre below.
- **OK**: clears the card, leaving the Connect form filled from that saved start, or the first-launch question when this app has no cadre of its own.

The status reads idle, not an error. Connected sections, a prompt open in them, and a join step on screen go with the node. As soon as the node reports the removal, before the kit has finished deleting, the hook drops the options the lifecycle runner cold-starts from, so a return to the foreground never builds the removed cadre again on empty storage.

It is best-effort, as the report is: a phone removed while the app was not running is not told, and keeps that cadre's data while the cadre's machines refuse it.

The card is screen state, since the kit keeps no record of the removal: after a restart the app shows the Connect form filled from the saved start, or the first-launch question, without saying why.


## Owner Keys

**Settings → Owner keys** lists this cadre's owner keys, makes owner grants (an owner grant is a code that makes the device or app that uses it an owner of this cadre) for another device or app and as a backup, lists and withdraws the grants outstanding, redeems a grant, exports this device's key, imports a key from another device, and removes a key ([architecture.md → Owner Keys](architecture.md#owner-keys), [Owner grants](architecture.md#owner-grants)). It is `src/owner-keys-section.tsx`, with the grant parts in `src/owner-grant-views.tsx` and its words in `src/owner-keys.ts`, shown below Devices and nodes while the node is connected, and has not had a device run yet.

**The list** has one row per live owner key `listOwnerKeys` reports:

- **Title**: the name the key was added under ("phone" for the key this app made when it founded the cadre), or "Unnamed key".
- **Facts**: the key's fingerprint, its first 8 characters as the approval prompts and cadre-host show it; and "This device" on the key this phone signs with.
- **Not trusted here** (warning colour): the key is not in this phone's trusted-owner anchor, so this phone does not accept what it signs.

The list is read when the section appears, when a join replaces the node, after each redemption, import or removal here, and on **Refresh**; it is not polled. A read that finishes after the node was replaced is dropped. A member sees the list, one line saying only an owner can add or remove owner keys, Redeem and Import, since redeeming a grant and importing a key are how a member becomes an owner.

### Adding an owner key, and making a backup

**Add an owner key** and **Make a backup** (owner only) each make an owner grant, signed by this phone's owner key (`createOwnerGrant`). Each opens a form with a **Name**, the name the owner key the grant adds is listed under (at most 64 characters), then shows the grant once, in place of the section's controls until **Done**: a warning, a line under it, the QR code, **Copy**, **Share** (the system share sheet) and the selectable text.

| | Add an owner key | Make a backup |
| --- | --- | --- |
| For | another device or another app of the user's | printing or saving, so a new device can become an owner if this one is lost |
| Name | blank by default: an unnamed key | "Backup" |
| Valid | 15 minutes, once | no expiry, once |
| Warning (warning colour) | "Whoever uses this first becomes an owner of this cadre. Show or send it only to your own device or app." | "Whoever holds this can become an owner of this cadre until it is used or withdrawn. Keep it like a key: somewhere safe and offline. This phone does not keep a copy." |
| Under it | the time it is valid until, and where the other device takes it: Owner keys → Redeem an owner grant, or Join my existing cadre in an app not part of this cadre yet | it works only while one of this cadre's machines can be reached at an address it carries; a copy that works with no network is Export this device's key |

A reach line follows, as for an invitation ([Adding a Device or App](#adding-a-device-or-app)): for `local-network`, the device that uses it must be on the same Wi-Fi as the cadre's other machines; for `issuer-only` (warning colour), only this phone can answer it, and a backup then cannot stand in for this phone if it is lost, so add an always-on node and make a new backup.

This phone keeps no copy of a grant's text; the cadre keeps its row. A grant on screen when the node stops is gone with the screen, and stays outstanding until it expires or is withdrawn below.

**Outstanding owner grants** (owner only) lists each live grant this phone holds, made here or on another owner device, backups first: its name ("Unnamed backup" or "Unnamed grant" without one), when it expires ("Never expires" for a backup) and the uses left. **Withdraw** asks once ("Nobody can become an owner with it afterwards. Owner keys it already added stay owners"), then files the withdrawal (`withdrawOwnerGrant`), which reaches the cadre's other machines like any other control write. A withdrawn, expired or used grant drops off the list. It is read with the keys, after a grant is made or withdrawn here, and on Refresh.

### Redeeming an owner grant

**Redeem an owner grant** (any device of the cadre) takes a grant's text, pasted or read with **Scan owner grant**; a scanned grant is redeemed at once. **Redeem** runs the kit's `redeemOwnerGrant`: this phone's owner slot's key ([Owner key](#owner-key-secure-enclave)), made now when the slot is empty, becomes an owner of this cadre, and the phone signs with it from then on. A slot that already holds a key, as on a phone that founded its own cadre before it joined this one, makes that key an owner of this cadre too, and nothing is created.

| Outcome | Alert |
| --- | --- |
| Became an owner | "Now an owner", naming the key as the list does |
| Already an owner | "Already an owner": the grant was not used and still works for another device until it expires or is withdrawn. Answered before anything is signed, connected or not |
| Accepted at another machine, the key's record not here yet | "Owner grant accepted": the device acts as an owner once the cadre's records reach it, at the latest from its next start |
| Expired, withdrawn or used up, or its maker removed (`grant-spent`) | "This owner grant is expired, withdrawn or used up, or the owner key that made it was removed." |
| For another cadre (`party-mismatch`) | "This owner grant is for another cadre." No key is made |
| No connection to the cadre's other machines (`alone`), or none of those the grant names reachable | Says to connect and try again |
| The maker's key unknown here, or a machine's answer that does not verify | Says which, and to try again shortly for the first |

The field and the scanner refuse an owner key, an invitation and a join request by name, with the grant decoder's message; Import and the join field refuse a grant pasted in the wrong place with their decoders' message.

### Exporting this device's key

**Export this device's key**, on an owner device, opens a form: a name (default this key's, at most 64 characters) and **Protect with a passphrase**, on by default, with two passphrase fields; the button stays disabled while the passphrase is empty or the two differ. It then shows the export (`exportOwnerKey`), titled with the key the export holds: the owner slot's, which `exportOwnerKey` names and which is the key this device signs with, by its listed name, or by its fingerprint when this cadre does not list it. A device whose slot is empty holds no key of its own, and the alert says so. The export is the copy that works with no network: importing it needs no machine of the cadre, where a backup grant needs one to answer.

**The export** replaces the section's controls until **Done**: "Anyone who has this can control your cadre. Keep it somewhere safe and offline. This phone does not keep a copy.", then the QR code, **Copy**, **Share** (the system share sheet) and the selectable text. Done clears it, and it is not shown again.

**Screen capture is a known exposure.** The export and a shown grant are not hidden from screenshots, screen recording or the app switcher's snapshot. Android's `FLAG_SECURE` and iOS's app-switcher cover come from `expo-screen-capture`, a native module this app does not include (`tickets/backlog/feat-rn-owner-key-export-hidden-from-screen-capture.md`).

### Importing an owner key

**Import an owner key** takes the export's text, pasted or read with **Scan**; a locked export (`sereus-owner-key-locked:1.…`) shows a passphrase field. **Import** runs `importOwnerKey`, which stores the key in this phone's owner slot ([Owner key](#owner-key-secure-enclave)) and, when the cadre lists it, signs with it from then on.

| Outcome | Alert |
|---|---|
| The key is an owner of this cadre | "This device is now an owner of this cadre, with ‹name› (‹fingerprint›)." |
| The key is an owner, but this device already signs with another key (the kit's contract; this app's node signs only with its slot's key, so the case does not arise here) | The key is kept and used from the next start. |
| The key is not an owner of this cadre | "This key is not an owner of this cadre. An owner can add it." The key stays in this phone's owner slot. |
| This phone already holds a different owner key | Refused: a phone holds one owner key. |
| The passphrase does not open it | Refused, with the decoder's message. |

The field and the scanner refuse an invitation, an owner grant, a join request and a node code by name, with the owner-key decoder's message. The other way round, Join my existing cadre, Add a device or app and Redeem an owner grant refuse a pasted owner key with their decoders' message, and the first two a scanned one with "That is an owner key, which is private. Import it only under Owner keys."

### Removing an owner key

On an owner device every row has **Remove** except this device's own key, under which a line says "A device cannot remove its own owner key; use another owner key." Remove reads `planOwnerKeyRemoval` and opens "Remove owner key ‹name› (‹fingerprint›)?":

- **Owner grants it made**: the live grants the key made (the plan's `grants`) are listed, since redeeming one needs its maker to be an owner: `Backup "‹name›" stops working.` for a backup, `The owner grant "‹name›" stops working.` for another, with a line to make new ones with another owner key if they are still needed.
- **Keep switches**: one per device or owner key the removed key added (the plan's `dependents`), on by default. A device is named as Devices and nodes names it, an owner key by its name and fingerprint. A kept row is re-vouched with this phone's key before the removal; a device switched off stops counting as a member of the cadre, and a key switched off keeps its place only on machines that already trust it.
- **This device's own key**, when the removed key added it (`ownDependency`): a line says it stays an owner on the machines that already trust it, and that another owner key can vouch for it again later. This device's own machine row, when the removed key added it, is re-vouched without asking (`revouchesOwnRow`).
- **Refusals**: "It cannot be removed: it is the only owner key of this cadre." (`last-owner`), and the own-key line for `self`, with only **Close**.

**Remove** runs `removeOwner(key, { revouch })` with the kept rows, and this list and Devices and nodes refresh; **Cancel**, or the system back button, does nothing. A key another owner removed meanwhile shows "Already removed". Keeping an owner key while alone is refused (`alone`): "Connect to your cadre first; the owner keys you keep would not reach your other machines." Any other failure shows its error in an alert.

**Uses.**

- **A lost or stolen phone that held an owner key**: remove its machine under Devices and nodes, then its key here. The machine removal prompt says so and scrolls here.
- **A backup to keep offline**: Make a backup, print or save the QR code or the text, then Done. It is listed under Outstanding owner grants, where Withdraw retires it if the paper is lost; make a new one then.
- **Another device or app as an owner**: Add an owner key here, then Redeem an owner grant on that device, or Join my existing cadre in an app not part of this cadre yet.
- **A new phone after losing the old one**: Join my existing cadre with the backup, which makes it a machine and an owner of the cadre at once.


## Joining an Existing Cadre

**Settings → Join my existing cadre** is the joining side of [architecture.md → Handing an invitation from app to app](architecture.md#handing-an-invitation-from-app-to-app): an app that started a cadre of its own joins the cadre another Sereus app holds, moves its chats into it and removes its own cadre from this phone ([architecture.md → An app joins an existing cadre](architecture.md#an-app-joins-an-existing-cadre)). The section shows while the node is connected, whenever a join's steps are on screen, whatever the status, and on a first launch after **Yes, join my cadre** or **Join through ‹app›**.

**First launch.** While the app has no cadre, the Node card asks "Do you already use Sereus apps?" in place of the Connect form, so the app never founds a cadre it would then have to leave. It asks when the launch read of the saved start (`savedStartRead` in `use-cadre.ts`) found none, no node is running or starting (status `idle`, or `error` after a start that failed) and no join is on screen. **Yes, join my cadre** shows the join section with no node running (nothing moves and nothing is removed), and **Back** returns to the question; **No, start fresh** shows the Connect form. The answer is screen state: until a start is saved (by Connect or by a join), the question comes back at the next launch. A launch read that failed does not ask; its error line explains, and the Connect form is the recovery. When another Sereus app recommended this one, the question names that app (next paragraph).

**The app that recommended this one.** An owner app's [Recommend an app](#recommend-an-app) leaves a hint naming itself, and this app offers to join through it, so the user taps once here and is not asked again there ([architecture.md → Recommending another app](architecture.md#recommending-another-app)). `src/recommended-by.ts` reads the hints, and `src/use-recommending-app.ts` decides what Settings shows.

- **Two hints.** On Android, the install referrer of an install from that app's Play link (`expo-application`'s `getInstallReferrerAsync`), read once per screen mount and only while the first-launch question would show. On both platforms, the link `‹this app's scheme›://cadre-recommended-by/‹its scheme›`, which that app opens when this one is installed, and which `app/+native-intent.tsx` routes to Settings (`recommendedBy`). When both name an app, the link's wins, as the user's latest action.
- **Trusted only when this build knows the app.** Anyone can build a Play link with any referrer, and any app can open this one with any link. A scheme counts only when it is exactly one of the other Sereus apps this build lists (the kit's `KNOWN_SEREUS_APPS` and `extra.sereusApps`, this app left out), and the app is named from that list. Any other scheme, this app's own, and a referrer of `utm` text are logged and read as none.
- **The named question.** On a first launch the Node card asks "‹app› suggested this app. Join the cadre it holds?". **Join through ‹app›** opens that app with this app's request, as **Choose the app that holds your cadre** does, and shows the join section with its waiting line; on Android, an app that does not open by its scheme is looked for in the app chooser. **Other choices** shows the plain question until another link names an app.
- **At most 2 seconds.** The question waits that long for the install referrer, then shows its plain form. A referrer read later is dropped, so the question never changes once it is on screen. A failed read, as for an install not from Play (a development build, say), reads as none.
- **iOS has no install referrer.** An iOS install from the App Store shows the plain question. **Yes, join my cadre → Choose → ‹app›** is still answered without a prompt, since that app finds the user's permission when the request arrives.
- **When this app already has a cadre**, the link waits until the launch read and any start have settled, then opens a prompt: "‹app› suggests joining the cadre it holds", with **Join through ‹app›** and **Not now** (or the system back button). The join runs as any other: chats move, and the old cadre is removed. A link that arrives while a request to join is open or a join is on screen is dropped with a log line, since the one on screen wins.
- **One tap, not automatic.** The hint is unverified, and opening another app at launch with no tap would switch apps on the user unasked.
- **When the other app does not let this one in at once** (its permission lapsed after the hour, was withdrawn or was used), it shows its ordinary Allow / Deny prompt. Nothing differs here.

**Choose the app that holds your cadre** (recommended on one phone). The button at the top of the section opens the owner app on this phone with this app's request, and the owner app opens this one back with its answer, so the user confirms once there and copies nothing ([architecture.md → Between apps on one phone](architecture.md#between-apps-on-one-phone)). The hook's `askOwnerApp` (`use-link-request.ts`) saves the open request first ([Open link request](#open-link-request-app-private-leveldb)), then opens the other app with a request carrying `reply`: this build's own scheme and the request's nonce.

- **Android** opens the request text itself, and Android's app chooser lists every installed app that answers join requests, this one included. Once the user ticks **Always** for one app, later requests go to it with no chooser; the default is cleared under that app's "Open by default" in Android's app settings.
- **iOS** lists the Sereus apps `canOpenURL` reports installed, this app left out: the kit's `KNOWN_SEREUS_APPS` and this build's `extra.sereusApps` ([A second install for one phone](#device-test-runs)). With none, the list says no other Sereus app is installed and to copy this app's request instead.
- **Waiting.** While the request is open the section says "Waiting for ‹app› to answer…" ("…for the app you chose…" on Android) with **Cancel**, and the paste field stays below. A relaunch reads the open request and shows the same line, which covers coming back by the app switcher. When the other app cannot be opened, the request is cancelled and an alert says so, with the copy-and-paste way in.
- **The answer** is a link `app/+native-intent.tsx` routes to Settings (`joinResponse`), which takes it once no launch read or start is running, whether or not this section is on screen, and shows the alerts itself (`joinResponseAlert` in `join-link.ts`). An invitation runs the join exactly as a pasted response does, so the steps and failures below apply. A refusal shows "Not joined" with the reason: the other app did not allow it (`denied`), has no cadre yet (`no-cadre`), is a member and not an owner (`not-owner`), or already holds this app (`already-member`); all but the last add that this app's request can still be copied into it.
- **Answers not taken.** The request takes one answer within 30 minutes. One that arrives when none is open (after Cancel, expiry, or an earlier answer) or that answers another request is refused with "This answer was not for a request this app has open"; one that does not decode, or a saved request that cannot be read, with "This app could not take this answer" and the error. While a join is on screen the answer is not used ("A join is already under way") and the request stays open. An invitation the owner app made for a request cancelled here stays outstanding there until it expires or is withdrawn; it is targeted at this app, so nobody else can use it.
- **Killed meanwhile.** The open request is saved, so an app the OS killed while the owner app's prompt was open starts from the answer link and joins. On a phone with a saved start, the join waits for the launch's start to finish; on a first launch it starts with nothing running, and the join section shows while it runs.
- **This app's own request.** Picked in Android's chooser, or the only app there, this app receives its own request. It cancels the open request and says "That opened this app again. Choose the app that holds your cadre, or copy this app's request into it." until the next **Choose**.

**Request and response** (from another device, and the fallback on one phone). The section shows this app's join request (`sereus-join-request:1.…`) as a QR code, **Copy** and text, and under it the peer id shortened as **Code**, which the other app's approval prompt shows for the user to compare. The request carries the app's peer id (`identityPeerId()`, readable with no node running) and the app config's `name`. The other app pastes or scans it under **Add a device or app → Paste request** and makes an invitation for this app alone; that response is pasted, or scanned with **Scan**, into **Paste response or invitation**, then **Join**. A response made for another app's request is refused before anything stops.

**Open invitation.** An invitation from the other app's **Copy invitation** goes into the same field: both are `sereus-invite:1.` text.

**Owner grant.** A grant from the other app's **Owner keys → Add an owner key** goes into the same field too (`sereus-owner-grant:1.`, told apart by its prefix; the scanner takes either). It joins the app as a machine and an owner at once, with its owner slot's key, made then when the slot is empty ([kit README → Joining another cadre](../packages/cadre-rn/README.md#joining-another-cadre)): an app with chats of its own needs that to bring them along, and a line above the field says so ("To make this app an owner of your cadre too…" on a first launch). A grant names no app, so nothing is checked against this app's request.

**The steps.** From Join on, one line and its buttons replace the inputs. The app-wide hook holds the flow (`use-join-flow.ts`, part of `use-cadre.ts`), so it survives a tab switch; the words are `join-flow.ts`'s.

| Step | Line | Buttons |
| --- | --- | --- |
| joining | "Joining your cadre…" ("…, and setting this app up as an owner…" with an owner grant); while no member is ready, waiting for an always-on machine (or for the cadre to catch up) and the next try's time | Cancel |
| admitted | admitted as an owner, or as a member | none |
| moving | moving this app's chats into the cadre | none |
| removing | removing this app's old cadre from this phone | none |
| done | part of the cadre, as an owner or a member, and how many chats moved | OK |

Nothing is cancellable once a member admitted the app, since the kit never rolls an admitted join back. While the node stops and starts again (the join, and the removal) the Node card shows "Switching cadre…" ("Joining your cadre…" on a first launch) in place of the Connect form, the connected sections hide, and the hook holds no node, so nothing writes through a stopped one.

**What each failure leaves.**

- **Before admission** (refused, expired, no member reachable, or **Cancel**): the kit puts the app back in its own cadre unchanged, or leaves it stopped if it was stopped, and an alert says why (`join-failure.ts`; an owner grant's refusals in the words Redeem an owner grant uses, from `owner-keys.ts`).
- **A machine invitation while the app's own cadre holds chats** is refused before anything stops: every row the move seats is owner-signed, so the alert says to make an owner grant in the app that holds the cadre, under Owner keys → Add an owner key, and paste it here.
- **The move did not finish** (this app's key is not an owner of the joined cadre yet, or an adoption failed): the line counts the chats moved and those waiting. **Retry moving** tries again (`finishStrandMove`); **Later** leaves it, and every start retries by itself. The old cadre is not removed while chats wait.
- **The old cadre holds what the joined one does not** (a moved chat since left in the joined cadre, a dismissed join): the section asks whether to **Delete them** with the old cadre or **Keep old cadre**.
- **The old cadre has other machines**: it is kept on this phone, and the line says nothing was lost. Removing those machines is done in that cadre.
- **The removal failed**: the line says the old cadre is still on this phone, with the error; **Remove it now** tries again.

**After a relaunch.** A start (at launch or on Connect) in a party whose saved start still names the old cadre (`formerPartyId`) shows the step the app stopped at: chats still waiting, else the old cadre still on this phone, with **Remove it now** and **Later**. That covers a kill between the steps and a **Later**. An old cadre kept on purpose is still named, so it shows again at each start.

**An app that never connected.** `joinCadre` (`cadre-phone.ts`) passes the build's relay (`EXPO_PUBLIC_RELAY_ADDR`) when the kit has neither a running nor a saved start to take relays from; the Noise mode falls back to the kit's platform default, which is Connect's default too.


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

**A second install for one phone.** Joining by link ([Joining an Existing Cadre](#joining-an-existing-cadre), "Choose the app that holds your cadre") needs two Sereus apps on one device. `APP_VARIANT=second` builds this app as a separate one (`app.config.ts`): name "Sereus P2P Chat (second)", scheme `sereus-chat-second`, package and bundle id ending in `.second`, so it has its own identity, storage and links. `app.config.ts` keeps the one list of such extra apps and gives it to the kit plugin (`appLinks.extraApps`, the iOS schemes it may query) and to the app (`extra.sereusApps`, read by `extraSereusApps` in `cadre-phone.ts`; a malformed list reads as none, logged). Build it with `eas build --profile development-second`, or locally as the [README](../packages/reference-app-rn/README.md#a-second-install-on-one-phone) shows. A development build takes its name, scheme and `extra` from the dev server's manifest rather than from the build (expo-constants prefers the dev launcher's manifest), so the second install needs its own dev server started with the same variable, on another port: served by the main app's, it would name the main app's scheme in its request, and its answer would go to the main app, which refuses it.

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

Only when `rn-leveldb` or another native dependency is added or changes version. Adding `react-native-quick-crypto`, `react-native-nitro-modules` and `react-native-quick-base64` (native Noise crypto) is such a change: a dev client built before them throws nitro's `ModuleNotFoundError` when the bundle first evaluates quick-crypto, which the app imports from its root (read from nitro's source, not yet seen on a device). Adding `expo-camera` (the node-code scanner) is another: a dev client built before it throws "Cannot find native module 'ExpoCamera'" when Settings loads, because Settings imports the scanner. So are `expo-clipboard` and `react-native-svg` (an invitation's Copy button and QR code): a dev client built before them fails when Settings loads, because Settings imports the section that shows invitations. A change to the native configuration in `app.json` or `app.config.ts`, such as the Android intent filter for `sereus-join` codes or the kit plugin's `appLinks` option (the `sereus-join-request` scheme on Android, the other Sereus apps' schemes Android and iOS may query, the second install among them), is one too: it takes effect only in a dev client built after it. On Android, a dev client built before the plugin declared the other apps' schemes under `<queries>` sees none of them installed, so Recommend an app offers no **Open ‹app›**. `expo-application` (the install referrer) is native but needs no rebuild: Expo's autolinking already found the same version (6.1.5) as a dependency of `expo-notifications` before the app listed it (`npx expo-modules-autolinking search`), so a dev client built with `expo-notifications` already links it. That has not been confirmed on a device. Otherwise, JS-only iteration via the dev client.

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

**Create Closed Strand + Invite** succeeds once the strand is published and the invitation made, because `createClosedChatStrand` founds with `foundStrand`'s background form. The strand keeps starting after the handler's `succeeded` line, so the start's timing lines, ending with `[foundStrand:<id>] addStrand: <n>ms`, can follow it, while `[foundStrand:<id>] total` covers only the publish. A start that fails logs `W ReactNativeJS: [chat-strand] closed strand <id> did not start; no owner role was written:` with the error, and the node retries the start.

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
3. Reads `test-fixture/test-data.json` for `strandId` and `cadreInvitation`
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
| `flows/1-connect-and-send.yaml` | Cold launch → join on first launch → create strand → send message → local echo |
| `flows/2-drone-to-phone.yaml` | Drone-side HTTP insert appears in phone chat within 5s |
| `flows/3-round-trip.yaml` | Bidirectional: phone send seen by drone; drone send seen by phone; both visible |
| `flows/4-solo-create-strand.yaml` | No drone: connect alone (empty party id and bootstrap) → create strand → result modal with its elapsed time |

Flows 1–3 share `_setup.yaml` for the join/strand bootstrap. Flow 4 does not use it: it answers the first-launch question with **No, start fresh** (a conditional tap, since the NativeScript app that reuses the flow has no question) and connects alone. The orchestrator still runs it with the rest of the directory, and it can be run by itself with `maestro test -e MAESTRO_APP_ID=… maestro/flows/4-solo-create-strand.yaml`.

The phone joins the drone's cadre the way a fresh install of a user who already has a cadre would: `_setup.yaml` answers the first-launch question with **Yes, join my cadre**, pastes what the orchestrator passes as `JOIN_CODE` and taps **Join**, so the app never founds a cadre of its own and nothing moves or is removed. The fixture enrolls its own owner key (`ensureOwnerKey`) and mints an owner grant valid for an hour (`createOwnerGrant`) whose member address is the drone's ws listener; `start.mjs` writes it as `ownerGrant`, and this orchestrator passes it as `JOIN_CODE`. Redeeming it pins the drone's owner key, makes the phone's own key an owner and admits the phone at the drone as a machine, after which the control database syncs under a trusted anchor and the flow can create a strand, which only an owner can. The fixture also writes a machine invitation (`cadreInvitation`), which reference-app-ns's orchestrator passes as `JOIN_CODE` instead, since that app's join field takes no owner grant yet. The owner-grant join has not had a Maestro run yet.

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

