description: Relay tests can now be run with a realistic network delay instead of only on the instant local machine, and the two-phones-through-a-relay test now runs a second time with a 10 ms delay so that case is checked against something closer to a real connection.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (the fixture; exports `installWsLatency`)
  - packages/integration-tests/src/harness/index.ts (re-exports it)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (one body, two arms)
  - docs/testing.md ("Where measurements live"; topology coverage map)
  - tickets/backlog/debt-relay-scenarios-never-see-link-latency.md (trimmed to the asymmetric half that is still open)
  - tickets/blocked/report-issue-13-latency-threshold-is-a-harness-artifact.md (repro commands; frame-count caveat)
  - tickets/blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips.md (repro command; frame-count caveat)
----

# Link-latency fixture, and a relay scenario arm that uses it

Test infrastructure only. No production code changed, and no `packages/*/src` outside `integration-tests` was touched. Nothing here fixes a defect — the investigation behind it concluded there is no correctness bug in gotchoices/sereus#13 — it closes a coverage gap.

## What landed

`installWsLatency({ delayMs, mode })` in `harness/ws-latency.ts` swaps the global `WebSocket` constructor for one that holds each outbound frame, and returns a handle with `restore()`. The shim reads a live `delayMs` / `mode` per frame, so an install never re-wraps an already-wrapped constructor — that would double-count frames and double-report `bufferedAmount`, which libp2p gates its backpressure on. `WS_SEND_DELAY_MS` (even `=0`) pins the process and a scenario's own request is logged and ignored, so an investigation can sweep a scenario across delays without editing it; `WS_FRAME_STATS=1` installs counters only and a later programmatic install takes them over. A second programmatic install while one is live throws.

The module is re-exported from the harness barrel. With no environment variable set, importing it instruments nothing, and vitest's `pool: 'forks'` with `isolate` left at its default gives every scenario file its own process — so the process-wide swap cannot reach another scenario. That isolation is the load-bearing assumption behind putting it in the barrel, and it was confirmed against `packages/integration-tests/vitest.config.ts` rather than assumed.

`blind-relay-phone-to-phone-e2e` now runs the same journey twice from one body — `runBlindRelayPhoneToPhone(latency?)` — once on bare loopback and once at 10 ms, with `restore()` in the `finally` after the nodes stop. `docs/testing.md` gained the delay sweep and the `pipelined` vs `serial` warning, and the topology map's two relay lines now say which one runs with latency.

Per-node delay was accepted as out of reach: the global-constructor swap cannot tell one node's sockets from another's. `backlog/debt-relay-scenarios-never-see-link-latency` was rewritten down to that asymmetric half, carrying the port-keyed design as the recommendation and the TCP-proxy failures as the rejected option.

## Review findings

Reviewed the implement diff first, then the fixture and scenario as written, then ran them.

**Checked and clean.** Install/restore lifecycle and the double-install guard; env-pin precedence and the stats takeover; zero-delay passthrough leaving baseline timing untouched; frame ordering in both modes; `bufferedAmount` reporting the shim's own queue plus the native one; a socket closing while a frame waits its turn; the arms' teardown ordering; the barrel's reach and the vitest isolation it depends on. No correctness defect in the delay injection itself.

**Fixed in this pass (minor).**

- *A stale handle could tear down a later install.* `restore()` tested a shared `programmaticInstall` boolean, so handle A restored a second time after arm B had installed would have unwrapped B's install and left B measuring a delay it did not ask for — silently, as a passing test, which is the exact failure the double-install guard exists to prevent. Each install now carries its own token and `restore()` is a no-op unless its own install is still in force. Not reachable from either current caller; fixed because it is three lines at the site and the failure mode is invisible.
- *Mannered prose.* The latency arm's `NOTE:` ended "the delay is only a dial" — the metaphor `AGENTS.md` names as its worked example of what not to write. Restated literally.
- *Source hygiene.* The four-line stats-reset run inlined in `installWsLatency` became `resetStats()`, and three `console.log(summaryLine())` sites became `reportSummary()`, which also records what was last printed so a progress tick with no new frames is skipped.
- *Stale reproduction commands.* The scenario file gained a second test, so the commands quoted in two `blocked/` tickets and the sweep in `docs/testing.md` no longer do what their surrounding text says. Corrected in place, including which summary line is the baseline.

