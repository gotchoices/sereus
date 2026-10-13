description: The test relay that stands in for the deployed relay now uses the deployed relay's liveness and connection settings, so the slow two-phone test no longer fails because the stand-in drops connections the real relay would keep. The deployed relay's answer to liveness pings now waits longer than the pinging side does, so it is no longer the first to give up.
architecture: docs/testing.md
files: packages/integration-tests/src/harness/dedicated-relay.ts, ops/docker/libp2p-infra/src/main.ts, packages/integration-tests/src/harness/ws-latency.ts, packages/integration-tests/src/scenarios/joiner-first-commit-over-slow-relay.integration.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-peer-redial.ts, packages/cadre-core/src/strand-first-sync-gate.ts, packages/integration-tests/package.json, yarn.lock, docs/testing.md, docs/architecture.md, tickets/backlog/debt-libp2p-nodes-built-outside-cadre-core-miss-the-ping-defaults.md, tickets/fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings.md
----

# Harness relay at parity with the deployed relay; deployed relay's ping handler outlasts its deadline

## What landed

- **Harness relay** (`harness/dedicated-relay.ts`, `createRelayNode`): the deployed relay's connection monitor (ping every 35 s, deadline pinned at 30 s), its 17.5 s dial and inbound-upgrade limits, and its ping service with a 60 s handler timeout (`PING_HANDLER_TIMEOUT_MS`). `prefixLogger('relay')` separates the relay's debug lines from the cadre nodes' in the same process. The header lists the monitor and the ping service as part of the parity contract, with the reasons.
- **Deployed relay** (`ops/docker/libp2p-infra/src/main.ts`): `ping({ timeout: 60_000 })`. `@libp2p/ping`'s inbound handler resets a ping stream when its own timer fires (10 s by default), and the pinging node's monitor then aborts the connection whatever deadline it was given, so the handler timeout has to stay above every pinging node's 30 s deadline.
- **Dependencies:** `@libp2p/logger ^6.2.13` and `@libp2p/ping 3.1.13` (exact, matching the linked Optimystic's resolution; a caret range pulled a second `@libp2p/interface`) in `@serfab/integration-tests`.
- **Comments and docs:** the handler-timeout rule in `DEFAULT_CONNECTION_MONITOR`'s comment and `docs/architecture.md`; the "a frame is not a message" item in `ws-latency.ts`'s header; the scenario header's third-arm mechanism and arm durations in the header and `docs/testing.md`; `NOTE:` tripwires in `strand-peer-redial.ts` (`nextBackoff`) and `strand-first-sync-gate.ts`.
- **Follow-up filed by implement:** `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings` — with the relay answering pings, the slow-link arms take 2–4× longer (fourth arm 228–472 s against 114–123 s without), mechanism unknown. The upstream half (every cadre node's 10 s ping handler) is `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`.

## Review findings

Read the diffs of `ticket(implement): slow-relay-joiner-strand-connection-keeps-dropping` and of `ticket(fix): slow-relay-joiner-strand-connection-keeps-dropping` (which landed the monitor, the limits and `prefixLogger` in the fixture, plus the `ws-latency.ts` byte and frame-size counters) before the handoff.

**Checked and correct.**
- `@libp2p/ping` 3.1.13's `timeout` init sets exactly the inbound handler's abort timer (`ping.js`, `handlePing`), and the ops container's installed copy (3.1.13 under its own `node_modules`, range `^3.1.4`) honours the same option. The 60 s handler against the 30 s deadline holds on every node that pings the relay today.
- The harness constant and the ops literal agree (60 000). They live in packages with no shared code, the same arrangement as the monitor values already copied by hand; no shared constant is possible without a dependency the ops container deliberately does not have.
- Lockfile: one new entry (`@libp2p/ping@npm:3.1.13`); `@libp2p/logger ^6.2.13` joins the existing 6.2.13 entry; still one `@libp2p/interface` (3.3.0).
- Resource cost of the 60 s handler on the deployed relay: one timer and one closure per inbound ping, held up to 60 s. The listener is never removed, but `abort` is a no-op on a closed stream (`abstract-message-stream.js`), so at most about two timers per connection live at once. Negligible at the 500-reservation cap; no note needed.
- Fixture behaviour: `blind-relay-phone-to-phone-e2e` 3/3, `strand-circuit-same-party-e2e` 1/1, `joiner-first-commit-over-slow-relay` loopback arm 1/1 (run in review). `yarn workspace @serfab/integration-tests typecheck` and eslint on the changed sources pass. The long slow-link arms were not re-run in review; the implement-stage runs in the handoff (fourth arm 4/4, fifth 2/2, third an expected failure) stand, and my edits since are comments only.
- Error handling, type safety: `RelayServices` gains `ping: Ping`, so no casts; nothing new can throw.

**The main judgment call — keeping the fixture's ping service despite the 2–4× slowdown.** Agreed with the implementer. Parity with the deployed relay is the fixture's stated contract, the deployed relay has always answered pings, and dropping the service would make the fixture hide whatever costs real phones those minutes. The cost is tracked by `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings`, which has this ticket as its prereq and so runs next. The thin margin under the 600 s first-sync gate is recorded as a tripwire (below), not a reason to diverge.

**Minor, fixed in this pass.**
- `docs/testing.md`, "The libp2p family follows the linked `@optimystic/db-p2p`": the list of exact pins now names `@libp2p/ping` beside `@libp2p/identify` and `@libp2p/webrtc`, so the next Optimystic bump moves it too.
- `docs/testing.md`: the new reference to the follow-up named its stage folder (`fix/…`), which goes stale when the ticket moves; now the slug alone, as the docs rule asks.
- Scenario header: "so it no longer cuts circuits" narrated a before-state; now states the current behaviour.
- `blocked/optimystic-ping-handler-timeout-below-the-monitor-deadline`: its `files:` entry still described the ops relay as `ping()` and pointed at this ticket's `implement/` stage; now says what the relay sets and calls it the precedent for the proposed Optimystic option.
- `fix/slow-link-joiner-first-sync-slower-when-relay-answers-pings`: added two facts the next agent needs — the handler's never-removed timer (read, ruled out unless a ping stream stays open 60 s), and that a first sync past 600 s would keep the third arm's `it.fails` green for the wrong reason, hiding the "bug fixed" signal.

**Tripwires.**
- The slow-link arms' first sync reached about 400 s against the 600 s `FIRST_SYNC_MS` gate: `NOTE:` at `FIRST_SYNC_MS` in `joiner-first-commit-over-slow-relay.integration.ts`, pointing a future timeout at the fix ticket rather than at raising the gate.
- The implementer's two tripwires (`strand-peer-redial.ts` `nextBackoff`, the closed-muxer relay connection; `strand-first-sync-gate.ts`, probes dialing an unreachable founder through the relay) are well-formed conditional concerns; kept as written.

**Tests.** None added and none cut. The change is configuration and comments; the scenario's slow-link arms are its regression check. A spec asserting the fixture's handler timeout exceeds cadre-core's `DEFAULT_CONNECTION_MONITOR` deadline was considered and declined: it would pin two constants, and the relation that matters in production is the ops container's, which no test here can see.

**Major findings / new tickets.** None. The one open cost (the slowdown) already has its ticket; the upstream handler timeout already has its blocked proposal.

**Source hygiene.** No file grew past a size concern from this change (comment-only additions outside the fixture). New comments state constraints and reasons, not narration.
