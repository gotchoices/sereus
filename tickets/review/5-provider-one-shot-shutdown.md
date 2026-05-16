description: Review per-request shutdownAfter flag + service host unit files for cadre-provider
prereq:
files: packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/src/server/__tests__/shutdown-after.test.ts, packages/cadre-provider/service/, packages/cadre-provider/README.md, packages/cadre-provider/package.json, packages/cadre-provider/vitest.config.ts
----

## What changed

### Server: single shutdown sequence (`packages/cadre-provider/src/server/server.ts`)

- Added `requestShutdown(reason: string): void` to `ProviderServer`. Idempotent — guarded by a `shuttingDown` boolean that flips on first call.
- Added optional `exitFn?: (code: number) => void` to `ProviderServerOptions` so tests can inject a spy without killing the runner. Defaults to `process.exit.bind(process)`.
- Shutdown sequence runs in `setImmediate`:
  1. Log + console.log the reason.
  2. `billingService.stop()`.
  3. `Promise.race([app.close(), 5s timeout])` — hard cap on the drain so a stuck client cannot deadlock shutdown.
  4. `exitFn(0)` on success, `exitFn(1)` on caught exception.
- Hard cap constant is named `SHUTDOWN_DRAIN_TIMEOUT_MS = 5000`.

### Routes: shutdownAfter wiring (`packages/cadre-provider/src/server/routes.ts`)

- `RouteContext` gained a `requestShutdown: (reason: string) => void` field; `createProviderServer` injects its own.
- `parseShutdownFlag(unknown): boolean` accepts strict boolean `true` and the strings `"true"` / `"TRUE"`. Anything else is `false`.
- `POST /containers`:
  - Reads `body.shutdownAfter` (typed as `unknown` and coerced).
  - On success, response payload gets `shutdownInitiated: true`.
  - Shutdown is triggered **after** `await reply.status(201).send(payload)` returns.
  - Validation failure (`INVALID_REQUEST`), unauthorized, and quota errors return the normal error response and do NOT trigger shutdown.
- `DELETE /containers/:id`:
  - Parses `shutdownAfter` from body first (`request.body`), falling back to `request.query`. Body wins when both are present.
  - Only triggers shutdown when `terminateContainer` returns `true`. 404 / 403 / `terminate returned false` do not trigger.
  - Adds `shutdownInitiated: true` to the success payload when triggered.

### CLI (`packages/cadre-provider/src/bin/provider.ts`)

- `SIGINT` / `SIGTERM` handlers now delegate to `server.requestShutdown('signal: SIGINT'|'signal: SIGTERM')` instead of the old inline `server.stop(); process.exit(0)`. This consolidates all shutdown paths.

### Service files (`packages/cadre-provider/service/`, new)

- `cadre-provider.service` — systemd unit. `Restart=on-failure` + `RestartPreventExitStatus=0` make exit 0 final. Runs as `cadre-provider` user, member of `docker` group, with hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, scoped `ReadWritePaths`).
- `com.serfab.cadre-provider.plist` — launchd plist. `KeepAlive.SuccessfulExit=false` plus `KeepAlive.Crashed=true` ⇒ clean exit stays down, crashes get relaunched.
- `install-service.ps1` — idempotent NSSM installer. Validates `nssm.exe` on PATH and emits a clear error referencing https://nssm.cc/download if missing. Removes any prior `CadreProvider` service before installing. Sets `AppExit 0 Exit` (clean exit = no restart) and `AppExit Default Restart` with `AppRestartDelay=5000` and `AppThrottle=10000` for crashes.
- `uninstall-service.ps1` — companion remove script.
- `service/README.md` — install/uninstall cheat sheet per platform.
- `package.json` `"files"` array now ships `service/` in the npm tarball.

### Docs (`packages/cadre-provider/README.md`)

- New **One-shot mode** section under Deployment with `curl` examples (POST, DELETE-with-body, DELETE-with-query) and links to all three service unit files.

### Tests (`packages/cadre-provider/vitest.config.ts` + `src/server/__tests__/shutdown-after.test.ts`)

- Added a vitest config (the package previously had none) that picks up `src/**/__tests__/**/*.test.ts`.
- Test file covers all ten cases the ticket asked for. Uses `app.inject()` (no listening port), `MockOrchestrator`, `MemoryStore`, `mode: 'none'` auth, and `vi.fn()` as `exitFn`.

## Test results

`yarn workspace @serfab/cadre-provider test` — **10/10 pass** in ~5.6 s. The drain-cap test contributes ~5.0 s of that wall time by design (it makes `app.close()` hang to verify the 5 s timeout actually fires).

`yarn workspace @serfab/cadre-provider build` — passes cleanly.

