---
description: review the cadre-host integration test suite — six scenarios that boot a real Installer + createLocalUiServer and drive it over loopback HTTP/SSE
files: packages/integration-tests/package.json, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/harness/fixtures/idle-child.mjs, packages/integration-tests/src/harness/fixtures/manifest-server.ts, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-origin-guard.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/integration-tests/src/scenarios/cadre-host-orchestrator-lifecycle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-update-notify.integration.ts, packages/cadre-host/src/index.ts, packages/cadre-host/src/installer/index.ts, packages/cadre-host/src/update/index.ts
---

## What landed

Six new integration scenarios under `packages/integration-tests/src/scenarios/`, plus shared harness in `packages/integration-tests/src/harness/`. All six pass on Windows; together they boot a real `Installer` → `createLocalUiServer` and exercise the public 127.0.0.1 HTTP/SSE surface.

### Scenarios (27 tests total, all green)

- `cadre-host-bootstrap.integration.ts` (4 tests) — inlined setup (no shared harness) to prove the install→start sequence end-to-end. Covers `/api/status`, `/api/settings`, `/` (placeholder HTML), and identity-key idempotence on re-run.
- `cadre-host-origin-guard.integration.ts` (4 tests) — DNS-rebind defenses: loopback host OK, foreign Host 403, foreign Origin 403, matching loopback Origin OK.
- `cadre-host-sse-events.integration.ts` (5 tests) — SSE pipe end-to-end: direct bus publish → SSE, trust-circle invite/revoke route adapters → SSE, settings PUT does NOT emit (asserts the absence in v1), and SSE close releases the bus listener slot.
- `cadre-host-orchestrator-lifecycle.integration.ts` (6 tests) — `/api/nodes` list, detail (with stats), logs tail, stop + SSE `node-state-changed`, the 501 stub for start, and 404 for unknown id. Uses `idle-child.mjs` as the spawn entrypoint so no real cadre-cli is launched.
- `cadre-host-trust-circle.integration.ts` (3 tests) — real `CadreNode` (Quereus control DB) wired in. Full issue → list → redeem (via service handle since v1 has no HTTP redeem route) → remove cycle over HTTP, plus 404/400 error mapping.
- `cadre-host-update-notify.integration.ts` (5 tests) — real loopback manifest fixture serving signed envelopes, `update.check()` against a >current version, equal version, bad signature, autoApply default safety, and SSE delivery of bus-published `update-available`.

### Harness pieces

- `test-cadre-host.ts` — `createTestCadreHost(opts)` factory. Builds a fresh tempdir, runs `Installer.install` with a `FakeServiceHost` and OS-picked free ports for ui+libp2p (NatStore rejects port 0), then wires `HostProcessOrchestrator` + `TrustCircleService` + `NatService` + optional `UpdateService` and binds the server on `forcePort: 0`. Returns the live subsystem handles plus `request(...)` (node:http loopback for Host/Origin header overrides) and `openEventStream()`.
- `fixtures/idle-child.mjs` — test-only orchestrator child. Writes `CADRE_STARTUP_TOKEN` to `--startup-token-file` (matching the format `pid-liveness.tokenMatches()` expects) and idles on SIGTERM.
- `fixtures/manifest-server.ts` — in-process HTTP fixture that serves a `SignedManifest` envelope at `/latest.json` over a loopback ephemeral port.

### Package surface changes

To support the harness, three exports were added to `@serfab/cadre-host`:

- `readHostConfig` / `updateHostConfig` / `writeHostConfig` from `installer/index.ts` and the package root.
- `SignedManifest` type re-export from `update/index.ts` and the package root.

`@serfab/integration-tests` now depends on `@serfab/cadre-host` (`workspace:*`) and re-exports the harness from `harness/index.ts`.

## Validation

