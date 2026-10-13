description: On a slow link, a phone joining a two-party strand through a relay takes two to four times longer to finish its first sync when the relay answers liveness pings than when it ignores them, and nobody yet knows why. The deployed relay has always answered pings, so this may be part of why real phones take minutes to become usable after joining.
prereq: slow-relay-joiner-strand-connection-keeps-dropping
architecture: docs/testing.md
files: packages/integration-tests/src/harness/dedicated-relay.ts (`ping: ping({ timeout: PING_HANDLER_TIMEOUT_MS })` in `createRelayNode`, the one line that changes the result), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (third, fourth and fifth arms), ops/docker/libp2p-infra/src/main.ts (the deployed relay's `ping` service), node_modules/libp2p/dist/src/connection-monitor.js (how a ping that the far end does not support counts as an answer), node_modules/libp2p/dist/src/connection.js (stream limits read from the registrar)
repro: verified
----

# A slow-link joiner's first sync takes 2–4× longer when the relay answers pings

## What is observed

`joiner-first-commit-over-slow-relay.integration.ts` runs two relay-only parties through the harness relay with every dialed WebSocket capped at one frame per 20 ms (`serial`) and the event loop kept 70% busy. The harness relay carries the deployed relay's connection monitor and connection limits. The only difference between the two columns below is whether the relay also runs `@libp2p/ping`'s service (handler timeout 60 s), as the deployed relay does.

| Arm | Relay answers pings | Relay does not answer pings |
| --- | --- | --- |
| fourth (restart on an undelayed link), whole arm | 472 s, 229 s, 228 s, 236 s | 114 s, 116 s, 123 s, 114 s |
| fifth (restart on the slow link), whole arm | 420 s, 373 s | 143 s |
| third, joiner writable after | 385 s | 85 s |

All runs on 2026-10-12, one Windows machine. The 228 s and 114 s fourth-arm runs were run back to back as a pair, because other heavy processes were sharing the CPU at the time; the pairing rules out machine load. Every run passed (the third arm as its expected failure). The fourth and fifth arms are plain `it`s whose first sync is gated at `FIRST_SYNC_MS` (600 s), so the slowest run here (about 400 s to writable) leaves a third of the margin. The third arm is an `it.fails` with the same gate: a first sync past 600 s would keep it green for the timeout rather than for the bug it reproduces, hiding the signal that the bug is fixed.

In the paired runs, the frame counts and the sequence of connection aborts are the same for the first 85 s or so. They diverge after the relay first aborts its connection to a strand node (that abort is `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`, present in both columns). Over every run logged with the first-sync debug channel, the joiner's first-sync gate opened 10, 20 and 22 s after its database build with the relay not answering pings, and 82, 142, 153 and 291 s after with the relay answering. The longer waits pass through repeated cycles of the member redial reconnecting the two strand nodes and the next ping dropping them about 40 s later.

## Ruled out

- **The relay's inbound ping stream cap** (`maxInboundStreams: 2`). A diagnostic run under `DEBUG='relay:*:ping,relay:*:error'` logged no `Too many inbound protocol streams`, and the relay's handler held its 21 pings for a median of 1.8 s, longest 24.3 s.
- **Cadre nodes' pings to the relay timing out.** Cadre monitors logged 0 to 4 `AbortError`s per run, mostly after the scenario had finished; the aborts are `StreamResetError` and `UnexpectedEOFError`, as in the other column.
- **Optimystic's peer classification.** `membershipOf` (`libp2p-key-network.ts`) already reads the relay as `foreign` from the circuit hop protocol in its peerStore record; adding `/ipfs/ping/1.0.0` to that record does not change the verdict.
- **The handler's 60 s timer outliving the ping** (read, not measured). `handlePing` in `@libp2p/ping` 3.1.13 never removes its `AbortSignal.timeout` listener, so 60 s after every ping it calls `stream.abort`, but `abort` returns at once on a stream that is already `closed` (`@libp2p/utils`' `abstract-message-stream.js`). It would matter only for a ping stream still open at 60 s.
- **`Connection.rtt`.** A successful ping stores a measured round trip on the connection where an unsupported one stores half the negotiation time, but nothing in Optimystic or cadre-core reads it.

## What differs, as far as known

Without the service, a cadre node's ping to the relay ends at protocol negotiation: the relay answers "not supported", which libp2p's monitor counts as alive (`connection-monitor.js`). With it, the ping also writes 32 bytes, waits for the echo and closes the stream, so each ping puts more frames through the node's capped socket and keeps the stream open longer. Each successful ping also merges `/ipfs/ping/1.0.0` into the relay's peerStore record on the cadre node. Neither has been shown to matter.

## Reproduce

```
cd packages/integration-tests
DEBUG='libp2p:connection-monitor*,relay:libp2p:connection-monitor*,sereus:cadre:strand-first-sync,sereus:cadre:strand-redial' yarn vitest run src/scenarios/joiner-first-commit-over-slow-relay.integration.ts -t "kept storage$"
```

Then comment out the `ping:` line in `createRelayNode` and run it again. Each run takes 2 to 8 minutes. Logs from 2026-10-12: `tickets/.logs/slow-relay-joiner-strand-connection-keeps-dropping.impl-*.log` (`-pair1-ping` and `-pair1-control` are the paired runs, `-diag-ping` the diagnostic one; pruned after 14 days).

## Expected

Whether the relay answers pings should not change how long a joiner's first sync takes. If it does for a reason that also applies to the deployed relay, that reason belongs in the relay's or the cadre nodes' configuration, not in the harness.
