description: Every Cadre node now waits 30 seconds, instead of 5, before it decides a peer has stopped answering its liveness ping. A phone busy with slow encryption used to be disconnected mid-sync and never catch up; now it is just slow.
files:
  - packages/cadre-core/src/types.ts (`NetworkConfig.connectionMonitor`, `DEFAULT_CONNECTION_MONITOR`)
  - packages/cadre-core/src/cadre-node.ts (`buildControlNodeOptions`, line ~1672)
  - packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`'s `createLibp2pNode` call, line ~684)
  - packages/cadre-core/src/strand-network-config.ts (module comment: list of inherited fields)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts
  - packages/cadre-core/test/strand-instance-manager-network-addrs.spec.ts
  - docs/architecture.md (`NetworkConfig` listing), docs/reference-app-rn.md (native-crypto section)
  - ../optimystic/packages/db-p2p/src/connection-monitor.ts, libp2p-node-base.ts (`NodeOptions.connectionMonitor`)
----

# Review: cadre-core defaults libp2p's ping deadline to 30 s

Context: gotchoices/sereus#13, reported and diagnosed by `kjeib`. libp2p's connection monitor pings every connection every 10 s and, with its own `abortConnectionOnPingFailure: true`, aborts the connection on the FIRST missed ping. The deadline is nominally adaptive with a 5 s floor but does not adapt below libp2p 3.3, so it is a flat 5 s. A peer whose event loop is saturated by pure-JS Noise crypto — a slow phone — misses it while healthy, the peer redials, and the new handshake saturates it further. The relay half of the fix is PR #15, merged; this is the Cadre-node half.

## What changed

- **`NetworkConfig.connectionMonitor?: Libp2pConnectionMonitorInit`** (`types.ts`), a type-only import of db-p2p's re-export of libp2p's `ConnectionMonitorInit`, so an app needs no direct `libp2p` dependency. Placed beside `noiseCrypto`, the other field both node kinds inherit literally.
- **`DEFAULT_CONNECTION_MONITOR`** (`types.ts`, exported via `export * from './types.js'`): `{ pingTimeout: { minTimeout: 30_000, maxTimeout: 600_000 } }`, the reporter's measured configuration. `Object.freeze` at both levels, matching `CONTROL_CLUSTER_POLICY` — one object reaches every libp2p node in the process. Its doc comment carries the measurements, the reclaim-delay cost and the libp2p-3.3 tripwire (see *Tripwires* below).
- **Both node builders take it unconditionally**: `connectionMonitor: network?.connectionMonitor ?? DEFAULT_CONNECTION_MONITOR` in `buildControlNodeOptions` and in `buildStrandRuntime`'s `createLibp2pNode` call. This is the one `NetworkConfig` field that is *defaulted* rather than passed through-or-omitted, because the monitor runs on BOTH ends of a connection and either end's abort closes it — a setting only the slow phone applied would not stop its peers dropping it. An explicit value replaces the default wholesale, so `{}` is how an app asks for libp2p's stock behaviour back; that escape hatch is stated in the field's doc comment.
- **Docs**: the `NetworkConfig` listing in `docs/architecture.md`; a new paragraph in `docs/reference-app-rn.md` beside the native-crypto one, saying the deadline is already widened for every node and the RN app sets nothing for it.
- `strand-network-config.ts`'s module comment now lists `connectionMonitor` among the fields the caller inherits rather than that module deriving.

## What a reviewer should check

- **The default is deliberately global, not React Native only.** That is the ticket's central claim and the reason this is not opt-in. If you disagree with defaulting behaviour for every deployment, that is the decision to argue with — the alternative the reporter also measured (`abortConnectionOnPingFailure: false` on both ends, 3 of 3 passing) keeps the ping but never acts on it, which gives up dead-peer reclamation entirely.
- **The reclaim cost.** A dead peer is now reclaimed after about 30-40 s (the flat deadline plus up to one 10 s ping interval) where it was about 5-15 s. db-p2p caps a node at 16 connections (`libp2p-node-base.ts`, `maxConnections: 16`). No test covers this; at 16 slots held ~30 s longer it did not look worth one. Reviewer's call.
- **`maxTimeout: 600_000` does nothing today** and is set for the libp2p version that adapts. Under libp2p 3.1.3 (what sereus resolves) `ConnectionMonitor` never calls `AdaptiveTimeout.cleanUp`, so the moving average stays at zero and the deadline is always exactly `minTimeout`. Verified by reading `node_modules/libp2p/dist/src/connection-monitor.js` and `@libp2p/utils`' `adaptive-timeout.js` at the resolved versions. If you would rather not ship a field that does nothing, dropping it is behaviour-neutral now and would need re-adding on the move to 3.3.

## Tests added

- `cadre-node-control-node-options.spec.ts` → "defaults connectionMonitor when unset, and lets a configured value replace it": `buildControlNodeOptions()` on a config with no `network` hands back `DEFAULT_CONNECTION_MONITOR` by identity, and a configured `{ abortConnectionOnPingFailure: false }` replaces it by identity.
- `strand-instance-manager-network-addrs.spec.ts` → "defaults the strand node's connectionMonitor, and lets a configured value replace it": the same two assertions against what reaches the mocked `createLibp2pNode` for a started strand.

Two tests rather than one because the two node builders are independent call sites that can regress separately, and "the default reaches BOTH node kinds" is the part of the specification worth pinning. Nothing else was added: the value's onward journey is db-p2p's `connectionMonitor: options.connectionMonitor` straight into libp2p, and the deadline's behaviour is libp2p's.

## Tripwires parked

- **libp2p 3.3 starts adapting the deadline.** Its monitor calls `cleanUp` in a `finally`, so from that version the deadline moves between 30 s and 600 s, and because the monitor keeps one `AdaptiveTimeout` for all of a node's connections, one slow peer lengthens the deadline for every connection on that node. Parked as a `NOTE:` in `DEFAULT_CONNECTION_MONITOR`'s doc comment in `types.ts`, naming the reclaim numbers and db-p2p's matching comment as the things to re-check. Not a ticket: nothing is wrong until the bump.

## Known gaps

- **`@serfab/quereus-plugin-sereus` builds libp2p nodes that get no default.** `connect.ts` → `createNode` and `connect-browser.ts` call `createLibp2pNode` without `connectionMonitor`, so a Quereus session joining a strand network still runs libp2p's 5 s deadline and can drop a slow phone on that strand. Left alone deliberately: it is outside this ticket's `## Do` list, and cadre-core depends on quereus-plugin-sereus rather than the reverse, so covering it means moving `DEFAULT_CONNECTION_MONITOR` into quereus-plugin-sereus and re-exporting it from cadre-core's `types.ts` — the pattern already used for `CONTROL_CLUSTER_POLICY` and friends. That is a design call, not a mechanical edit; file it if you agree. `packages/integration-tests/src/harness/test-party.ts` builds bare nodes the same way.
- **No reproduction fixture.** The reporter offered their ~40-line CPU-cost fixture and it has not arrived — no open or merged PR carries it (checked `gh pr list --state all`). So the ticket's "confirm stock fails and the default passes at full cost" step was NOT performed here. The closest thing run was the real scenario the report is about, `blind-relay-phone-to-phone-e2e.integration.ts`, at normal CPU cost: both arms pass, 4 relay reservations, no ping-failure aborts — which is the healthy shape the ticket describes, not a reproduction of the failure. If the fixture lands it belongs next to `packages/integration-tests/src/harness/ws-latency.ts`, opt-in by environment variable, like `RELAY_RRT_MEASURE`.
- **The relay still needs redeploying** for PR #15 to take effect. Ops action, outside this repo's code.
- **No live assertion that libp2p actually receives the deadline.** The specs pin the options object; the hop from there into libp2p's constructor is db-p2p's one-line passthrough. Real nodes were started with the default (see the integration runs below) and nothing rejected the init, which is the extent of the end-to-end evidence.

