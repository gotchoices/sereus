description: Per-request shutdownAfter flag + service host unit files for cadre-provider
files: packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/server/__tests__/shutdown-after.test.ts, packages/cadre-provider/service/, packages/cadre-provider/README.md, packages/cadre-provider/package.json, packages/cadre-provider/vitest.config.ts
----

## Summary

Added a `shutdownAfter: true` flag to `POST /api/v1/containers` and `DELETE /api/v1/containers/:id` so a caller can provision (or terminate) a single container and have the provider process exit cleanly afterward. Wired the same single shutdown sequence into the CLI's `SIGINT`/`SIGTERM` handlers via a new `ProviderServer.requestShutdown(reason)`. Sequence is idempotent, response is awaited before drain, and `app.close()` is capped at 5 s so a stuck client cannot deadlock exit. Shipped systemd, launchd, and NSSM unit files configured so that exit code 0 is final — clean shutdown stays down, crashes still restart.

## Review findings

### Scope

Read the implement-stage diff (`f1df6df`) and the live source at the addressed files. Ran `yarn workspace @serfab/cadre-provider test` (10/10 pass, ~5.6 s — the drain-cap test contributes ~5.0 s by design) and `yarn workspace @serfab/cadre-provider build` (clean). No package-level lint script exists. Cross-referenced against `docs/architecture.md`, `docs/api.md`, and the package README; verified the package README is the canonical surface for provider HTTP endpoints (none documented in `docs/api.md`).

### What was checked, with verdict