**Recorded as a tripwire, not filed.** The environment path has no end-of-run summary: every line it prints is a running subtotal, and a scenario finishing inside one 5 s tick prints nothing at all. This is not new in this diff and it does not affect the committed arm, whose `restore()` prints an accurate closing line. It is also not fixable inside the module — `exit` and `beforeExit` output never reaches the terminal from a vitest fork worker, verified with a probe spec, and traffic never goes quiet before teardown, so neither an exit handler nor a quiet-tail timer works. A `NOTE:` at the reporting site records this along with the way out if a scenario ever needs it (an explicit `reportWsFrameStats()` the scenario calls), and `docs/testing.md` now says which line to read.

**Escalated in place, not filed as a ticket.** The 4,735-frame baseline quoted in `docs/testing.md`, in the draft external reply in `blocked/report-issue-13-latency-threshold-is-a-harness-artifact`, and as the divisor behind "four to five times the frames for identical work" in `blocked/optimystic-strand-operations-cost-dozens-of-relay-round-trips`, does not reproduce. Measured at the one boundary that declares an exact total — the latency arm's install, which prints the accumulated counters before zeroing them — the loopback journey costs 11,939 and 12,531 frames over two runs and the 10 ms `pipelined` arm 12,200 and 13,760: adding 10 ms does not multiply the frame count on this machine. The windows are not identical (the boundary-declared one also covers the loopback arm's teardown), so this is grounds to re-measure, not proof the older figure is wrong, and it is written up that way at all three sites. No new ticket: both sites are already `blocked/` tickets awaiting a human, and the decision at stake — what to send an external issue reporter — is already theirs. The 10 ms-threshold conclusion the reply is actually about does not depend on the frame count.

**No new tests.** Agreed with the implementer's judgement, and the one defect found does not change it: it is in the fixture's own install bookkeeping, so a test for it would assert on the fixture rather than on any product behaviour. The latency arm itself is the test this ticket exists to add.

## Validation

`yarn workspace @serfab/integration-tests typecheck`, `yarn lint`, `yarn dep-check` — all clean (`WsLatencyMode` appears in knip's informational unused-exported-types list alongside ~55 pre-existing entries; it is part of the fixture's public shape).

The scenario in four configurations, all passing: default (loopback arm 3.0–3.6 s, latency arm 7.7–8.9 s); `WS_FRAME_STATS=1`; `WS_FRAME_STATS=1` narrowed to one test; `WS_SEND_DELAY_MS=0`, which logs the pin and runs both arms at zero delay. Worst observed send wait 78–117 ms against a configured 10 ms, versus gates of 60 s for convergence and 20 s for the join. `strand-circuit-same-party-e2e` and the package's 48 unit specs pass.

Not run: the full integration scenario suite and root `yarn test`, both beyond the ten-minute agent budget — the same deferral the implement stage made. The change is confined to one scenario plus a barrel line that is inert unless called, and typecheck covers the barrel's reach.

## Worth knowing afterwards

The latency arm roughly doubles this file's wall clock (about 28 s, from ~15 s), judged worth it for the suite's only non-instant relayed coverage. 10 ms is a developer machine's margin: the binding gate is the 20 s `JOIN_FINISH_MS`, which 100 ms of delay already misses, so CI flakiness here should be answered by lowering `LINK_LATENCY_MS`, not by loosening that gate. `restore()` does not un-instrument sockets already constructed — they keep the shim class but read the live delay, so this only matters to a future caller that restores with traffic in flight. `close()` is deliberately not delayed, matching the injector in issue #13; a teardown-shaped failure should suspect that first.
