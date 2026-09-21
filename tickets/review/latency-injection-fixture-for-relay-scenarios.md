description: Relay tests can now be run with a realistic network delay instead of only on the instant local machine, and the two-phones-through-a-relay test now runs a second time with a 10 ms delay so that case is checked against something closer to a real connection.
architecture: docs/testing.md#topology-coverage-map
files:
  - packages/integration-tests/src/harness/ws-latency.ts (the fixture; now exports `installWsLatency`)
  - packages/integration-tests/src/harness/index.ts (now re-exports it)
  - packages/integration-tests/src/scenarios/blind-relay-phone-to-phone-e2e.integration.ts (one body, two arms)
  - docs/testing.md ("Where measurements live"; topology coverage map)
  - tickets/backlog/debt-relay-scenarios-never-see-link-latency.md (trimmed to the asymmetric half that is still open)
----

# Review — link-latency fixture, and a relay scenario arm that uses it

Test infrastructure only. No production code changed, and no `packages/*/src` outside `integration-tests` was touched. The investigation this came from concluded there is **no correctness bug** behind gotchoices/sereus#13 — the reported 10 ms threshold is an artifact of the reporter's injector — so nothing here fixes a defect; it closes a coverage gap.

## What landed

**`installWsLatency({ delayMs, mode })`** in `harness/ws-latency.ts`. It swaps the global `WebSocket` constructor for one that holds each outbound frame, and returns a handle with `restore()`. The shim reads a live `delayMs` / `mode` per frame, so an install never re-wraps an already-wrapped constructor — that would double-count frames and double-report `bufferedAmount`, which libp2p uses for backpressure.

Precedence, deliberately: `WS_SEND_DELAY_MS` (even `=0`) **pins the process** and a scenario's request is logged and ignored, so the investigation's sweep commands still reproduce verbatim without editing the scenario. `WS_FRAME_STATS=1` alone installs counters only, and a later programmatic install takes them over (printing the running totals before zeroing them) rather than erroring. A second programmatic install while one is live **throws** — two arms silently sharing a delay neither asked for is exactly the failure this fixture exists to rule out, and it would surface as a passing test.

**Re-exported from `harness/index.ts`.** The old objection (a side-effect module in the barrel reaches every scenario) no longer bites: with no environment variable set, importing the module instruments nothing. When one *is* set it applies process-wide, which is what a process-wide environment variable means.

**The scenario now runs the same journey twice from one body.** `runBlindRelayPhoneToPhone(latency?)` holds what was previously the `it()` body, unchanged except for dedenting; the two `it()`s call it with and without latency. `restore()` is in the `finally`, after the nodes stop, so a failing arm hands the next one a clean constructor instead of burying its error under "already installed".

**Documentation.** `docs/testing.md` gained the full delay sweep under "Where measurements live" (with the `pipelined` vs `serial` warning stated once, since a number quoted without its mode is wrong by an order of magnitude), and the topology map's two relay lines now say which one runs with latency and that the other is loopback-instant.

## The per-node question, decided

**Accepted process-wide.** The delay applies to every node in the test process; "a slow phone talking to a fast desktop" is not expressible. Reasons: everything-is-slow is the harsher case and matches the phone-to-phone topology the arm covers; the port-keyed alternative (give `DedicatedRelay` several listen addresses, key the delay off the destination port in the dial URI) is a real change to the relay fixture that has not been prototyped; and the TCP-proxy approach is already recorded as failed. The module header states the limitation at the top.

`backlog/debt-relay-scenarios-never-see-link-latency` was therefore **not deleted** — it was rewritten down to the asymmetric half only, carrying the port-keyed design as the recommendation and the proxy failures as the rejected option.

## Tests

| test | what it pins |
|---|---|
| `blind-relay-phone-to-phone-e2e` → "forms the same strand and replicates both ways over a link with 10 ms of latency" | Two strangers, each on a machine that cannot listen, form a closed strand through a shared relay and replicate rows both ways **when the link is not instant**. Nothing else in the suite runs a relayed path at anything but loopback speed, so a change that made relayed formation, seeding or the joiner's membership reconciliation far more latency-sensitive currently passes everything. |

No unit test for `installWsLatency` itself. Its branches are install/restore bookkeeping around a global swap, and a test would have to assert on the fixture rather than on product behaviour; the branches were instead exercised by running the scenario under each environment configuration (below). Disagree freely — that is a judgement call, not a constraint.

## Validation run

- `yarn workspace @serfab/integration-tests typecheck` — clean. `yarn lint` — clean. `yarn dep-check` — exit 0 (knip's informational unused-export list gained `WsLatencyMode`, alongside ~55 pre-existing entries; it is part of the fixture's public shape).
- The scenario, **four times**: zero-delay arm 3.7 / 3.9 / 5.7 / 7.4 s, latency arm 9.7 / 9.3 / 11.6 / 12.4 s, all passing. Worst observed send wait 131–315 ms against a configured 10 ms (timer slop plus machine load). Gates are 60 s for convergence and 20 s for the join, so the margin is roughly 5×.
- `WS_FRAME_STATS=1` run — counters install at module evaluation, the baseline arm counts, the latency arm takes them over and prints the prior totals first. Both arms pass.
- `WS_SEND_DELAY_MS=0` run — logs `pins this process; ignoring requested 10 ms` and both arms run at zero delay in 3.8 s and 3.1 s. The reproduction commands in `blocked/report-issue-13-latency-threshold-is-a-harness-artifact` still work; note they now run *two* tests, and under `WS_SEND_DELAY_MODE=serial` both are expected to fail, which is the reported behaviour.
- `strand-circuit-same-party-e2e` (the other relay scenario, same harness barrel) — passes. The package's own unit specs (`test/`, 4 files, 48 tests) — pass.
- **Not run:** the full integration scenario suite or root `yarn test`. Both exceed the ten-minute agent budget. The change is confined to one scenario plus a barrel line that is inert unless called, and typecheck covers the barrel's reach.

## Worth a reviewer's attention

- **The arm doubles this file's wall clock** (28–44 s for the file, from ~15 s). Judged worth it for the only non-instant relayed coverage in the suite; a reviewer who disagrees would drop the arm, not the fixture.
- **10 ms is a developer machine's margin.** A `NOTE:` at the arm records the tripwire: the binding gate is the 20 s `JOIN_FINISH_MS`, which 100 ms of delay already misses, so if slower CI hardware makes this flaky the fix is a smaller delay, not a looser gate — that gate is a product claim about join latency.
- **`restore()` does not un-instrument sockets already constructed.** They keep the shim class but read the live delay, so they send straight through afterwards. Nodes are stopped before `restore()` in the scenario, so this only matters to a future caller that restores with traffic in flight.
- **`close()` is still not delayed** (unchanged, deliberate, documented at the module header): it matches the injector in issue #13 so the numbers stay comparable. A teardown-shaped failure should suspect this first.
- **Frame counts are process-wide and reset per install**, so a lingering socket from a previous arm can land frames in the next arm's totals. The install now prints the previous totals before zeroing, which is the part that was actually at risk of being lost.
