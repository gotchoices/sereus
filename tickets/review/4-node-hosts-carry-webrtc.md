description: The command-line node program can now be told to offer a WebRTC address when it has a relay, so a home machine reachable only through a relay server can move connections onto a direct path instead of relaying every byte.
architecture: docs/network/relay.md#node-kinds
files: packages/cadre-core/src/relay-addrs.ts, packages/cadre-core/src/node-default-transports.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-network-config.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-cli/src/commands/node-network.ts, packages/cadre-cli/src/commands/start-node.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/config/types.ts, packages/cadre-cli/src/config/schema.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-core/test/relay-addrs.spec.ts, packages/cadre-core/test/strand-network-config.spec.ts, packages/cadre-cli/test/config-validation.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/example.cadre.yaml, packages/cadre-cli/docker/env.example, packages/cadre-cli/docker/docker-compose.yml, docs/cadre/node.md, docs/network/relay.md, ops/docs/ice-servers.md
difficulty: medium
----
# Node hosts carry WebRTC, opt-in: `network.webrtc`

## What landed

**cadre-core: a `/webrtc` listen kind that only a Node host can bind.**

- `relay-addrs.ts` — `listenTransportKind` gained a `webrtc` kind, read from the outermost transport component like every other kind there, so a bare `/webrtc` and a relayed `…/p2p-circuit/webrtc` classify alike. `/webrtc-direct` is deliberately not that kind: `webRTCDirect` is a separate transport nothing here supplies.
- `resolveTransportOptions` accepts a `/webrtc` entry **only when `network.defaultTransports` is set** — that field is the Node-only injected transport list, the only thing in the repo that can supply `@libp2p/webrtc`'s Node build. Without it the entry joins the existing `UnbindableListenAddressError`, whose message gained a sentence naming `network.defaultTransports` and `cadre-cli`'s `network.webrtc`.
- When accepted, the resolution carries `webrtcIceServers` — the value of `resolveStunServers(network.relayAddrs, network.stunUrls)`, so the transport factory reads one field. **Present-but-empty is still the switch** (host and LAN candidates only); absent is the only "no WebRTC" answer.
- New `NetworkConfig.stunUrls?: string` — comma-separated `stun:` URLs overriding the per-relay derivation, same spelling the apps take from `VITE_STUN_URLS` / `EXPO_PUBLIC_STUN_URLS`.
- New `listenTransportNodeOptions(listen)` returns the db-p2p-bound subset (`wsPort`, nothing else). Both sites that spread the resolution into `createLibp2pNode` options now go through it, because `webrtcIceServers` is not a db-p2p option and spreading it would hand db-p2p a key it does not know — the drift the strand builder already avoids for `relayAddrs`. `strand-instance-manager.ts` therefore destructures `listenAddrs` and the transport switches apart.
- `StrandNodeAddrs` gained `webrtcIceServers`, documented as travelling with the listen entries but not being a node option.
- `index.ts` now exports `DEFAULT_DIRECT_LISTEN_ADDR`: a host that APPENDS an entry to an unset `listenAddrs` has to carry the default direct listener forward, and that default has one home.

**cadre-core: the transport is loaded on demand.** `node-default-transports.ts` gained `loadNodeWebrtcTransport()`, the one run-time `import()` in the package, and `nodeDefaultTransports(listen, webrtc?)`, which adds `webRTC({ rtcConfiguration: { iceServers } })` when the ICE field is present. The import has to be dynamic: `@libp2p/webrtc`'s Node build reaches `node-datachannel`, which loads a native addon as its module is evaluated and throws where the platform has no prebuilt binary — a node with the flag off must neither pay that nor fail on it. `nodeDefaultTransports` **throws** when the ICE field is present and no factory was passed, so a programmatic Node embedder cannot produce the silent-unbound-listener state the resolution exists to prevent. `@libp2p/webrtc` 6.0.33 moved from cadre-core's devDependencies to dependencies; `yarn.lock` is unchanged, because yarn merges a workspace's dependency classes into one block.

**cadre-cli: one flag sets all three halves.**

