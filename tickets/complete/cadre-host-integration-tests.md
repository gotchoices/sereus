---
description: cadre-host integration test suite — six scenarios that boot a real Installer + createLocalUiServer and drive it over loopback HTTP/SSE
files: packages/integration-tests/package.json, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/harness/fixtures/idle-child.mjs, packages/integration-tests/src/harness/fixtures/manifest-server.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-origin-guard.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/integration-tests/src/scenarios/cadre-host-orchestrator-lifecycle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-update-notify.integration.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/update/index.ts, docs/architecture.md
---

## Summary

Landed: six new integration scenarios under `packages/integration-tests/src/scenarios/cadre-host-*.integration.ts` (27 tests, all green ~8 s on Windows), plus shared harness (`test-cadre-host.ts`, `fixtures/idle-child.mjs`, `fixtures/manifest-server.ts`). Three pre-existing internal symbols (`readHostConfig`, `updateHostConfig`, `writeHostConfig`, `SignedManifest`) were promoted into the `@serfab/cadre-host` public surface so the harness can wire a real subsystem stack without deep imports. `@serfab/integration-tests` now depends on `@serfab/cadre-host` (`workspace:*`).

The suite exercises the seam between the installer, the four subsystems (orchestrator / trust-circle / NAT / update), and the Fastify HTTP+SSE surface — the seam that focused per-module tests deliberately fake out.

## Review findings

### What I checked

- **Diff-as-stranger pass.** Read every harness file and all six scenarios with the implement summary set aside. Confirmed: harness boots Installer → createLocalUiServer end-to-end, scenarios drive it strictly through the documented public surface (HTTP/SSE/service handles), no use of internal `__test_*` hooks. Type safety is honest — no `any` leaks in new code; the few `as X` casts on response bodies are reasonable narrowing for `unknown` HTTP payloads.
- **Cross-cutting aspects.**
  - *SPP / SRP*: harness factory is one entry; each scenario owns one slice; fixture modules each have one job.
  - *DRY*: bootstrap intentionally duplicates the harness for the "if the harness is broken, this still proves install works" property (the comment at the top of `cadre-host-bootstrap.integration.ts` calls this out). The shared harness is reused by the other five scenarios.
  - *Cleanup*: `TestCadreHost.stop()` orders teardown correctly (server → nat → update → rmSync with Windows-retry) and `cadre-host-orchestrator-lifecycle.integration.ts` defensively stops + removes any leftover child before `host.stop()`.
  - *Error handling*: scenarios assert mapped error codes (`forbidden_origin`, `not_found`, `invalid_label`, `signature_invalid`, `not_implemented`) for all four error categories the routes can produce, plus 404 for unknown nodes/tokens.
  - *Resource cleanup*: `%TEMP%\integration-cadre-host-*` is empty after a full run; SSE close releases the bus listener slot (asserted in `cadre-host-sse-events.integration.ts`); idle-child is SIGTERM-clean.
- **Test coverage of edge cases.** Walked each scenario against happy + error + boundary cases. Coverage is honest about its v1 stubs (the `/api/nodes/:id/start` 501 is asserted as such; `POST /auth/redeem` is not exposed so the trust-circle redeem step calls the service directly with an explicit comment).
- **Tests + typecheck.**
  - `yarn workspace @serfab/integration-tests vitest run …cadre-host-*.integration.ts` → 6 files / 27 tests pass in ~8.5 s.
  - `yarn workspace @serfab/integration-tests build` → clean.
  - `yarn workspace @serfab/cadre-host build:server` → clean.
  - No temp-dir leakage post-run.
- **Docs.** Read `docs/architecture.md`, `docs/cadre-host.md`, `packages/cadre-host/README.md`. The "Testing" entry in `architecture.md` still pointed at `tickets/plan/cadre-host-integration-tests.md` as the tracking location — that ticket is no longer in `plan/`. **Fixed inline** to describe what actually landed (harness + scenarios under `cadre-host-*.integration.ts`).
- **Public-surface additions.** `readHostConfig` / `updateHostConfig` / `writeHostConfig` / `SignedManifest` are all narrow, dependency-free, already-existing internal symbols. Exporting them is appropriate — every cadre-host consumer either has to read its persisted state (the harness, downstream tooling) or pass a `SignedManifest` through to `verifyManifest` / `signManifestForTesting`. No encapsulation concern.