`yarn workspaces foreach -A run build` (sanity sweep) — passes; only pre-existing vite "dynamic-import-also-static" warnings unrelated to this ticket.

## Reviewer use cases & validation

### Functional surface

1. **POST /containers — happy path with flag**

   ```bash
   curl -X POST http://localhost:3000/api/v1/containers \
     -H 'Authorization: Bearer …' \
     -H 'Content-Type: application/json' \
     -d '{"partyId":"p1","bootstrapNodes":["/ip4/127.0.0.1/tcp/4001"],"shutdownAfter":true}'
   ```
   Expect: 201, body `{ok:true, data:{container:…}, shutdownInitiated:true}`, then the connection closes as the process exits.

2. **POST /containers — flag absent**

   No `shutdownAfter`. Expect: 201, no `shutdownInitiated` in body, process keeps running.

3. **POST /containers — flag set but request fails**

   Omit `partyId`. Expect: 400 `INVALID_REQUEST`, no shutdown.

4. **DELETE /containers/:id — body form**

   `curl -X DELETE … -d '{"shutdownAfter":true}'`. Expect: 200 `{ok:true, message:"Container terminated", shutdownInitiated:true}`.

5. **DELETE /containers/:id — query form**

   `curl -X DELETE '…?shutdownAfter=true'`. Expect: 200 with `shutdownInitiated:true`.

6. **DELETE /containers/:id — both forms, body wins**

   `?shutdownAfter=true` + body `{"shutdownAfter":false}` → no shutdown. Inverse → shutdown.

7. **DELETE on missing container**

   `…/ctr_does_not_exist?shutdownAfter=true` → 404 `NOT_FOUND`, no shutdown.

### Lifecycle

- **Idempotency:** call `server.requestShutdown('a')` then `server.requestShutdown('b')` — exitFn is invoked exactly once with `0`.
- **Drain cap:** simulate a slow `app.close()` (the test does this by monkey-patching). The shutdown sequence still completes inside ~5.5 s and exits 0.
- **Signals:** `kill -TERM <pid>` should produce the same graceful exit path as the route flag — verified via code review of `bin/provider.ts` only (no integration test for signals).

### Service hosts

These were not exercised end-to-end. Reviewer should at minimum syntax-check the unit files on a real box:

- Linux: `systemd-analyze verify ./cadre-provider.service`
- macOS: `plutil -lint com.serfab.cadre-provider.plist`
- Windows: dry-run `install-service.ps1 -ConfigPath C:\tmp\fake.yaml` against a scratch install dir.

## Known gaps / flagged risks

- **`await reply.send()` assumption.** The routes call `await reply.status(201).send(payload)` and then call `requestShutdown(...)`. This relies on Fastify Reply being thenable (resolves when the response is written). The behavior is observed-correct under `app.inject()` in the test suite, but Fastify `inject` runs in-memory and may not exercise the same flush semantics as a real TCP socket. The `setImmediate` inside `requestShutdown` is a second layer of defense (next-tick scheduling). Reviewer may want to verify against a real `app.listen()` socket if paranoid.
- **No signal test.** Tests do not send a real `SIGINT`/`SIGTERM` to a child process. The CLI shutdown wiring is verified only by reading `bin/provider.ts` against the new `server.requestShutdown` API.
- **Service files are not version-controlled against a target machine.** Path defaults (`/opt/cadre-provider`, `/usr/local/lib/cadre-provider`, etc.) are conventional but operators will need to override for their layout. The systemd unit also assumes a `cadre-provider` user with `docker` group membership that the operator creates manually.
- **NSSM dependency.** `install-service.ps1` errors out with installation instructions if `nssm.exe` is not on PATH, but does not auto-download. This is intentional (we don't want to silently fetch executables) and matches the ticket's spec.
- **Auth scope.** Per ticket: any caller who can hit `POST` or `DELETE` can opt-in to shutdown. No new `provider:shutdown` permission was added. Reviewer may want to flag this if the threat model has changed since planning.
- **The drain-cap test uses real wall-clock time (~5 s).** A future change to `SHUTDOWN_DRAIN_TIMEOUT_MS` will require updating the test's timing assertions. Consider extracting the constant to make it injectable if the timeout value becomes tunable.
- **`stop()` and `requestShutdown` are now overlapping but not identical** — `stop()` is still exported for programmatic use (it just awaits `app.close()` without an `exit` call). I left it as-is rather than removing it, but the boundary between the two is worth a glance.

## Non-goals (carried from plan)

Not in this ticket: `POST /shutdown` admin endpoint, drain-mode, CLI `--one-shot` flag, persisted shutdown marker, `provider:shutdown` permission, Kubernetes operator integration.