- `network.webrtc?: boolean` (`CADRE_WEBRTC`) and `network.stunUrls?: string` (`CADRE_STUN_URLS`) in the config type, the schema field table and the env registry.
- A `refine` on the `network` block **rejects a hand-written `/webrtc` in `listenAddrs`**, naming `network.webrtc`. Matched segment-wise, so `/webrtc-direct` still falls through to cadre-core's refusal, which names its package.
- New `commands/node-network.ts` → `resolveNodeNetwork(network)`, shared by `cadre start` and the one-shot commands so one config file gives one node shape. It consumes the CLI-only `webrtc` key (it is not forwarded), always supplies `defaultTransports`, and on the opt-in-with-relay branch loads the transport and appends `/webrtc` to `listenAddrs ?? [DEFAULT_DIRECT_LISTEN_ADDR]` — so asking for WebRTC never costs the node its TCP listener. With the flag on and no relay it warns once and changes nothing.
- `buildNodeConfig` (`start-node.ts`) and `oneShotNodeConfig` (`node-session.ts`) are now async, for that resolution alone.

**Comment corrected:** `cadre-node.ts`'s `startWebrtcUpgrade` said the upgrade service is inert "on a node whose embedder passed no WebRTC transport, which is every Node.js host". No longer true.

**Docs:** cadre-cli README (two config-table rows, the bindable-transports bullet, and a new "Direct connections over WebRTC" section carrying the platform support below); `example.cadre.yaml`; `docker/env.example` and `docker/docker-compose.yml` (both variables); `docs/cadre/node.md` (the transports row, a `stunUrls` row, the `defaultTransports` paragraph, and the "Configuration errors that fail `start()`" item, which now says `/webrtc` is refused only on a node that passed neither `transports` nor `defaultTransports`); `docs/network/relay.md` (new "Which nodes offer a WebRTC address" sub-section); `ops/docs/ice-servers.md` (the derivation is no longer apps-only; the settings table gained the CLI row). One unrelated correction in a table row being edited anyway: the README said `enableRelay` defaults "on for `storage`, off for `transaction`", which are retired profile names — it is `nodeClass: server` / `device`.

## Native-module exploration — what was established

`node-datachannel` 0.33.4 ships nine prebuilt binary packages as `optionalDependencies`, each constrained by `os`/`cpu`/`libc`: linux x64 and arm64 in both glibc and musl flavours, darwin x64 and arm64, win32 x64 and arm64, android arm64. Its loader (`dist/esm/lib/node-datachannel.mjs`) chooses between the gnu and musl packages with `detect-libc`'s `familySync()`.

- **Alpine is covered, so the Dockerfile is unchanged.** `@node-datachannel/linux-x64-musl` and `@node-datachannel/linux-arm64-musl` both publish at 0.33.4, and both tarballs were downloaded and listed: each holds a real `node_datachannel.node` (20,054,144 bytes x64, 19,805,504 bytes arm64). All nine packages are already in the repo `yarn.lock` with resolutions, so the Dockerfile's seeded-lock install resolves the musl one with no surprise. No Debian-slim base and no added build toolchain: the prebuilds have no install script, so nothing compiles from source.
- **An install never fails for want of a binary.** The platform packages are optional and architecture-filtered, so a platform with none (32-bit ARM, FreeBSD, riscv64) installs cadre-core normally. Only the require throws, and only with the flag on; it names `node-datachannel`, the platform and the architecture.
- **Nothing WebRTC-related is loaded with the flag off**, since the only import of `@libp2p/webrtc` in cadre-core is the `await import()` inside `loadNodeWebrtcTransport`, called from one branch of `resolveNodeNetwork`.
- **Load cost, measured on win32-x64:** 1,968 ms for `loadNodeWebrtcTransport()`, paid once at start when the flag is on.

## Image size: measured as a closure delta, not as an image

**Docker is not available here** — the daemon is not running — so the image was neither built nor installed into. What was measured instead: cadre-cli's production dependency closure in this checkout's `node_modules`, walked with and without `@libp2p/webrtc`. **55 new packages, 21,731,569 bytes.** That total includes this machine's `@node-datachannel/win32-x64-msvc` (7,533,987 bytes); substituting the Alpine x64 binary (20,054,144 bytes) gives **about 34,251,726 bytes — 32.7 MiB — added to the image.**

The weight is mostly the native binary, then `@libp2p/webrtc` itself (2.0 MiB), `react-native-webrtc` (1.5 MiB — a hard, not optional, dependency of `@libp2p/webrtc`, and dead weight in a Node image), `@libp2p/noise`, `@libp2p/keychain`, `@peculiar/x509`, `@peculiar/webcrypto`, `reflect-metadata`. **It is paid whether the flag is on or off**: moving the dependency out of devDependencies is what puts it in the image. Parked as a `NOTE:` tripwire on `loadNodeWebrtcTransport` with the fix if it ever has to come off — a package of its own that a host installs on purpose.

