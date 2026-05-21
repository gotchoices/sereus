---
description: Lift the upstream `@libp2p/circuit-relay-v2` per-relayed-connection caps (128 KiB / 2 min, applied by default) that were silently resetting long-lived service↔browser circuits during Tier 2 e2e runs, and enrich the `protocol-client` `dial:fail` log line with `code=…` and `msg=…` so future regressions in this surface are diagnosable from the trace alone. Production source changes live in `../optimystic`.
files: ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/db-p2p/test/circuit-relay-long-lived.spec.ts, ../optimystic/packages/db-p2p/test/protocol-client-dial-timeout.spec.ts
---

## Implementation summary

All source changes are in `../optimystic` (folded into commits `c78f85a` and `6d075ec` under unrelated ticket titles — see "Review findings" below):

- `packages/db-p2p/src/libp2p-node-base.ts` — imports `CircuitRelayServerInit`, adds an optional `relayServerInit?: CircuitRelayServerInit` field to `NodeOptions` with JSDoc explaining the upstream default (`applyDefaultLimit: true` ⇒ `Limit { data: 128 KiB, duration: 2 min }`), and threads it into the `circuitRelayServer(...)` factory in the services map.
- `packages/reference-peer/src/cli.ts` — when `effectiveRelay` is true, logs `🔁 Circuit-relay limits: disabled (reference-peer trusted)` and passes `relayServerInit: { reservations: { applyDefaultLimit: false } }` to `createLibp2pNode`.
- `packages/db-p2p/src/protocol-client.ts` — the `dial:fail` log line now includes `code=<err.code|'none'>` and `msg=<message, truncated at 200 chars with '…'>`. The `dial:timeout` branch is unchanged.
- `packages/db-p2p/test/circuit-relay-long-lived.spec.ts` (new, gated behind `RUN_LONG_TESTS=1`) — intended to be the regression spec. **Confirmed broken**, see findings.
- `packages/db-p2p/test/protocol-client-dial-timeout.spec.ts` — incidental TS7006 fix: added `(_p: CorePeerId, _proto: string, options?: AbortOptions)` annotations on three inline `connect` mocks (the bare `_p, _proto, options` parameters were implicit-any). Pre-existing breakage, not introduced by this ticket.

## Review findings

### What was checked

- **Source diff vs. ticket intent.** Read every line of the c78f85a source-file diff. The 1-line addition in `libp2p-node-base.ts`, the JSDoc block, the `relayServerInit` field declaration, the import addition, the reference-peer CLI conditional, and the `protocol-client` log enrichment all match what the ticket called for. No incidental edits riding along in those three files.
- **Upstream type/default verification.** Inspected `node_modules/@libp2p/circuit-relay-v2/dist/src/index.d.ts` (`CircuitRelayServerInit.reservations.applyDefaultLimit?: boolean`, JSDoc `@default true`) and `constants.js` (`DEFAULT_DATA_LIMIT = BigInt(1 << 17)` = 131072 = 128 KiB; `DEFAULT_DURATION_LIMIT = 2 * minute`). The implementer's claim about the upstream defaults is exactly right.
- **Sibling call-sites.** Grepped both `../optimystic` and `C:\projects\sereus` for `relay: true`, `createLibp2pNode`, `createLibp2pNodeBase`. No other production call site enables `relay: true` (the test spec is the only other one, intentionally so). Reference-peer is the only relay producer, and it is updated. No silently-skipped consumer.
- **Type safety on the new field.** `relayServerInit?: CircuitRelayServerInit` is fully typed against the upstream `@libp2p/circuit-relay-v2` shape (not `any`). The reference-peer CLI uses the structural literal `{ reservations: { applyDefaultLimit: false } }`, which the upstream interface allows. Both sites compile cleanly.
- **Log-line correctness.** `errCode` extraction guards against non-string `code` values by falling back to `'none'`. `errMessage` correctly distinguishes `Error` instances from arbitrary throws via `instanceof Error`. Truncation uses a single `…` and 200 chars matches the docstring claim.
- **Build + test.** `yarn workspace @optimystic/db-p2p build` — clean, no errors. `yarn workspace @optimystic/db-p2p test` — **446 passing, 7 pending, 0 failing**. The implementer reported 445 passing with one flaky `peer-reputation-review` failure; that failure did not reproduce this run. The 7 pending include the new long-test (skipped because `RUN_LONG_TESTS` was unset).

### What was found

#### Major: the new regression spec is non-functional

Running `RUN_LONG_TESTS=1 yarn test:verbose --grep "Circuit-relay long-lived"` (the test title's actual prefix — note the doc command in the spec's header uses the wrong pattern, see minor below) produces:

```
Error: Browser-shaped client never published a /p2p-circuit multiaddr (have: )
  at waitForCircuitListen (test\circuit-relay-long-lived.spec.ts:111:8)
```

