description: The test relay that stands in for the deployed relay now uses the deployed relay's liveness and connection settings, so the slow two-phone test no longer fails because the stand-in drops connections the real relay would keep. The deployed relay's answer to liveness pings now waits longer than the pinging side does, so it is no longer the first to give up.
architecture: docs/testing.md
files: packages/integration-tests/src/harness/dedicated-relay.ts, ops/docker/libp2p-infra/src/main.ts, packages/integration-tests/src/harness/ws-latency.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/integration-tests/package.json, yarn.lock, docs/testing.md, docs/architecture.md, tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md, tickets/fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings.md
----

# Review: harness relay at parity with the deployed relay; deployed relay's ping handler outlasts its deadline

## What changed

- **Harness relay** (`harness/dedicated-relay.ts`, `createRelayNode`): the deployed relay's connection monitor (ping every 35 s, deadline pinned at 30 s), connection-manager limits (17.5 s dial and inbound upgrade), and now the ping service, `ping({ timeout: PING_HANDLER_TIMEOUT_MS })` at 60 s. `prefixLogger('relay')` so `DEBUG='relay:libp2p:*'` picks the relay's lines out of the four cadre nodes' in the same process. The header lists the monitor and the ping service as part of the parity contract, with the reason; "no `ping()`" is gone from the divergences.
- **Deployed relay** (`ops/docker/libp2p-infra/src/main.ts`): `ping: ping({ timeout: 60_000 })`, with the reason at the service and a pointer from the monitor comment. `@libp2p/ping`'s inbound handler resets a ping stream when its own timer fires (10 s by default), and the pinging node's monitor then aborts the connection whatever deadline it was given. With 60 s, a client's own 30 s deadline is the first to give up. `tsc --noEmit` passes (the file is `@ts-nocheck`, so that checks syntax only).
- **Dependencies:** `@libp2p/logger ^6.2.13` and `@libp2p/ping 3.1.13` added to `@serfab/integration-tests`. Ping is **pinned exactly**: `^3.1.13` resolved to 3.1.14, which pulled a second `@libp2p/interface` (3.3.1 beside 3.3.0), the drift `docs/testing.md` ("The libp2p family follows the linked `@optimystic/db-p2p`") warns about. 3.1.13 is what the linked Optimystic installs. The lockfile adds one entry.
- **`ws-latency.ts` header:** a fourth "what a number means" item. A frame is not a message: `@libp2p/websockets` sends each list entry as its own frame and Noise hands it at least two per packet (length prefix, ciphertext), so a `serial` cap costs at least twice its per-frame delay per message. The byte and frame-size counters on the summary line were already in the tree.
- **Comments and docs:** the `DEFAULT_CONNECTION_MONITOR` comment (`types.ts`) gains the handler-timeout rule as a further cap on the deadline, pointing at `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`. `docs/architecture.md`'s `connectionMonitor` note says the same in one sentence. The scenario header's third-arm explanation now describes the current mechanism (the 10 s handler on cadre nodes, every ~40 s) instead of the harness relay's stock monitor, and the fifth arm's figure is updated. The arm durations in `docs/testing.md` are updated.
- **`NOTE:` tripwires:** `strand-peer-redial.ts` `nextBackoff` (a relay that aborts its connection to this node cannot say so, the `muxer is "closed"` redial failures, and what to do if rounds keep failing that way). `strand-first-sync-gate.ts` class doc (the probe's reads dial the founder through the relay while it is unreachable: 17 `hop connect denied` in about 10 s in one run).
- **Backlog:** the third-arm section of `debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults` is cut to a pointer here, and its two relay `files:` entries are removed.

No tests were added. The change is libp2p configuration and comments; the scenario arms that failed are the regression check.

## Validation runs (2026-10-12, final configuration unless marked)

- `blind-relay-phone-to-phone-e2e` 3/3, `strand-circuit-same-party-e2e` 1/1, `strand-relay-only-restart-reconverges` 2/2 (2 opt-in skipped).
- `joiner-first-commit-over-slow-relay`: loopback passed (writable 1.1 s); 100 ms `pipelined` passed (writable 6.9 s); sixth arm passed (`strand:commit-held` 7.8 s after restart); third arm an **expected failure** after 584.9 s (joiner writable after 384.8 s, only the relay connected, committed alone in 0.0 s, so the `it.fails` still holds).
- Fourth arm, under `DEBUG='libp2p:connection-monitor*,relay:libp2p:connection-monitor*'` (aborts = `aborting connection due to ping failure`, relay's own in brackets): **472.1 s** (36 [4]), **228.9 s** (17 [3]), **227.6 s** (20 [3]), **236.5 s** (20 [3]). All passed.
- Fifth arm: **420.3 s** (52 [7], rows 47.6 s after restart), **372.6 s** (30 [5], rows 211.0 s after restart). Both passed.
- Every abort was `StreamResetError`, `UnexpectedEOFError` or `ConnectionClosedError` except a few `AbortError`s, mostly after the arm finished. The relay's aborts are all `StreamResetError`: the cadre node's 10 s ping handler resetting the relay's ping, which is the upstream half.
- `yarn workspace @serfab/integration-tests typecheck`, `yarn workspace @serfab/cadre-core typecheck`, eslint on every changed source file, and the integration-tests unit specs (49) pass. cadre-core was rebuilt for the stale-build guard (comment-only changes).

Logs: `tickets/.logs/slow-relay-joiner-strand-connection-keeps-dropping.impl-*.log` (pruned after 14 days).

## Known gap: the relay's ping service makes the slow-link arms 2–4× slower

This is the main thing to weigh. Control runs with the ping line commented out (monitor and limits kept) took **116.0, 122.7 and 113.8 s** for the fourth arm (the fix stage's run was 114.3 s), against 228 to 472 s with it. A back-to-back pair under the same machine load gave 113.8 s without and 227.6 s with. The third arm's joiner became writable after 385 s with the service against 85 s without (fix stage). Other heavy processes shared the CPU during these runs; the pairing is what controls for that.

The mechanism is not found. Ruled out: the relay's inbound ping stream cap, cadre pings to the relay timing out, Optimystic's peer classification, and `Connection.rtt`. The data and what was ruled out are in `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings` (prereq: this ticket). It matters beyond the harness because the deployed relay has always answered pings (with the 10 s handler).

Kept anyway, because the ticket's design calls for the ping service and parity is the fixture's stated contract: without the service, cadre pings to the relay come back "protocol not supported", which libp2p's monitor counts as an answer, so the fixture would hide a behaviour the deployed relay has. **Consequence:** the fourth and fifth arms are plain `it`s whose first sync is gated at `FIRST_SYNC_MS` = 600 s, and the slowest run reached about 400 s, so they can go red if a run is slower still. The ticket said not to raise `FIRST_SYNC_MS`, so it is unchanged. If the reviewer judges that margin too thin, the alternative is dropping the fixture's ping service until the fix ticket explains the cost, and listing it as a divergence again.

## For the reviewer to check

- The rule written into the ops relay, the fixture and `types.ts`: the handler timeout must stay strictly above the deadline of every node that pings the relay. 60 s against 30 s on every node today.
- That `PING_HANDLER_TIMEOUT_MS` in the fixture and the literal `60_000` in the ops file stay in step. They are separate packages with no shared code, the same arrangement as the monitor values already copied there.
- The pinned `@libp2p/ping 3.1.13`: a future Optimystic bump of its ping range has to move this pin with it, as with `@libp2p/identify 4.1.14`.