Two caveats on the number. The Docker install resolves without the repo's `resolutions` block (optimystic and quereus come from the registry), so its hoisting and therefore its duplicate count differ — treat 32.7 MiB as an estimate for the image and a measurement of this tree. And it is a closure delta, not an image delta: layer compression is not accounted for.

## Tests added

- `packages/cadre-core/test/relay-addrs.spec.ts`, new `describe` — six cases: the ICE servers derived from `relayAddrs`; the `stunUrls` override replacing them; an empty set still PRESENT (absence is the only "no WebRTC" answer); a `…/p2p-circuit/webrtc` entry classified the same as the bare one; the refusal on a node with no `defaultTransports`, asserted to name `network.webrtc`; `/webrtc-direct` still refused.
- `packages/cadre-core/test/strand-network-config.spec.ts`, one case — a `/webrtc` entry and its ICE servers reach a strand node, surviving both the ephemeral-port rewrite (it names no port) and the relay substitution (it is not a circuit entry).
- `packages/cadre-cli/test/config-validation.spec.ts`, one case — a hand-written `/webrtc` in `listenAddrs` is rejected, naming `network.webrtc`.

Nothing added for the env-variable entry or the schema field: that spec's own doc states it does not test per-field type checks, because the field tables are compile-checked against the config type. No new integration scenario, per the ticket.

## What a reviewer should check, because no committed test covers it

- **The CLI resolution's four shapes.** Exercised ad hoc against the built output, not as a test: flag off leaves the listen set untouched and gives two transports; flag on with no relay warns once and leaves it untouched; flag on with a relay resolves to `['/ip4/0.0.0.0/tcp/0', '/webrtc', '/p2p-circuit']` with three transports and `[{urls: 'stun:<relay host>:3478'}]`; the override replaces that; the strand derivation matches; and the CLI-only `webrtc` key does not reach cadre-core.
- **That a real node built this way starts and can dial WebRTC.** Also ad hoc: `createLibp2pNode` with `['/ip4/127.0.0.1/tcp/0', '/webrtc']` and the three transports started, bound TCP, and registered the WebRTC signalling protocol — which is exactly what `canDialWebrtc` reads, so `WebrtcUpgradeService` is live on such a node rather than inert. Worth deciding whether that belongs in `listen-transport-options.spec.ts`, which boots a real node for the `/ws` half of the same question; it was left out because that spec's node is built without `defaultTransports`.
- **`announceAddrs` replacing the WebRTC circuit address.** Unchanged by this ticket and covered by the existing start-time warning; not re-checked at run time.
- **A node also running a relay server.** `WEBRTC_SIGNALING_PROTOCOL` is already classed `transport` in `control-protocol-guard.ts`, so there is no admission change. Read, not exercised.

## Known gaps

- **No Docker build and no in-image install or load.** The Alpine conclusion rests on registry metadata, the two tarballs' contents, and the loader's source — not on a run. A reviewer with Docker should build `packages/cadre-cli/docker/Dockerfile` and, in the image, `node -e "require('node-datachannel')"`, and report the real image-size delta.
- **Nothing proved the upgrade end to end on this path.** `relayed-connections-try-a-webrtc-upgrade`'s scenario covers the upgrade between parties that pass `network.transports`; no scenario builds a party through `network.webrtc` + `defaultTransports`. The new path's own wiring is proved only by the ad-hoc boot above.
- **One-shot commands now pay the native load too.** `oneShotNodeConfig` resolves the same network block as `cadre start`, so with the flag on every `cadre strand list` pays ~2 s before connecting. Nothing measured that against those commands' 30 s connect budget; whether a one-shot command should carry WebRTC at all is a fair thing to question — the ticket specified both paths for shape consistency.
- **The no-relay warning prints once per node construction**, so `cadre start`'s in-process restart into a claimed party prints it twice.

## Gates

`yarn lint` (ESLint plus `check:docs`, 66 Markdown files OK) and `yarn typecheck` (every workspace, plus the vitest/test-file/stale-build coverage checks) pass. `@serfab/cadre-core`: 198 files, 2661 passed, 1 skipped. `@serfab/cadre-cli`: 24 files passed and 1 skipped, 293 passed and 4 skipped. `yarn dep-check` (knip) fails at HEAD with a large pre-existing backlog and is part of neither `lint` nor `test`; `@libp2p/webrtc` is not among its unused dependencies, so it does see the dynamic import. No pre-existing test failure surfaced. Nothing in `../optimystic`, `../quereus` or `../Fret` was built, installed into or edited.