### What I found and decided

| # | Finding | Severity | Disposition |
|---|---------|----------|-------------|
| 1 | `docs/architecture.md:843` still pointed at `tickets/plan/cadre-host-integration-tests.md` for cadre-host scenarios; the ticket has since landed. | minor | **Fixed inline** — rewrote the bullet to describe the harness + scenarios actually present. |
| 2 | `await awaitSubscribed(baseline + 1)` polling on `host.server.events.listenerCount()` is duplicated in 3 scenarios (sse-events, orchestrator-lifecycle, update-notify) to work around the SSE handler subscribing *after* writing headers (sse-route.ts:40-57). | minor | **Documented, not fixed.** Folding the wait into `openEventStream` would touch the harness factory signature + 3 scenarios. The current pattern is correct and the duplication is ~3 lines per site; risk > reward for an inline refactor during review. Worth a follow-up if a 4th scenario needs the same wait. |
| 3 | `pickFreePort` TOCTOU window between `close` and Installer rebind — the implement ticket flagged it; vitest `singleFork: true` makes it acceptable today. | known | **No action.** Already documented in the ticket as the first place to look if CI flakes. |
| 4 | `process.env.CADRE_HOST_UPDATE_DEV_KEY` is set in `beforeEach` and `delete`d in `afterEach` of `cadre-host-update-notify.integration.ts`. If a future scenario in the same vitest process *requires* the absence of this var, it should defensively `delete` in its own `beforeEach`. | known | **No action.** Implement ticket called this out and the test that mutates it mid-flow restores in `afterEach`. |
| 5 | Cross-platform CI: scenarios are Windows-only smoke today. Linux/macOS runners not wired up. | known | **No action this ticket.** Was explicitly out-of-scope in the implement plan. |
| 6 | Boot-time `connectivity-changed` SSE event is fundamentally unobservable from a stream opened after `server.start()`; covered by per-module `publishers.test.ts`. | known | **No action.** Comment in `cadre-host-sse-events.integration.ts:15-17` documents the rationale. |
| 7 | Update-flow `apply()` path is covered by `packages/cadre-host/src/update/__tests__/update-service.integration.test.ts` with a fake `npmExecutor`; the integration scenario stops at `check()` + `/update` GET. | known | **No action.** Real `npm install -g` is correctly out-of-scope for an integration suite. |

**No major findings.** No new fix/plan/backlog tickets spawned by this review.

### Things I deliberately did not touch

- The bootstrap scenario's hand-rolled `pickFreePort` / `StubServiceHost`. The comment at the top justifies the duplication ("If TestCadreHost.stop() is broken, the bootstrap test still passes; everyone else gets a useful failure") — that's a valuable property worth the few duplicate lines.
- Harness `await host.stop()`'s silent try/catch around `rmSync`. The comment is honest about why (Windows can lag on workdir release) and the post-run `%TEMP%` check confirmed no leakage.
- The implementer-spawned `tickets/fix/cadre-host-keytar-esm-interop.md` — that's a separate bug found *while* working this ticket, not a defect of the integration suite. It stays in `fix/` for its own pass.

### Validation re-run (review pass)

- `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-bootstrap.integration.ts src/scenarios/cadre-host-origin-guard.integration.ts src/scenarios/cadre-host-sse-events.integration.ts src/scenarios/cadre-host-orchestrator-lifecycle.integration.ts src/scenarios/cadre-host-trust-circle.integration.ts src/scenarios/cadre-host-update-notify.integration.ts` → **6 files / 27 tests pass, 8.53 s**.
- `yarn workspace @serfab/integration-tests build` → clean.
- `yarn workspace @serfab/cadre-host build:server` → clean.
- `%TEMP%\integration-cadre-host-*` → empty after run.
