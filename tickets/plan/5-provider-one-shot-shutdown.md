description: Per-request "shutdown after" flag on provider provision/terminate endpoints, plus service-host unit files that respect clean exit
files: packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/types.ts, packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/README.md
----

## Context

`@serfab/cadre-provider` is today a long-running Fastify service: it boots, listens on an HTTP port, manages a fleet of cadre node containers via Docker, and runs a periodic billing collector. The intended deployment is a container or a host-installed daemon under systemd / launchd / Windows Service.

There is an emerging use case for **on-demand provider invocations** — a caller (e.g. a deployment script, a test harness, or an ephemeral host that exists only to spin one cadre node up or down) wants the provider to come up, do exactly one thing, and disappear. Today the provider has no way to be told "this is the last request"; the caller has to send `SIGTERM` out-of-band, which couples it to process-supervision details and races against the in-flight HTTP response.

This ticket adds a per-request shutdown signal on the API, paired with service-host unit files that treat a clean exit as final (no resurrection on restart).

## Behaviour

### `shutdownAfter` flag on the REST API

Two endpoints accept an optional `shutdownAfter: boolean` field in the request body:

- `POST /api/v1/containers` (provision)
- `DELETE /api/v1/containers/:id` (terminate)

`DELETE` doesn't conventionally carry a body; Fastify accepts one, but for consumer ergonomics we should also accept `?shutdownAfter=true` as a query-string equivalent on `DELETE`. Body wins if both are present.

When `shutdownAfter` is true and the operation succeeds:

1. The response is fully serialised and sent to the client.
2. After flush (`setImmediate` or equivalent), the provider invokes the same graceful-shutdown path used by `SIGINT` / `SIGTERM`: stop billing collector, `app.close()` (drains in-flight requests), `process.exit(0)`.
3. If the operation **fails** (e.g. quota exceeded, docker error, ownership check fails), the provider does **not** shut down. The flag is "shut down after I successfully finish what I asked for," not "shut down regardless." This avoids a caller losing their provider to a transient error.
4. If `shutdownAfter` is true and another request is in flight when shutdown begins, `app.close()` drains it before exit (Fastify's default close behaviour).

### Auth

For now the flag uses the same auth as the underlying endpoint — any caller authorised to provision or terminate is also authorised to shut down the provider on their way out. A future iteration may introduce a `provider:shutdown` permission once multi-tenant deployments are real; this is called out in the ticket but not in scope.

### Response shape

No change to the success-response schema. The client sees the same `{ ok: true, data: { container } }` (or terminate equivalent) it would have seen without the flag. The client infers shutdown by observing that subsequent requests fail with connection-refused.

Optionally the response may include `shutdownInitiated: true` at the top level when the flag fires; this is useful for callers that want to confirm the provider acknowledged the request rather than ignored an unknown field. Worth including.

## Service host integration

The provider needs to ship with unit files for the three platforms it realistically runs on, configured so that `process.exit(0)` is **final** — the service stays dead until manually restarted.

### systemd (Linux)

A `cadre-provider.service` unit under `packages/cadre-provider/service/`:

- `Type=simple`
- `Restart=on-failure` (not `always`) — clean exit 0 leaves the service dead.
- `RestartPreventExitStatus=0` for belt-and-suspenders (some distros' systemd defaults can be tweaked).
- `ExecStart=/usr/bin/node /opt/cadre-provider/dist/bin/provider.js start -c /etc/cadre-provider/provider.yaml`
- Standard hardening: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`. Allow the docker socket if the orchestrator needs it (`SupplementaryGroups=docker`).

### launchd (macOS)

A `com.serfab.cadre-provider.plist`:

- `KeepAlive` omitted, or `KeepAlive.SuccessfulExit=false`.
- `RunAtLoad=true` for boot-time start.
- `StandardOutPath` / `StandardErrorPath` to a log location.

### Windows Service (via NSSM)

A `install-service.ps1` (or documented `nssm.exe set` commands) that installs the provider as a Windows Service. Key settings:

- `AppExit 0 Exit` — exit code 0 does not trigger restart.
- `AppExit Default Restart` — non-zero exits do restart (matches `Restart=on-failure`).
- Optional `AppThrottle` and `AppRestartDelay` to avoid restart loops on persistent failure.

Native `sc.exe` services do not auto-restart on clean exit by default, but NSSM is the de-facto wrapper for node services on Windows and gives the cleanest exit-code-aware semantics.

## Use cases

1. **CI / test harnesses**: a test boots a provider, provisions one cadre container against it for the duration of the test, terminates with `shutdownAfter: true`, and the provider exits. No teardown step needed in the test fixture beyond the existing API call.
2. **On-demand host provisioning**: an operator wants to provision a single drone on a remote machine. They `ssh` in, `systemctl start cadre-provider`, hit `POST /containers` with `shutdownAfter: true`, get the response, and the host returns to an idle state. No long-running daemon for what was a one-time setup task.
3. **Graceful deprovisioning**: a host is being decommissioned. The operator calls `DELETE /containers/:id?shutdownAfter=true` on each container; once the last container is gone, the provider exits and the unit-file settings ensure it doesn't come back when the host reboots.

## Non-goals

- A standalone `POST /shutdown` admin endpoint. The use cases above are all "do one thing, then leave" — adding a separate shutdown call is more surface area without a clear gain. Reconsider if a multi-step one-shot workflow emerges.
- Drain-mode where the provider stops accepting new requests but keeps existing containers running. That's a separate operational pattern.
- CLI `--one-shot` flag on `cadre-provider start`. The trigger comes from the request, not the launch. A launch flag is plausible follow-up if "exit after first successful request of any kind" turns out to be a useful default for embedded/test use.
- The persisted "shutdown marker in storage" idea raised in design discussion. Service-host unit files (`Restart=on-failure` and equivalents) handle this cleanly; a storage marker adds complexity without observable benefit when the unit files are correct.
- Kubernetes operator integration (covered by `provider-enhancements`).

## Constraints & considerations

- **Response must flush before exit.** Calling `process.exit(0)` in the same tick as `reply.send` truncates the response. The shutdown sequence must run after Fastify confirms the response has been written — `setImmediate` after `await reply.send(...)`, or an `onResponse` hook.
- **In-flight other requests.** Fastify's `app.close()` drains existing connections by default; the shutdown path must `await` it before `process.exit`. A misbehaving client holding a long-lived request shouldn't deadlock shutdown forever — apply a short hard-timeout (e.g. 5 s) before forcing exit.
- **Billing collector.** `billingService.stop()` must run before exit so any in-progress usage emission completes. The existing `SIGINT` path already handles this; reuse it.
- **Mock-orchestrator vs Docker.** Shutdown should work identically regardless of orchestrator backend; both currently expose synchronous-enough lifecycle methods that `app.close()` is the only async work to wait on.
- **Idempotency.** A second request arriving after shutdown has been initiated but before the socket closes should either complete normally (if already accepted) or get connection-refused. Don't add intermediate "shutting down" 503s — the unit files and the caller's `shutdownAfter` opt-in are sufficient signals.
- **Documentation.** `README.md` gains a short "one-shot mode" section showing the request shape and pointing at the three unit files. The unit files themselves live under `packages/cadre-provider/service/` and are referenced from the README's deployment section.