- `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-*.integration.ts` → **6 files / 27 tests pass, ~8s** on the local Windows box.
- `yarn workspace @serfab/integration-tests build` → typecheck clean.
- `yarn workspace @serfab/cadre-host build:server` → typecheck clean.
- `yarn workspace @serfab/cadre-host test` → **40 files / 281 tests pass** (unchanged from baseline; the cadre-host package surface additions don't break existing unit tests).
- Post-run check of `%TEMP%\integration-cadre-host-*` → empty, no leaked temp dirs.

## Seams exercised

These are the seams the new suite actually asserts (anything not listed below is **not** under integration coverage):

- `Installer.install` writes `host.config.json`, `identity.key`, `nat.json`, `logs/` and is idempotent on identity.
- `createLocalUiServer.start()` binds an ephemeral loopback port and returns the bound URL.
- Route → handler → service wiring for: `/api/status`, `/api/settings` GET+PUT, `/api/nodes` (list + detail + logs + stop + 501 start), `/api/events` (SSE delivery + cleanup), `/auth/invites` POST+DELETE, `/auth/trust-circle` GET, `/auth/members/:peerId` DELETE, `/update` GET, `/` (placeholder HTML).
- Origin guard: Host header allowlist + Origin header allowlist, both 403 with `forbidden_origin`.
- Settings PUT propagates `upnpEnabled` into `NatService.putSettings`.
- `UpdateService.check()` against a real loopback manifest endpoint with a signed envelope and dev-key override.
- Error mapping: `TrustCircleError('invalid_label')` → 400, `TrustCircleError('not_found')` → 404, unknown node → 404, unknown route → 404, `/api/nodes/:id/start` → 501.
- SSE pipe: bus → SSE serializer → client; trust-circle route adapters → `trust-circle-changed` events; SSE close releases bus listener.

## Known gaps and reviewer caveats

These are the deferrals I made during implementation. Some came from the ticket; some I discovered during testing. The reviewer should treat each as an explicit "not covered here" rather than an oversight.

- **Cross-platform CI**: tests pass on the Windows dev box this work was authored on. Linux/macOS CI is not yet wired up for this suite — that's a separate ticket. The harness uses `installerPlatform: 'linux'` by default, but the OS-level NAT probing, port-allocation, and SIGTERM behavior could differ.
- **Boot-time `connectivity-changed` SSE event**: deliberately not asserted in `cadre-host-sse-events.integration.ts`. The event is published once during `server.start()`, before any SSE client can subscribe — so it's fundamentally unobservable from a stream opened later. The boot-time publish is already covered by `packages/cadre-host/src/server/__tests__/publishers.test.ts:143-162`, which subscribes to the bus before `start()`. The integration suite covers the *delivery pipe* via a direct `events.publish` test instead.
- **Trust-circle redemption over HTTP**: v1 does not expose `POST /auth/redeem`. The scenario drives redemption via `trustCircle.redeemInvite(...)` directly. If a future ticket exposes the redeem route, the assertion should move to HTTP.
- **`connectivity-changed` SSE on settings PUT**: today there is no publisher that emits one when `nat.putSettings()` is called from the route. The scenario asserts the *absence* of such an event so a future ticket that adds it is a deliberate change rather than an accidental regression.
- **Real `npm install -g` apply path**: the update scenario stops at `check()` + `/update` GET. `apply()` is covered by the per-module integration test (`packages/cadre-host/src/update/__tests__/update-service.integration.test.ts`) with a fake `npmExecutor`.
- **NAT UPnP against the host network**: `NatService.start()` runs with a stub `cadreNode` (empty multiaddrs); the `start()` call is wrapped in try/catch because UPnP probing may fail on a CI box. No integration assertion on direct reachability — that's a manual smoke story.
- **`/api/events` initial heartbeat**: not asserted. Heartbeat interval is reduced to 200ms via `sseHeartbeatMs` so it does happen during tests, but the parser drops `:` comment lines silently.

## Risks for the reviewer to inspect

- **Harness teardown order**: `host.stop()` runs `server.stop` → `nat.stop` → `update.stop` → `rmSync(dataDir)`. The `rmSync` uses `maxRetries: 5, retryDelay: 100` to tolerate Windows cwd-handle lag. If a test leaves an orchestrator child running, the `afterEach` may race the rm — the orchestrator-lifecycle scenario explicitly stops + removes any leftover children before `host.stop()`. A reviewer should look at whether any scenario could leak a child past `afterEach`.
- **`pickFreePort` race**: `pickFreePort()` listens on `127.0.0.1:0`, closes, and hands the port to the Installer. There's a TOCTOU window where another process could grab the port between the `close` and the install. Vitest's `singleFork: true` reduces but doesn't eliminate this. If CI sees flakes, this is the first place to look.
- **`@serfab/cadre-host` newly exported symbols**: `readHostConfig`, `updateHostConfig`, `writeHostConfig`, and `SignedManifest` are now part of the public surface. The reviewer should confirm these are appropriate exports (versus keeping them internal and importing via deep paths).
- **`idle-child.mjs` startup-token format**: the fixture reads `CADRE_STARTUP_TOKEN` from env and writes raw UTF-8 to the token file. `tokenMatches()` in `host-process-orchestrator.ts:549` strips trailing whitespace before comparing. If `pid-liveness.ts` changes the token serialization, the fixture needs to match.
- **Update-notify env var**: tests set `process.env.CADRE_HOST_UPDATE_DEV_KEY` in `beforeEach` and delete it in `afterEach`. If a test throws before `afterEach`, the env var leaks to subsequent scenarios. The fan-in vitest run still passed, but a future scenario relying on the absence of this var should add a `delete process.env.CADRE_HOST_UPDATE_DEV_KEY` to its own `beforeEach`.

## Acceptance vs. the plan

- ✅ Six scenario files land under `packages/integration-tests/src/scenarios/`.
- ✅ `yarn workspace @serfab/integration-tests vitest run src/scenarios/cadre-host-*.integration.ts` passes on Windows.
- ✅ `yarn workspace @serfab/integration-tests build` (typecheck) passes; no `any` leaks in new code.
- ✅ No leaked temp dirs (`integration-cadre-host-*` is empty after a clean run).
- ⚠️ Cross-platform CI: deferred — Windows-only smoke is the v1 story per the implement ticket's "Known gaps". The Linux/macOS gap was already documented in the ticket.
