description: Every Cadre node now waits 30 seconds, instead of 5, before it decides a peer has stopped answering its liveness ping, and spaces its pings 35 seconds apart so the wait is real. A phone busy with slow encryption used to be disconnected mid-sync and never catch up; now it is just slow.
files:
  - packages/cadre-core/src/types.ts (`NetworkConfig.connectionMonitor`, `DEFAULT_CONNECTION_MONITOR`)
  - packages/cadre-core/src/cadre-node.ts (`buildControlNodeOptions`)
  - packages/cadre-core/src/strand-instance-manager.ts (`buildStrandRuntime`'s `createLibp2pNode` call)
  - packages/cadre-core/src/strand-network-config.ts (module comment: list of inherited fields)
  - packages/cadre-core/test/cadre-node-control-node-options.spec.ts, strand-instance-manager-network-addrs.spec.ts, types.spec.ts
  - ops/docker/libp2p-infra/src/main.ts (the relay's own `connectionMonitor`)
  - docs/architecture.md (`NetworkConfig` listing), docs/reference-app-rn.md (native-crypto section)
  - tickets/blocked/report-issue-13-ping-timeout-reply.md (the draft reply to the reporter)
----

# Complete: cadre-core defaults libp2p's ping deadline to 30 s, pinged every 35 s

Reported and diagnosed as gotchoices/sereus#13 by `kjeib`. libp2p's connection monitor pings every open connection on a timer and, with its own `abortConnectionOnPingFailure: true`, aborts the connection on the first ping that does not answer in time. Stock settings are a 5 second deadline and a 10 second interval. A peer whose event loop is saturated by pure-JS Noise crypto — a phone under React Native — misses that deadline while perfectly healthy, the peer redials, and the new handshake saturates it further. The relay half of the fix was PR #15, merged; this ticket was the Cadre-node half.

## What shipped

- **`NetworkConfig.connectionMonitor?: Libp2pConnectionMonitorInit`** — a type-only import of db-p2p's re-export of libp2p's `ConnectionMonitorInit`, so an app needs no direct `libp2p` dependency. Placed beside `noiseCrypto`, the other field both node kinds inherit literally.
- **`DEFAULT_CONNECTION_MONITOR`**: `{ pingInterval: 35_000, pingTimeout: { minTimeout: 30_000, maxTimeout: 30_000 } }`, frozen at both levels as `CONTROL_CLUSTER_POLICY` is. Both node builders take it unconditionally — `network?.connectionMonitor ?? DEFAULT_CONNECTION_MONITOR` — because the monitor runs on BOTH ends of a connection and either end's abort closes it, so a setting only the slow phone applied would not stop its peers dropping it. An explicit value replaces the default wholesale; `{}` is how an app asks for libp2p's stock behaviour back.
- **The relay config** (`ops/docker/libp2p-infra/src/main.ts`) now carries the same interval and the same pinned ceiling. **It still has to be redeployed** for any of the relay half to take effect — an ops action outside this repo's code.
- **Docs**: the `NetworkConfig` listing in `docs/architecture.md` and a paragraph in `docs/reference-app-rn.md` beside the native-crypto one. `strand-network-config.ts`'s module comment lists `connectionMonitor` among the fields the caller inherits.

## Review findings

### Fixed in this pass

**The widened deadline did nothing past 10 seconds, because `pingInterval` was left at libp2p's default.** This was the implementation's central claim — a 30 second deadline — and it was not what the code produced. The monitor opens a ping stream per connection per interval whether or not the previous ping has answered, and `@libp2p/ping` registers `/ipfs/ping/1.0.0` with `maxOutboundStreams: 1`. So the second overlapping ping fails inside `Connection.newStream` with `TooManyOutboundProtocolStreamsError`, which lands in the monitor's own catch and aborts the connection exactly as a timeout does. With a 10 second interval and a 30 second deadline, a peer that stalls for more than 10 seconds is still dropped — at 10 seconds rather than at 5.

Reproduced against two local libp2p 3.1.3 nodes whose ping handler was made to answer 600 ms late, at roughly 1/33 of the real numbers: a 300 ms interval with a 300 ms deadline aborted the connection (the stock shape), a 300 ms interval with a 900 ms deadline **also** aborted it, with `TooManyOutboundProtocolStreamsError: ... - 2/1` (the shipped shape), the same pair survived a 200 ms stall with the 900 ms deadline (showing the ceiling is the interval, not the deadline), and a 900 ms interval with a 900 ms deadline survived the 600 ms stall (the fix). Fixed by raising `pingInterval` to 35 s — strictly above the deadline, so a ping is never outstanding when the next one starts — in both `DEFAULT_CONNECTION_MONITOR` and the relay config.

**`maxTimeout: 600_000` was a latent version of the same defect.** It does nothing under libp2p 3.1.3 (the monitor never calls `AdaptiveTimeout.cleanUp`, so the moving average stays at zero and the deadline is exactly `minTimeout` — confirmed by reading the resolved `libp2p` and `@libp2p/utils` sources). But libp2p 3.3 does report ping durations back, and a ceiling of 600 s above a 35 s interval would have let the deadline climb past the interval and reinstated the overlapping-ping abort on the version bump. Pinned `maxTimeout` to `minTimeout` instead, in both places, which fixes the deadline at 30 s on every libp2p version. That also retires the implementation's 3.3 tripwire about one slow peer lengthening the node-wide deadline: with the deadline pinned there is nothing to adapt.

**The reclaim cost was restated honestly.** A dead peer is now reclaimed 30 to 65 seconds after it stops answering (deadline plus up to one interval), not the 30-40 seconds the implementation documented. `db-p2p` caps a node at 16 connections, so the worst case is those slots held about a minute longer than before; at that scale it is not a starvation risk. Nothing reads `conn.rtt`, checked across both repos, so the slower ping cadence has no other consumer.

**The draft reply to the reporter** (`tickets/blocked/report-issue-13-ping-timeout-reply.md`) told them the 30 second floor was the whole deadline and that `maxTimeout` would take effect on the libp2p 3.3 bump. Both are now wrong. Corrected in place, with the interval finding written out for them — it also explains why their relay-only run came out 2 of 3 rather than 3 of 3.

**One test added**, in `types.spec.ts`: the ping interval must exceed the longest deadline the timeout can produce. That relationship is the one thing neither number shows on its own, and it is what a future edit — raising the ceiling on the 3.3 bump, say — would silently break.

### Filed

- `tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md`. Three other sites build a libp2p node and get libp2p's stock monitor: `quereus-plugin-sereus`'s `connect.ts` and `connect-browser.ts`, and `integration-tests`' `test-party.ts`. No path in this repo reaches the first two — `cadre-core` always injects a node it built itself, so `connectToStrand` never creates one — so the gap is dormant here and live only for an outside consumer of the published package. Filed at the level of the invariant rather than as three copies of a literal: `cadre-core` depends on `quereus-plugin-sereus`, so the settings would move down there and be re-exported, the pattern `CONTROL_CLUSTER_POLICY` already uses. `relay-addrs.ts` carries a sibling note saying the same thing about a third listen-address site forgetting to pair its two halves.

### Tripwires parked

None new. The implementation's libp2p-3.3 tripwire in `DEFAULT_CONNECTION_MONITOR`'s doc comment was **retired rather than reworded** — pinning the deadline removes the condition it was watching for. The comment now states why the ceiling is pinned, which is the fact worth keeping.

### Checked, nothing to report

- **The value's journey into libp2p.** `db-p2p`'s `NodeOptions.connectionMonitor` is a one-line passthrough into `createLibp2p`, its doc comment already describes the flat-`minTimeout` behaviour, and it deliberately substitutes no default of its own. Real nodes started with the new object in the integration runs below and nothing rejected it.
- **The frozen shared object.** One `DEFAULT_CONNECTION_MONITOR` reaches every libp2p node in the process; libp2p reads the init in its constructor and never writes to it, and both levels are frozen.
- **The `{}` escape hatch** does what the doc comment claims — an explicit value is passed through whole, so `{}` restores libp2p's own defaults. Added a line to the field's doc warning that an app widening the deadline itself has to raise `pingInterval` with it, which is the trap this review walked into.
- **The dependency floor.** `cadre-core` declares `@optimystic/db-p2p@^1.4.0` and the `connectionMonitor` support is an unreleased commit in the linked workspace. Left alone: `noiseCrypto` shipped the same way, floors move at publish time here, and the import is type-only.
- **The two added passthrough tests** were kept. They pin two independent call sites that can regress separately, and match how every other `NetworkConfig` field is pinned in those two files.

### Not done

- **No reproduction fixture at full device crypto cost.** The reporter's roughly 40-line CPU-cost fixture has not arrived (no open or merged PR carries it). The ticket's "confirm stock fails and the default passes at full cost" step was therefore not performed. What was run instead is the real scenario the report is about at normal CPU cost, plus the targeted two-node reproduction of the interval defect described above. If the fixture lands it belongs next to `packages/integration-tests/src/harness/ws-latency.ts`, opt-in by environment variable, like `RELAY_RRT_MEASURE`.

## Validation

- `yarn workspace @serfab/cadre-core typecheck` — clean. `yarn workspace @serfab/cadre-core test` — 137 files, 2259 passed, 1 skipped (pre-existing).
- `yarn lint`, `yarn typecheck`, `yarn build` at the repo root — clean.
- `npm run build` in `ops/docker/libp2p-infra` (libp2p 2.10, the relay's own tree) — clean.
- Integration scenarios run individually: `blind-relay-phone-to-phone-e2e` (2 pass, 4 relay reservations on both arms), `strand-formation-e2e` plus `basic-connectivity` (28 pass). The full integration suite was not run: 57 real-network scenarios with `fileParallelism: false` and 60 s timeouts, past the ten-minute agent budget. These are the relay and strand paths this change touches. The one way the longer reclaim could disturb a scenario is a peer dying without closing its socket; no scenario kills a node abruptly (`provider-process-orchestrator.ts` sends SIGTERM first and only escalates in teardown).
- The interval reproduction was a throwaway script run against `optimystic/packages/db-p2p`'s installed libp2p; it lived in the session scratchpad and is gone. Its four cases are written out above in enough detail to re-run.
- No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. As on the implement pass, cadre-core's stale-build guard first required `yarn workspace @optimystic/db-p2p build` in `C:\projects\optimystic`; no optimystic source was edited.
