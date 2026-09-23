description: A phone busy with slow crypto misses libp2p's 5-second liveness ping, so its connections are torn down and redialled, and each redial costs more crypto; past a point it never finishes syncing. Widening the ping timeout on every node makes a slow phone slow instead of stuck. The relay half is PR #15; the Cadre node half waits on an optimystic option.
files:
  - ops/docker/libp2p-infra/src/main.ts (relay: gotchoices/sereus PR #15 sets `connectionMonitor.pingTimeout`)
  - ../optimystic/packages/db-p2p/src/libp2p-node-base.ts (hardcoded libp2p options; gotchoices/Optimystic#21 asks for `connectionMonitor` on `NodeOptions`)
  - packages/cadre-core/src/types.ts (`NetworkConfig`, beside `noiseCrypto`)
  - packages/cadre-core/src/cadre-node.ts (`buildControlNodeOptions`) and strand-instance-manager.ts (strand node options)
----

# A slow peer is dropped on ping timeout, and the redials make it slower

Reported on gotchoices/sereus#13 by `kjeib`, who reproduced it without a device and then found the cause.

## Symptom

They charged the Galaxy S7's measured crypto cost as a blocking busy-wait inside Noise's Node crypto build, then ran the two-party blind-relay bring-up:

| fraction of S7 cost | total | crypto ops | CPU burned | result |
|---|---|---|---|---|
| 0 | 2.8 s | — | — | pass |
| 0.25 | 30.6 s | 19,061 | 25.4 s | pass |
| 0.50 | 53.5 s | 22,038 | 48.1 s | pass |
| 1.00 | — | 42,557 | 313 s | fail (also with `strandFirstSync.timeoutMs` at 300 s) |

Doubling the per-operation cost multiplied the work by 6.5. Raising timeouts didn't help.

## Cause (reporter, confirmed by the relay's own logs)

libp2p's connection monitor pings every connection every 10 s. By default (`abortConnectionOnPingFailure: true`) it aborts a connection on its FIRST ping timeout. The timeout is nominally adaptive with a 5 s floor, but below libp2p 3.3 it never adapts (see below), so it is a flat 5 s. A peer whose event loop is saturated by pure-JS Noise misses the ping, so the connection is aborted and the client redials. The redial costs a new handshake (~231 ms CPU at S7 rates), which keeps it saturated. The relay logged `aborting connection due to ping failure` 30 times in one failing run. A failing run opens 17–23 sockets and performs 41–59 handshakes; a healthy one opens 4 and performs 12.

Fix measured at full device cost, `connectionMonitor: { pingTimeout: { minTimeout: 30_000, maxTimeout: 600_000 } }`:

| configuration | passed |
|---|---|
| stock | 0 of 3 |
| relay only | 2 of 3 |
| relay and clients | 4 of 4, ~90 s |
| `abortConnectionOnPingFailure: false` on both ends | 3 of 3 |

Pinging less often, or raising only the ceiling, did not help (0 of 2 each). The floor is what matters.

**The timeout doesn't actually adapt below libp2p 3.3** (found by optimystic-99, verified 2026-09-23). `ConnectionMonitor` asks its `AdaptiveTimeout` for a deadline on every ping but never calls `cleanUp()`. The moving average stays at zero, so the deadline is always exactly `pingTimeout.minTimeout`, and `maxTimeout` has no effect. That holds in libp2p 2.10.0 (the relay today) and 3.1.3 (what sereus and optimystic resolve). libp2p 3.3.11 fixed it: `cleanUp(signal)` runs in a `finally`. So the reporter's passing configuration was a **flat 30 s deadline** on every node, which also explains why raising only the ceiling did nothing. Consequences:
- A dead peer is reclaimed after about 30–40 s (the deadline plus up to one 10 s ping interval), not 10 minutes.
- After PR #14 (relay on 3.3.11), the relay's deadline adapts between 30 s and 600 s. The average is shared across all the relay's connections (one `AdaptiveTimeout` per monitor), but with normal round-trip times the 30 s floor still dominates.

## Status

- **Relay:** PR #15 (kjeib), merged 2026-09-23 by the tending agent with the maintainer's go-ahead. Its comment has been corrected to say that on libp2p 2.10 the deadline is a flat 30 s. It takes effect once the relay is redeployed.
- **Cadre nodes: unblocked.** Optimystic 1.4.0 is on npm, and sereus floors are `^1.4.0` (`3bc421da`). `@optimystic/db-p2p` and `/rn` export `Libp2pConnectionMonitorInit` (a re-export of libp2p's `ConnectionMonitorInit`), and `NodeOptions.connectionMonitor` passes it to libp2p unchanged. Unset keeps libp2p's default.

## Do

- Add `connectionMonitor?` to `NetworkConfig` (typed from db-p2p's re-export), passed to the control node and every strand node, as `noiseCrypto` is.
- **Default it** in cadre-core to `{ pingTimeout: { minTimeout: 30_000, maxTimeout: 600_000 } }` when unset, not only on React Native. Every peer of a slow phone runs the monitor on its connection to that phone: the PC party on its relayed connection, and the phone itself on its own. So an opt-in setting on the phone alone would not cover it. An app's explicit value replaces the default.
  - The cost is settled (see above): on libp2p 3.1.x the deadline is a flat `minTimeout`, so a dead peer is reclaimed after about 30–40 s instead of about 5–15 s. Say so in the doc comment, and that `maxTimeout` only takes effect from libp2p 3.3. db-p2p caps connections at 16. A dead connection kept about 30 s longer is not a starvation risk worth a test, but note it.
- Test: one spec that the default reaches both node kinds, and that an explicit value replaces it.
- Reproduction: the reporter offered their ~40-line CPU-cost fixture. If it arrives as a PR, it belongs next to `packages/integration-tests/src/harness/ws-latency.ts`, opt-in by environment variable. With it, confirm stock fails and the default passes at full cost.
