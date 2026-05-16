description: Per-request "shutdown after" flag on provider provision/terminate endpoints, plus service-host unit files that respect clean exit
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/README.md, packages/cadre-provider/service/ (new)
----

## Summary

Add a per-request `shutdownAfter` flag on `POST /api/v1/containers` and `DELETE /api/v1/containers/:id` that triggers the provider's existing graceful-shutdown path **after** the response has been flushed and the operation succeeded. Ship systemd / launchd / NSSM unit files configured so a clean exit is final.

## Design

### Shutdown wiring

Move the existing shutdown handler out of `bin/provider.ts` and into the `ProviderServer` returned by `createProviderServer` as `requestShutdown(reason: string): void`. The CLI's `SIGINT`/`SIGTERM` handlers and the route-level `shutdownAfter` path both call this single method, so there is exactly one shutdown sequence to reason about.

Sequence (idempotent — second call is a no-op):

1. Mark "shutdown in progress" (a boolean on the server).
2. Wait one `setImmediate` tick — guarantees Fastify has flushed the response that triggered shutdown (or, for signal-driven shutdown, lets the current event-loop turn complete).
3. `billingService.stop()` — synchronous; stops the periodic collector.
4. `await Promise.race([app.close(), timeout(5000)])` — drains in-flight requests; hard cap so a stuck client cannot deadlock shutdown.
5. `process.exit(0)`.

`requestShutdown` returns void; callers do not await it. It schedules the sequence via `setImmediate` and runs it in the background. Errors during the sequence are logged then `process.exit(1)`.

### Route changes

Both endpoints accept `shutdownAfter?: boolean` in the request body. `DELETE /containers/:id` also accepts `?shutdownAfter=true` as a query-string equivalent for clients that avoid bodies on DELETE; body wins when both are present.

Flag fires **only on success**:

- `POST /containers`: fires after `containerService.createContainer` returns and the 201 reply is sent. Failure paths (`UNAUTHORIZED`, `INVALID_REQUEST`, `QUOTA_EXCEEDED`, container-service throw) do not trigger shutdown.
- `DELETE /containers/:id`: fires only when `terminateContainer` returns `true` and the reply ships with `ok: true`. Ownership/404/orchestrator-failure paths do not trigger shutdown.

When the flag fires, the response includes `shutdownInitiated: true` at the top level of the success payload, alongside `ok` and `data`. This is purely advisory — clients infer the actual shutdown from the connection closing — but it lets a caller confirm the provider acknowledged the flag rather than silently ignored an unknown field.

To wire the shutdown trigger into routes, `RouteContext` gains `requestShutdown(reason: string): void`. `createProviderServer` injects its own `requestShutdown` when it calls `registerRoutes`.

### Shape of the reply when shutdown fires

```
POST /api/v1/containers — 201
{
  "ok": true,
  "data": { "container": { ... } },
  "shutdownInitiated": true
}

DELETE /api/v1/containers/:id — 200
{
  "ok": true,
  "message": "Container terminated",
  "shutdownInitiated": true
}
```

When `shutdownAfter` is absent or false, the response shape is unchanged (no `shutdownInitiated` field).

### Auth

No new permission. Any caller who can provision or terminate may also opt-in to shutdown. A future `provider:shutdown` permission is called out in the original ticket but is not in scope here.

## Service host integration

Three new files under `packages/cadre-provider/service/` (new directory):

### `cadre-provider.service` (systemd)

```
[Unit]
Description=Sereus Cadre Provider
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/cadre-provider/dist/bin/provider.js start -c /etc/cadre-provider/provider.yaml
Restart=on-failure
RestartPreventExitStatus=0
RestartSec=5s
User=cadre-provider
Group=cadre-provider
SupplementaryGroups=docker
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/cadre-provider /var/log/cadre-provider

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` plus `RestartPreventExitStatus=0` together ensure exit 0 is final on every supported distro.

### `com.serfab.cadre-provider.plist` (launchd)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.serfab.cadre-provider</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/cadre-provider/dist/bin/provider.js</string>
    <string>start</string>
    <string>-c</string>
    <string>/usr/local/etc/cadre-provider/provider.yaml</string>
  </array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>  <false/>
    <key>Crashed</key>         <true/>
  </dict>
  <key>StandardOutPath</key> <string>/usr/local/var/log/cadre-provider/out.log</string>
  <key>StandardErrorPath</key><string>/usr/local/var/log/cadre-provider/err.log</string>
</dict>
</plist>
```

### `install-service.ps1` (NSSM, Windows)

Idempotent PowerShell script that locates `nssm.exe` (validates it is on PATH; errors with install instructions if missing), then runs:

```
nssm install CadreProvider "<node-path>" "<provider-js-path>" start -c "<config-path>"
nssm set    CadreProvider AppDirectory      "<install-dir>"
nssm set    CadreProvider AppExit Default   Restart
nssm set    CadreProvider AppExit 0         Exit
nssm set    CadreProvider AppRestartDelay   5000
nssm set    CadreProvider AppThrottle       10000
nssm set    CadreProvider AppStdout         "<log-dir>\out.log"
nssm set    CadreProvider AppStderr         "<log-dir>\err.log"
nssm set    CadreProvider AppRotateFiles    1
nssm set    CadreProvider Start             SERVICE_AUTO_START
```

Accepts `-NodePath`, `-InstallDir`, `-ConfigPath`, `-LogDir` parameters with sensible defaults. `nssm.exe set CadreProvider AppExit 0 Exit` is the key line — exit-code 0 means "don't restart."

A companion `uninstall-service.ps1` runs `nssm remove CadreProvider confirm`.

### README

Add a "One-shot mode" section under Deployment with the request shapes:

```bash
# Provision then exit
curl -X POST $URL/api/v1/containers \
  -H 'Authorization: Bearer ...' \
  -d '{"partyId":"...","bootstrapNodes":["..."],"shutdownAfter":true}'

