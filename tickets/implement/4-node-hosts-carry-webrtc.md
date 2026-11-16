description: The command-line node program can't make direct WebRTC connections, so a home machine that can only be reached through a relay server stays on that relay for every phone and browser that talks to it. Add an opt-in setting that gives it WebRTC whenever it has a relay.
prereq: webrtc-addresses-never-hold-a-dial
architecture: docs/architecture.md#relay-integration
files: packages/cadre-core/src/node-default-transports.ts, packages/cadre-core/src/relay-addrs.ts (`ListenTransportOptions` ~139, `resolveTransportOptions` ~232, `listenTransportKind`, `UnbindableListenAddressError`), packages/cadre-core/src/node-transports.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/types.ts (`NetworkConfig.defaultTransports` ~437), packages/cadre-core/package.json, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-cli/src/commands/start-node.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/docker/Dockerfile, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, docs/architecture.md (config block ~2345)
difficulty: medium
----
# Node hosts carry WebRTC, opt-in: `network.webrtc`

Decided by the project owner (2026-11-16): add the opt-in setting, and let this ticket work out the native-module question.

## Why

Node hosts build their transports from `nodeDefaultTransports`: TCP, WebSocket when a `/ws` entry asks for it, and relay. There is no WebRTC.

A host with a public or forwarded address doesn't need it. A home machine behind carrier-grade NAT, once it holds a relay reservation, relays every byte to every phone and browser for good. With WebRTC, `relayed-connections-try-a-webrtc-upgrade` can move those connections to a direct path wherever ICE connects.

## Design

**Follow the existing `/ws` pattern: a listen entry turns on its transport.**

- **Recognise `/webrtc` as a listen kind.** `listenTransportKind` gets a `webrtc` kind for the bare `/webrtc` entry.
  - `resolveTransportOptions` accepts it only when `network.defaultTransports` is set. Only the Node-only default list can supply the factory; cadre-core's main graph must not import `@libp2p/webrtc`'s Node build.
  - Without `defaultTransports` it stays an `UnbindableListenAddressError`, as today.
  - When accepted, `ListenTransportOptions` carries a WebRTC field. Its value is the ICE servers, `resolveStunServers(network.relayAddrs, network.stunUrls)`, so the transport factory gets everything it needs from one place.
- **The default list adds the transport.** `nodeDefaultTransports` adds `webRTC({ rtcConfiguration: { iceServers } })` when that field is present.
- **Strand nodes** go through `strandNodeAddrs` → `resolveTransportOptions` and so pick up the same switch. Check that the `/webrtc` entry survives `ephemeralPortListenAddr`: it has no port, so it should pass through unchanged.
- **A new `NetworkConfig.stunUrls?: string`** (comma-separated `stun:` URLs) replaces the per-relay derivation, the same override the apps take from `VITE_STUN_URLS` / `EXPO_PUBLIC_STUN_URLS`. It is needed for a relay whose STUN server isn't on 3478.

**The cadre-cli setting.**

- `network.webrtc?: boolean` (env `CADRE_WEBRTC`) and `network.stunUrls?: string` (env `CADRE_STUN_URLS`), both added to the schema in `config/schema.ts`.
- When `webrtc` is true and `relayAddrs` is non-empty, `start-node.ts` and `node-session.ts` append `/webrtc` to the listen addresses they pass.
- When `webrtc` is true with no relay, log once at start that WebRTC needs a relay for signalling and is inactive, and change nothing else.
- Don't accept a hand-written `/webrtc` in `listenAddrs` from the config file as a second way to say the same thing. The flag is the one surface. Validation should reject it with a message pointing at `network.webrtc`.

**Dependency.**

- `@libp2p/webrtc` (exact `6.0.33`, the version cadre-core's devDependency and both apps pin) moves from cadre-core's devDependencies to dependencies.
- It pulls in `node-datachannel`. Apps that use cadre-core and WebRTC already install it, and only the `node-default-transports` subpath imports it.

**Who turns it on.**

- cadre-host turning it on for children it points at a relay is an arm of `feat-cadre-host-children-reserve-on-a-relay` (backlog).
- cadre-provider leaves it off, because its containers are published on the Docker host and directly dialable.

## Native-module exploration (part of this ticket)

`node-datachannel` (0.33.4 here; only a `win32-x64-msvc` build is present in this checkout) ships prebuilt binaries per platform. Establish and record, in the handoff and in the cadre-cli README:

- Whether a prebuilt binary installs and loads on the `node:22-alpine` (musl) images in `packages/cadre-cli/docker/Dockerfile` (deps and prod stages), and on linux-x64/arm64 glibc and macOS for a bare `npx`-style install.
- **If Alpine has no binary**, pick the cheapest of these and record what was measured: a Debian-slim base for the cadre-cli image; a build toolchain in the deps stage only; or keeping the module out of the image and failing `network.webrtc` at start with an error that names the missing module.
- **What happens when the module can't load** (no binary for the platform): a clear start-up error naming `node-datachannel` and the platform when `network.webrtc` is true, and no effect at all when it is false. The import has to be dynamic, or otherwise kept off the load path when the flag is off. That is the one place a non-static import is justified here: loading on demand. Say so in a comment.

## Edge cases & interactions

- **`webrtc: true` without relays**: logged, no `/webrtc` entry, transports unchanged. Verify by inspection.
- **A programmatic embedder that sets `network.transports`**: `resolveTransportOptions` returns `{}` as before, so the embedder owns everything. Unchanged.
- **`announceAddrs` set** (replaces everything advertised): the `/webrtc` circuit address is replaced too, exactly as the `/p2p-circuit` one already is. The existing start-time warning covers it. Verify by inspection.
- **A storage-profile host also running a relay server** (`enableRelay`): unaffected. The WebRTC signalling handler sits in the protocol guard's `transport` class.
- **The Docker image size** change is measured and stated, not guessed.

## Tests

- **Extend the existing `relay-addrs` spec** with the new branching: `/webrtc` accepted with `defaultTransports` set, refused without, and the ICE-servers field derived from relays and from the override.
- **The cadre-cli config test** for the env var and the schema entry, only if the existing config spec already covers each field. Otherwise none (that would be wiring).
- **No new integration scenario.** `relayed-connections-try-a-webrtc-upgrade`'s scenario covers the upgrade, and a Node party in it is already Node-hosted.

## TODO

- Add the `/webrtc` listen kind, the WebRTC field in `ListenTransportOptions`, and `NetworkConfig.stunUrls` in cadre-core. Add the transport in `nodeDefaultTransports` behind a dynamic import.
- Move `@libp2p/webrtc` to cadre-core's dependencies.
- Add `network.webrtc`, `network.stunUrls`, `CADRE_WEBRTC` and `CADRE_STUN_URLS` to cadre-cli: types, schema, env and both start paths.
- Do the native-module exploration above, adjust the Dockerfile if needed, and record the results.
- Docs: the cadre-cli README (config field, env vars, platform support), `example.cadre.yaml` (commented example), the `docs/architecture.md` config block (the `/webrtc` line now points at `network.webrtc`), and the Relay Integration subsection that the WebRTC tickets add.
- Run `yarn lint`, the cadre-core and cadre-cli tests, and the Docker build if Docker is available. If it isn't, say so in the handoff.
