description: In the test that imitates two slow phones talking through a relay, the test's stand-in relay drops the phones' connections far sooner than the real deployed relay would, so the joining phone keeps losing its link mid-sync. Give the stand-in the deployed relay's settings, which makes both failing cases pass, and give the deployed relay the one setting both were still missing.
architecture: docs/testing.md
files: packages/integration-tests/src/harness/dedicated-relay.ts (createRelayNode ~93; monitor and connection-manager limits now set, ping service and header comment still to do), ops/docker/libp2p-infra/src/main.ts (`ping: ping()` ~97, connectionMonitor ~152), packages/integration-tests/src/harness/ws-latency.ts (frame-size buckets added to the summary line; header to update), packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts (file header paragraphs on the relay's stock monitor), packages/cadre-core/src/types.ts (DEFAULT_CONNECTION_MONITOR ~665, comment), packages/cadre-core/src/strand-peer-redial.ts (NOTE to add), packages/cadre-core/src/strand-first-sync-gate.ts (NOTE to add), docs/testing.md (the joiner-first-commit line ~685), docs/architecture.md (~2082), tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md (third arm section to trim), packages/integration-tests/package.json (add `@libp2p/ping`, `@libp2p/logger`)
prereq:
difficulty: medium
----

# Slow-relay joiner: give the fixture relay the deployed relay's liveness settings, and the deployed relay a ping handler that outlasts its own deadline

## What the fix stage found

The two failing arms of `joiner-first-commit-over-slow-relay.integration.ts` (fourth: restart on an undelayed link; fifth: restart still on the slow link) fail because the harness relay (`harness/dedicated-relay.ts`) cuts the circuit between the two strand nodes every 10 to 60 s. Two separate mechanisms do the cutting. Both were reproduced on 2026-10-12; logs in `tickets/.logs/slow-relay-joiner-strand-connection-keeps-dropping.exp{1,2,3}.log` (pruned after 14 days).

**1. The fixture relay runs libp2p's stock connection monitor (ping every 10 s, 5 s deadline).** On the arms' link (20 ms per-frame `serial` cap, event loop 70% busy) a strand node's outbound frames queue 10 to 22 s deep in its socket, so the relay's 5 s ping deadline expires on nearly every ping and the relay aborts its connection to that node. The deployed relay (`ops/docker/libp2p-infra/src/main.ts`) pins a 30 s deadline with a 35 s interval and 17.5 s dial and inbound-upgrade limits; the fixture's header says matching it is the fixture's contract, and did not. With those three settings copied into the fixture (already in the working tree, see below): fourth arm passed in 125.8 s (joiner writable 92 s after launch, rows on the founder 17.8 s after the restart), fifth arm passed in 156.1 s (rows on the founder 43.1 s after the restart). One run each. The ticket's second hypothesis, that removing the cuts lets something saturate the link for 450 s, did not reproduce: those runs sent 3 885 and 5 505 frames in total (the harness summary line), against the 20 000 the hypothesis was built on, which the stock-relay runs also reached only because they ran for 10 minutes.

**2. The ping handler on the node being pinged has its own 10 s timeout.** `@libp2p/ping` 3.1.13's inbound handler aborts the ping stream 10 s after it opens (`TIMEOUT = 10000` in its `constants.js`); the pinging node's monitor then sees `StreamResetError` and aborts the connection, whatever deadline it was given. Every cadre node runs that handler bare (Optimystic's `libp2p-node-base.ts`, `ping: ping()`), and so does the deployed relay. Even with fix 1 in place, the fourth arm logged 8 such aborts and the fifth 11, all resets or EOFs, none timeouts; the strand member redial reconnected after each. A two-node reproduction (handler timeout 100 ms against a 30 s monitor deadline on a 150 ms serial link: dropped within 14 s; handler timeout 10 s: kept) confirmed the mechanism. The cadre-node half is upstream and filed as `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`; the relay half is this repo's and is part of this ticket. The arms pass without it.

**Third arm** (`it.fails`, the solo commit): under fix 1 the joiner became writable after 84.9 s and committed alone in 0.0 s, so it keeps failing for the reason `blocked/optimystic-write-made-alone-owes-no-one` owns. Run under fix 1 on 2026-10-12: reported as an expected failure after 285 s, with 8 ping-failure aborts, so the `it.fails` stays valid.

**Also observed, not fixed here:**

- Every Noise packet leaves the WebSocket as two frames: a 2-byte length prefix and the ciphertext are separate entries of the `Uint8ArrayList` that `@libp2p/websockets`'s `websocket-to-conn.js` sends one `send()` call each. Of the frames the harness delays, about 90% are 64 bytes or smaller, so the 20 ms `serial` cap costs at least 40 ms per message. The new byte and size-bucket counters on the summary line show this; the header of `ws-latency.ts` should say it, since a `serial` figure is otherwise read as one frame per message.
- The listener side of `@libp2p/websockets` 10.1.21 cannot send a reset: `sendReset()` calls `websocket.close(1006)` and the `ws` package rejects 1006 (`First argument must be a valid error code number`). When the relay aborts a connection, the client keeps a connection whose muxer is closed until its own monitor notices, up to 65 s; its dials through the relay meanwhile fail with `The connection muxer is "closed"`, the first redial failure the fix ticket lists. Filed as a second arm of `blocked/report-libp2p-websockets-buffered-amount` (the same upstream file); park a `NOTE:` in `strand-peer-redial.ts` beside its existing notes, naming the symptom.
- The joiner's first-sync probe (`strand-first-sync-gate.ts`, every 500 ms) dials the founder through the relay on every probe while the founder is unreachable: 17 `hop connect denied` in about 10 s in one run, each a few frames on the joiner's relay socket. Fine now; `NOTE:` it as a tripwire: if the joiner's relay socket ever shows saturated while no member is connected, hold the probe while the member redial reports nothing connected.

## Design

- The fixture relay matches the deployed relay in every setting that decides whether a circuit lives: connection monitor, connection-manager limits, and the ping service with the same handler timeout. Its header comment currently calls the missing `ping()` a divergence that is "not load-bearing"; it is load-bearing, because the deployed relay's handler timeout decides when every circuit through it dies.
- The deployed relay's ping handler timeout is strictly above its monitor deadline (recommend `ping({ timeout: 60_000 })`, twice the 30 s deadline, with the one-paragraph reason: the handler's timer only frees a stream whose dialer went silent, and the dialer's own deadline already resets that stream). The fixture carries the identical value.
- `prefixLogger('relay')` from `@libp2p/logger` on the fixture relay's node, so a run under `DEBUG='relay:libp2p:*'` separates the relay's lines from the four cadre nodes' in the same process; without it no abort can be attributed. Already in the working tree.
- No determinism edition, byte-format vector, golden fixture or migration is involved; the change is libp2p configuration on two nodes and harness reporting.
- Do not raise `FIRST_SYNC_MS` or `CONVERGE`, do not narrow the arms' link shape, and do not change the third arm's `it.fails` or the fourth and fifth arms' `it`.
- The ops relay's monitor values stay the reference; only its ping service gains a timeout.

## State of the working tree when this ticket was written

`dedicated-relay.ts` has the monitor and connection-manager settings with a short comment pointing at the ops file, and the `prefixLogger` import; `ws-latency.ts` has the byte and size-bucket counters. `@libp2p/logger` is not yet declared in `packages/integration-tests/package.json` (it resolves from the hoisted root install). Neither file has its header updated. Typecheck and lint pass on both.

## TODO

- In `createRelayNode`, add `ping({ timeout })` from `@libp2p/ping` with the same value the ops relay gets; add `@libp2p/ping` and `@libp2p/logger` to `packages/integration-tests/package.json` and run `yarn install` at the root (never in a sibling repo).
- Rewrite the fixture's header: the ping service is part of the contract, state the handler-timeout rule, and keep the remaining divergences (no raw TCP listener, in-memory key) listed as before.
- `ops/docker/libp2p-infra/src/main.ts`: `ping({ timeout: ... })` strictly above the monitor deadline, with the reason, next to the monitor comment. Build that container's TypeScript if it has a check script (`ops/docker/libp2p-infra/package.json`).
- `ws-latency.ts` header: the two-frames-per-Noise-packet fact and what it means for a `serial` figure; keep the new counters on the summary line (zeroed by `resetStats`, already done).
- `joiner-first-commit-over-slow-relay.integration.ts` header: the paragraphs that explain the third and fifth arms by the harness relay's stock monitor are now history; name the fix ticket and state the current shape (the circuit still drops on the ping handler timeout, `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`, and the member redial reconnects). Update the arm durations in `docs/testing.md` (~685) from the measured runs.
- `types.ts` `DEFAULT_CONNECTION_MONITOR` comment: add the handler-timeout rule as a third cap on the deadline, pointing at the blocked ticket; `docs/architecture.md` ~2082 if it restates the 30 s claim.
- `NOTE:` tripwires: `strand-peer-redial.ts` (dead relay connection after a listener-side abort, the `muxer is "closed"` redial) and `strand-first-sync-gate.ts` (probe dials while unreachable).
- Trim the "Third arm" section of `backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults` to a pointer at this ticket; its 2026-10-12 update is settled by it too.
- Re-run every default scenario on `startDedicatedRelay` after the relay change (the fix stage ran them once; see the results appended below if present): `blind-relay-phone-to-phone-e2e`, `strand-circuit-same-party-e2e`, `strand-relay-only-restart-reconverges`, and the loopback, 100 ms and sixth arms of `joiner-first-commit-over-slow-relay`. Run the fourth and fifth arms twice more each; report durations and the `aborting connection` count per arm under `DEBUG='libp2p:connection-monitor*,relay:libp2p:connection-monitor*'`.
- Delete nothing in `tickets/.logs`; the pruner owns it.

## Scenarios on `startDedicatedRelay` re-run by the fix stage (2026-10-12, relay monitor and connection-manager settings in place, one run each)

- `blind-relay-phone-to-phone-e2e`: 3 of 3 passed.
- `strand-circuit-same-party-e2e`: 1 of 1 passed.
- `strand-relay-only-restart-reconverges`: 2 of 2 passed, the two opt-in arms skipped.
- `joiner-first-commit-over-slow-relay`: loopback arm passed (joiner writable after 0.6 s); 100 ms `pipelined` arm passed (writable after 6.8 s); sixth arm passed (`strand:commit-held` 7.5 s after the restart); third arm an expected failure after 285 s; fourth arm passed in 125.8 s; fifth arm passed in 156.1 s.
- Not run: `relay-round-trip-measure`, `relayed-dial-cost-by-latency`, `strand-reattach-first-sync-measure` (all opt-in measurements).

Log: `tickets/.logs/slow-relay-joiner-strand-connection-keeps-dropping.regress.log`.