## Validation run

- `yarn workspace @serfab/cadre-core typecheck` / `build` — clean.
- `yarn workspace @serfab/cadre-core test` — 137 files, 2258 passed, 1 skipped (pre-existing).
- Every other unit suite: `quereus-plugin-sereus` (113), `cadre-cli` (236), `cadre-host` (657 + 4 pre-existing skips), `cadre-provider` (222), `reference-app-rn` (317), `reference-app-web` (66), `reference-app-ns` (110) — all pass.
- `yarn lint`, `yarn build`, `yarn typecheck` at the repo root — clean.
- Integration scenarios run individually: `blind-relay-phone-to-phone-e2e` (2 pass), `strand-formation-e2e` (22), `websocket-chat` (1), `basic-connectivity` (6). **The full integration suite was not run**: 57 real-network scenarios, `fileParallelism: false`, 60 s timeouts — past the ten-minute agent budget. The scenarios above were picked as the relay and strand paths this change touches. The one plausible way the new default could disturb a scenario is a peer dying without closing its socket, where reclamation is now ~30 s later; no scenario kills a node abruptly (`provider-process-orchestrator.ts` sends SIGTERM first and only escalates in teardown).
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written.
- One prerequisite outside this repo: the stale-build guard refused to run cadre-core's tests until `yarn workspace @optimystic/db-p2p build` was run in `C:\projects\optimystic` (its `src` was newer than its `dist`). No optimystic source was edited.