The browser-shaped client never publishes *any* multiaddr — `have: ` is empty after the configured 15 s wait. I reproduced this with an in-place patch that bumped the timeout to 30 s and added an explicit `await client.dial(relayWs)` immediately after spawn; same failure. This means the spec, as committed, *does not exercise the surface it claims to* — the implementer's note that the spec was "written and pending — needs reviewer to run" was correct in that it was indeed pending and ran for the first time during this review, but optimistic in that it does not actually work.

The acceptance criterion "A targeted regression test holds a relayed connection productive for the configured sweep without the relay resetting it" therefore remains **unmet**.

Disposition: major → new ticket `tickets/fix/circuit-relay-long-lived-spec-never-publishes.md` with repro steps, investigation hooks, and acceptance criteria. The production source fix itself is correct on inspection — the spec just doesn't currently prove it.

#### Major: Tier 2 e2e regression not verified

The third acceptance criterion ("Tier 2 `dial:fail` rate drops below 1 % on a fresh run") was explicitly deferred by the implementer and was not re-run during this review either. Re-running it would require either Playwright e2e or the reference-app-web harness; given that the regression spec is broken (above), the source-side claim is still inspection-only. Tracked in the new fix ticket as a final-acceptance follow-up.

#### Minor: spec docstring's grep example does not match

The spec's header (lines 17-19) advises:
```
PowerShell: $env:RUN_LONG_TESTS=1; yarn workspace @optimystic/db-p2p test --grep "circuit-relay-long-lived"
```
The slug-style `circuit-relay-long-lived` matches **nothing** — the `describe` title is `Circuit-relay long-lived connections`. A copy-paste of the docstring command silently runs 0 tests and exits 0. Anyone following the documented instructions would believe the test passed when it didn't. Folded into the new fix ticket since it lives in the same file.

#### Minor: commit-trail anomaly persists

The implementer flagged that their production-source changes were folded into `c78f85a` ("ticket(implement): cohort-topic-traffic-signal") with a commit body that explicitly disclaimed code changes, and that the spec + type-annotation fix landed under two further unrelated commits (`6d075ec`, `2604493`). A `git log --grep="circuit-relay|relayServerInit|dial:fail"` returns empty against `../optimystic`. The implementer already filed `../optimystic/tickets/fix/circuit-relay-trusted-limits-followup.md` on the sibling repo to review the unsupervised landing.

Disposition: defer to the existing optimystic-side follow-up ticket. From the sereus side, the changes are reachable via the file paths in the `files:` header above and via this complete-stage ticket's review findings. Anyone bisecting "when did the relay limit change?" should grep the optimystic tree for `relayServerInit` or `applyDefaultLimit`, not the commit log. Not ideal, but the source-side review here verified the actual code; the misattribution is a process-hygiene issue, not a correctness one.

#### Minor: spec assumes connection reuse without verifying it

Even if the spec were running, its primary case loops `dialer.dialProtocol(circuitAddr, ...)` 80 times. If each iteration opens a *fresh* relayed connection rather than reusing the one libp2p established on the first dial, the 128 KiB per-circuit cap is never accumulated and the primary case would pass *even with* `applyDefaultLimit: true` — silently making the test useless. The implementer's control case (gated behind `RUN_LONG_TESTS_CONTROL=1`) is the safety net: if the control case ever fails to observe a reset, it signals the surface isn't being exercised. Folded into the new fix ticket as something to verify once the spec runs.

#### Verified clean (no findings)

- **Resource cleanup.** `afterEach` awaits `Promise.allSettled([dialer, client, relay].map(n => n.stop()))`. Three nodes stop. The `before` hook gating is per-suite, not per-test, so individual tests are skipped cleanly.
- **Type laziness / `any` usage.** The new code in `libp2p-node-base.ts` uses `CircuitRelayServerInit` directly. The spec uses `Libp2p`, `Stream`, `Connection`, `Multiaddr` — no fresh `any`. (Pre-existing `any` casts in `libp2p-node-base.ts` were not introduced here.)
- **Error swallowing.** `protocol-client.ts` `dial:fail` rethrows after logging; nothing eaten. The spec's echo handler swallows handler-side errors deliberately (the control case is what surfaces failure on the dialer side); acceptable, called out in the implementer's caveats.
- **Cross-platform.** No Node-only APIs introduced. WebSockets + circuit-relay paths work in both Node and browsers (the WS+relay shape is the browser case anyway).

## Acceptance status

- [x] `dial:fail` log line includes `code=…` and `msg=…` fields populated from the underlying libp2p error. *(Inspection + protocol-client.ts:77-85 confirmed.)*
- [ ] A targeted regression test holds a relayed connection productive for the configured sweep without the relay resetting it. *(Spec broken — tracked in `tickets/fix/circuit-relay-long-lived-spec-never-publishes.md`.)*
- [ ] Tier 2 e2e `dial:fail` rate drops below 1 % on a fresh run. *(Not re-run; tracked in the new fix ticket as a final-acceptance step.)*