# Terminate then exit
curl -X DELETE "$URL/api/v1/containers/$ID?shutdownAfter=true" \
  -H 'Authorization: Bearer ...'
```

Plus links to the three service files and a one-paragraph install note for each.

## Tests

Vitest under `packages/cadre-provider/src/server/__tests__/` (new). Use `MockOrchestrator` and an injected `MemoryStore` so no Docker is needed.

Key cases:

- `POST /containers` with `shutdownAfter: true` on success: response carries `shutdownInitiated: true`; `requestShutdown` is called once. Spy on a fake `requestShutdown` injected via `RouteContext`.
- `POST /containers` with `shutdownAfter: true` on failure (e.g. quota exceeded): response is the normal error shape; `requestShutdown` is **not** called.
- `DELETE /containers/:id` with body `{shutdownAfter:true}` on success: shutdown triggered, `shutdownInitiated: true` in body.
- `DELETE /containers/:id?shutdownAfter=true` (query form): shutdown triggered.
- `DELETE` with both body `false` and query `true`: body wins → not triggered.
- `DELETE` with both body `true` and query `false`: body wins → triggered.
- Idempotency: calling `requestShutdown` twice schedules the sequence once (verify via spy / counter on the inner shutdown body).
- The 5 s timeout caps `app.close()`: feed a server with a `setTimeout`-deferred handler and assert shutdown completes within `~5.5 s` of being triggered. (Mark this case with a generous timeout; runs in <6 s.)

Replace `process.exit` with an injected `exitFn` on the server options (defaulting to `process.exit`) so tests can observe the exit code without killing the test runner.

## TODO

### Phase 1 — wiring

- Add `requestShutdown(reason: string): void` to `ProviderServer` in `packages/cadre-provider/src/server/server.ts`. Internal implementation runs the sequence (mark, `setImmediate`, `billingService.stop()`, `Promise.race([app.close(), 5s])`, `exitFn(0)`). Idempotent.
- Add an optional `exitFn?: (code: number) => void` to `ProviderServerOptions` for test injection; default `process.exit.bind(process)`.
- Update `RouteContext` in `packages/cadre-provider/src/server/routes.ts` to include `requestShutdown: (reason: string) => void`. Pass it through from `createProviderServer`.
- Rewrite the CLI shutdown handler in `packages/cadre-provider/src/bin/provider.ts` to call `server.requestShutdown('signal: ' + sig)` from `SIGINT`/`SIGTERM` instead of the inline `server.stop(); process.exit(0)` pattern.

### Phase 2 — route flag

- In `POST /containers`: after the success path computes the response payload, if `body.shutdownAfter === true`, set `shutdownInitiated: true` on the payload and call `ctx.requestShutdown('shutdownAfter: POST /containers')` after `await reply.send(...)` (or via `reply.then(...)` — pick whichever Fastify idiom flushes before the trigger; `setImmediate` inside the shutdown sequence covers the actual wait).
- In `DELETE /containers/:id`: parse `shutdownAfter` from body first, fall back to query (`request.query`). Set `shutdownInitiated: true` on the response when the operation succeeds AND the flag is true. Trigger shutdown the same way.
- Do not trigger shutdown when ownership check fails, container is not found, terminate returns `false`, or any error path runs.

### Phase 3 — service files

- Create `packages/cadre-provider/service/cadre-provider.service` with the systemd unit above.
- Create `packages/cadre-provider/service/com.serfab.cadre-provider.plist` with the launchd plist above.
- Create `packages/cadre-provider/service/install-service.ps1` and `packages/cadre-provider/service/uninstall-service.ps1` for NSSM on Windows.
- Add a short `packages/cadre-provider/service/README.md` cross-linking the three files and noting which one to use on each OS.
- Add `service` to the `files` array in `packages/cadre-provider/package.json` so the unit files ship in the npm tarball.

### Phase 4 — docs

- Add a "One-shot mode" subsection under "Deployment" in `packages/cadre-provider/README.md` with the curl examples above and links to the three service files.

### Phase 5 — tests + build

- Add `packages/cadre-provider/src/server/__tests__/shutdown-after.test.ts` covering the cases listed under **Tests** above.
- `yarn workspace @serfab/cadre-provider build` — must pass.
- `yarn workspace @serfab/cadre-provider test` — must pass (the new test file plus any existing tests).

## Notes / non-goals (carried from plan)

- No `POST /shutdown` admin endpoint.
- No drain-mode.
- No CLI `--one-shot` flag.
- No persisted shutdown marker — unit files handle "stay dead."
- No new `provider:shutdown` permission yet.
- Kubernetes operator integration is `provider-enhancements`, not this ticket.