- **SPP/DRY/modular** — clean. `parseShutdownFlag` is one place; `runShutdownSequence` + `requestShutdown` are local closures inside `createProviderServer`. `stop()` and `requestShutdown` overlap but serve different consumers (programmatic embedding vs. process-exit); both are kept intentionally. No findings.
- **Type safety** — clean. `body.shutdownAfter` typed as `unknown` and coerced; payload types use literal `true` for `shutdownInitiated` to keep the response shape honest. No new `any` introduced.
- **Resource cleanup** — shutdown stops billing then `app.close()`s. Timer in the drain race is cleared on both branches. Tests don't `server.stop()` after triggering `requestShutdown` (no double-close).
- **Error handling** — try/catch wraps the entire shutdown sequence; failure path logs and exits 1, success path exits 0 (including the timeout branch, which is intentional — a stuck `close` shouldn't bounce the service host).
- **Idempotency & race conditions** — `shuttingDown` flag gates `requestShutdown`; `setImmediate` defers the sequence so the in-flight reply isn't preempted. Repeated SIGINT+SIGTERM under load collapses to one exit.
- **Edge cases covered by tests**: success POST, absent flag, validation failure (`INVALID_REQUEST`), DELETE body form, DELETE query form, body-wins-over-query (both directions), 404 on missing container, `requestShutdown` idempotency, and the 5 s drain cap with a deliberately hung `app.close()`. All 10 pass.
- **Edge case NOT exercised by tests**: 401 (auth gate path in `routes.ts`) and 403 (ownership mismatch on DELETE) with `shutdownAfter=true`. The test harness uses `auth.mode: 'none'` which sets a single `dev-customer`, so these branches are unreachable in-test. **By code inspection** both paths return before `parseShutdownFlag`, so shutdown cannot fire. Acceptable gap — would require a second test config to exercise auth modes.
- **Signal handling** — verified by code review of `src/bin/provider.ts:48-49` only. No spawned-child SIGINT/SIGTERM integration test. Acceptable per implementer note; a real signal test would need a child-process harness and is OS-dependent.
- **Docs** — package `README.md` "One-shot mode" section and `service/README.md` install cheat sheet are accurate against the code. `docs/architecture.md` cadre-provider section is a high-level bullet list and does not enumerate API endpoints, so no update is owed there. `docs/api.md` does not document provider routes (pre-existing — not in scope).
- **Build** — passes.

### Findings

- **MINOR (informational, no code change).** The implementer's "Known gaps" entry that flags `await reply.send()` as relying on Fastify Reply being thenable "under `app.inject()` but maybe not over a real socket" — **this concern is unfounded.** Fastify v5's `Reply.prototype.then` (`node_modules/fastify/lib/reply.js:454`) is wired to `eos(this.raw, …)`, which fires when the underlying response stream truly ends — including over a real TCP socket. So `await reply.send(payload)` does wait for the response to flush. The `setImmediate` inside `requestShutdown` is redundant safety, not load-bearing. Code is correct; only the implementer's risk note was over-cautious. Leaving the `setImmediate` in place is harmless and slightly cheaper than removing it.
- **MINOR (informational).** `parseShutdownFlag` is more permissive than the implementer summary suggests — `value.toLowerCase() === 'true'` accepts any case (`true`, `True`, `TRUE`, `tRuE`), not just `"true"`/`"TRUE"`. Behavior is fine, summary was just understated.
- **MINOR (latent, not exercised).** `service/install-service.ps1:88` invokes `nssm.exe` with `$NodePath`, `$ProviderJs`, and `$ConfigPath` via the PowerShell call operator. On Windows PowerShell 5.1, native-EXE argument quoting is known-fragile for paths containing spaces (e.g. the default node install at `C:\Program Files\nodejs\node.exe`). NSSM does the right thing once it receives the args correctly; the risk is PowerShell 5.1 mis-quoting before that. Not fixing in this pass — the typical install path is space-free and the failure mode is loud (service fails to start, easy to diagnose). If reports come in, switch to `Start-Process` with `-ArgumentList` array or use the `--%` stop-parsing token.
- **MINOR (housekeeping).** `stop()` is now publicly unused by the CLI (only `requestShutdown` is). Kept in place because tests use it for non-shutdown cleanup and it's part of the documented `ProviderServer` programmatic-embed API. No change.
- **No major findings.** Nothing escalated to a new ticket.

### Things explicitly NOT in scope (carried from plan/implement)

`POST /shutdown` admin endpoint, drain-mode, CLI `--one-shot` flag, persisted shutdown marker, `provider:shutdown` permission, Kubernetes operator integration. Auth-scope question (any caller with create/delete rights can opt-in to shutdown) was raised by the implementer; ticket is silent on a per-permission gate and the threat model has not changed since planning, so deferred.

## Reviewer use cases & validation

Functional surface (POST/DELETE × flag-true/flag-absent/error × body/query) is exercised end-to-end via `app.inject()` in `shutdown-after.test.ts`. Lifecycle (idempotency, 5 s drain cap) is exercised in the same file. Signal handling and the service unit files themselves are not integration-tested — operators should at minimum syntax-check the units on their target host:

- Linux: `systemd-analyze verify ./cadre-provider.service`
- macOS: `plutil -lint com.serfab.cadre-provider.plist`
- Windows: dry-run `install-service.ps1 -ConfigPath C:\tmp\fake.yaml` against a scratch install dir.

## Files touched

```
 packages/cadre-provider/README.md                                |  42 ++++
 packages/cadre-provider/package.json                             |   1 +
 packages/cadre-provider/service/README.md                        |  57 +++++
 packages/cadre-provider/service/cadre-provider.service           |  22 ++
 packages/cadre-provider/service/com.serfab.cadre-provider.plist  |  29 +++
 packages/cadre-provider/service/install-service.ps1              |  99 +++++++
 packages/cadre-provider/service/uninstall-service.ps1            |  19 ++
 packages/cadre-provider/src/bin/provider.ts                      |  13 +-
 packages/cadre-provider/src/server/__tests__/shutdown-after.test.ts | 231 +++
 packages/cadre-provider/src/server/routes.ts                     |  52 ++-
 packages/cadre-provider/src/server/server.ts                     |  64 ++-
 packages/cadre-provider/vitest.config.ts                         |   9 +
```
