---
description: implement end-to-end integration tests that boot cadre-host (Installer + createLocalUiServer + real orchestrator/trust-circle/NAT/update wiring) and drive it over its HTTP/SSE surface
files: packages/integration-tests/package.json, packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/harness/test-cadre-host.ts, packages/integration-tests/src/harness/fixtures/idle-child.mjs, packages/integration-tests/src/harness/fixtures/manifest-server.ts, packages/integration-tests/src/scenarios/cadre-host-bootstrap.integration.ts, packages/integration-tests/src/scenarios/cadre-host-sse-events.integration.ts, packages/integration-tests/src/scenarios/cadre-host-trust-circle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-orchestrator-lifecycle.integration.ts, packages/integration-tests/src/scenarios/cadre-host-origin-guard.integration.ts, packages/integration-tests/src/scenarios/cadre-host-update-notify.integration.ts, packages/cadre-host/src/installer/__tests__/installer.smoke.test.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/__tests__/server.smoke.test.ts, packages/cadre-host/src/server/__tests__/publishers.test.ts, packages/cadre-host/src/server/__tests__/sse-route.test.ts, packages/cadre-host/src/orchestrator/host-process-orchestrator.ts, packages/cadre-host/src/auth/trust-circle.ts, packages/cadre-host/src/update/__tests__/update-service.integration.test.ts, packages/cadre-host/src/bin/host.ts
---

## Goal

Land a `cadre-host` integration suite under `packages/integration-tests/src/scenarios/` that boots a real `createLocalUiServer` wired against the real `Installer`, `HostProcessOrchestrator`, `TrustCircleService`, `NatService`, and `UpdateService`, and exercises it over the public `127.0.0.1:<port>` HTTP/SSE surface. The unit tests under `packages/cadre-host/src/**/__tests__/` use focused fakes; the seam between modules is currently only covered by the per-module fakes in `server.smoke.test.ts` and `publishers.test.ts`. These new scenarios are what catches a refactor that, say, forgets to forward `orchestrator.onStateChange` into the bus.

## Architecture

### Workspace wiring

`@serfab/integration-tests` does not currently depend on `@serfab/cadre-host` — add it to `dependencies` as `"@serfab/cadre-host": "workspace:*"` so the scenarios can import `Installer`, `createLocalUiServer`, `HostProcessOrchestrator`, `TrustCircleService`, `TrustCircleStore`, `NatService`, `UpdateService`, `signManifestForTesting`, etc. directly. The existing scenarios import `@serfab/cadre-core`; the cadre-host suite is a sibling.

The vitest config already picks up `src/**/*.integration.ts` and runs serially (`singleFork: true`) which is what we want — no SSE port collisions between scenarios.

### New harness module: `TestCadreHost`

The plan stage recommended introducing the harness "once a second scenario needs it". Six scenarios need it, so the DRY trigger has fired. New file `packages/integration-tests/src/harness/test-cadre-host.ts`, re-exported from `harness/index.ts`.

Shape:

```ts
export interface TestCadreHostOptions {
  /** Override the installerVersion stamped into host.config.json. */
  installerVersion?: string;
  /** UpdateService manifest URL override (used by update-notify scenario). */
  manifestUrl?: string;
  /** Settings seed passed to UpdateService. Defaults to { autoApply: false }. */
  updateSettings?: UpdateSettings;
  /** Fetcher to inject into UpdateService (for the in-process manifest server). */
  updateFetcher?: typeof fetch;
  /** Inject a custom CadreNodeLike for trust-circle. Defaults to a fake that
   *  satisfies createInvite / acceptPhone / removePeer / encodeInvite without
   *  spinning up a real libp2p node — same pattern as the existing per-module
   *  fakes but consolidated in one place. */
  cadreNodeForTrustCircle?: CadreNodeLike;
  /** Test-only orchestrator spawn entrypoint — points at idle-child.mjs in the
   *  orchestrator-lifecycle scenario; defaults to the real cadre-cli bin (and
   *  the test must avoid touching createContainer in that case). */
  spawnEntrypoint?: string;
  /** SSE heartbeat (ms) — passed straight to createLocalUiServer. */
  sseHeartbeatMs?: number;
}

export interface TestCadreHost {
  readonly dataDir: string;
  readonly baseUrl: string;             // e.g. "http://127.0.0.1:54321"
  readonly port: number;                // actual bound port (forcePort: 0)
  readonly orchestrator: HostProcessOrchestrator;
  readonly trustCircle: TrustCircleService;
  readonly nat: NatService;
  readonly update?: UpdateService;
  readonly server: LocalUiServer;
  /** Make a loopback request through node:http so we can override the Host
   *  header (fetch refuses). Returns parsed JSON when content-type is JSON. */
  request(opts: { method: string; path: string; body?: unknown; headers?: Record<string, string>; }):
    Promise<{ status: number; headers: Record<string, string>; body: unknown; raw: string; }>;
  /** Open an SSE connection. Resolves with an iterator-style handle over
   *  parsed events; caller calls close() to disconnect. */
  openEventStream(): Promise<TestEventStream>;
  stop(): Promise<void>;
}

export interface TestEventStream {
  /** Wait for the next event whose `type` matches the predicate, or reject
   *  after `timeoutMs` (default: 5_000). */
  next(predicate: (e: LocalUiEvent) => boolean, opts?: { timeoutMs?: number }): Promise<LocalUiEvent>;
  /** All events received so far (in arrival order). */
  received(): LocalUiEvent[];
  close(): void;
}

export async function createTestCadreHost(opts?: TestCadreHostOptions): Promise<TestCadreHost>;
```

Internals:

1. `mkdtempSync(join(tmpdir(), 'integration-cadre-host-'))` for the data dir; tracked for `rm -rf` in `stop()`.
2. Run `new Installer({ platform: detectPlatform(), installerVersion }).install({ nonInteractive: true, dataDir, uiPort: 0, libp2pPort: 0, openBrowser: false, noInvite: true, serviceHost: new FakeServiceHost() })` — this writes `host.config.json` + `identity.key` + `nat.json` + `logs/` exactly the way an operator install would.
3. Re-read the resulting `host.config.json` via `readHostConfig`. Build the live subsystems:
   - `HostProcessOrchestrator({ rootDir: join(dataDir, 'orchestrator'), ...(spawnEntrypoint ? { spawn: { entrypoint: spawnEntrypoint } } : {}) })` + `await orchestrator.init()`.
   - `TrustCircleService({ cadreNode: opts.cadreNodeForTrustCircle ?? defaultFakeCadreNode(), store: new TrustCircleStore(dataDir) })`.
   - `NatService({ rootDir: dataDir, cadreNode: { getPeerId: () => '', getMultiaddrs: () => [] } })`. Call `await natService.start()` but swallow exceptions (the per-module unit tests already cover the UPnP failure mode and we don't want a flaky CI dependent on the host's NAT-PMP behavior — the `cadreNode` stub keeps the libp2p path silent).
   - Optional `UpdateService({ dataDir, currentVersion: '0.0.0-test', settings: opts.updateSettings ?? { autoApply: false }, ...(opts.manifestUrl ? { manifestUrl: opts.manifestUrl } : {}), ...(opts.updateFetcher ? { fetcher: opts.updateFetcher } : {}) })`. Don't call `.start()` — the 24-hour timer is irrelevant to scenarios and we don't want a leaked interval to delay teardown; tests trigger `.check()` explicitly when they need it.
4. `createLocalUiServer({ uiPort: cfg.uiPort, dataDir, orchestrator, trustCircle, nat, update?, forcePort: 0, ...(opts.sseHeartbeatMs ? { sseHeartbeatMs: opts.sseHeartbeatMs } : {}) })` and `await server.start()`. Use the returned `port` to construct `baseUrl = `http://127.0.0.1:${port}``.
5. `stop()`: in order — `server.stop()`, `nat.stop()`, optional `update.stop()`, `rmSync(dataDir, { recursive: true, force: true })`. Each wrapped in try/catch so a broken test doesn't leak the temp dir.

Default fake `CadreNodeLike` for trust-circle (used by every scenario except the trust-circle one when it injects its own):

```ts
function defaultFakeCadreNode(): import('@serfab/cadre-host').CadreNodeLike {
  const issued = new Map<string, { token: string }>();
  return {
    async createInvite(token) {
      const t = token ?? randomBytes(16).toString('base64url');
      issued.set(t, { token: t });
      return {
        invite: {} as never,
        encodedInvite: `cadre://invite/${t}`,
      };
    },
    async acceptPhone() { /* no-op — control-DB writes happen in the integration
                            test that wants real membership */ },
    async removePeer() { /* no-op */ },
    encodeInvite() { return 'cadre://invite/x'; },
    getControlDatabase() { return null; },
  };
}
```

The trust-circle scenario overrides this with the real CadreNode pattern from `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts:36-64` — that's already proven and ~30 lines.

### `harness/fixtures/idle-child.mjs`

A tiny script that, when spawned with the args `start -c <config> --health-port N --metrics-port M --startup-token-file <path>`, writes the startup token from `CADRE_STARTUP_TOKEN` to the token file (so the orchestrator's liveness check passes) and then idles on `setInterval(() => {}, 60_000)`. Used only by the orchestrator-lifecycle scenario via `spawn.entrypoint`. Ignore all stdio (the orchestrator redirects to `node.log`); respond to SIGTERM by exiting 0 so `stopContainer` finishes in <stopTimeoutMs>.

```js
#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
// Find --startup-token-file in argv and write the token from env.
const i = process.argv.indexOf('--startup-token-file');
if (i >= 0 && process.argv[i + 1] && process.env.CADRE_STARTUP_TOKEN) {
  try { writeFileSync(process.argv[i + 1], process.env.CADRE_STARTUP_TOKEN, 'utf8'); } catch {}
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => {}, 60_000);
```

(Verify the actual format the orchestrator writes/reads for `.startup-token` against `packages/cadre-host/src/orchestrator/host-process-orchestrator.ts` and `pid-liveness.ts` before writing the fixture — there's an existing `tokenMatches` helper; mirror its expected contents exactly.)

### `harness/fixtures/manifest-server.ts`

In-process HTTP fixture that binds an ephemeral loopback port and serves a JSON `{ manifest, sig }` envelope at `/latest.json`. Used by the update-notify scenario.

```ts
export interface ManifestFixtureServer {
  url: string;                                  // http://127.0.0.1:<port>/latest.json
  setManifest(envelope: SignedManifest): void;
  close(): Promise<void>;
}
export async function startManifestServer(initial: SignedManifest): Promise<ManifestFixtureServer>;
```

Implementation: `node:http` createServer, `listen({ host: '127.0.0.1', port: 0 })`, handle `GET /latest.json` → `res.end(JSON.stringify(envelope))`. Anything else → 404.

The scenario generates an Ed25519 keypair, sets `process.env.CADRE_HOST_UPDATE_DEV_KEY` to the base64 raw public key (same pattern as `packages/cadre-host/src/update/__tests__/update-service.integration.test.ts:11-15`), signs a manifest with `signManifestForTesting`, then constructs `UpdateService` with `manifestUrl: server.url` and `fetcher: fetch` (the default — since the server is real loopback HTTP, no fetch injection needed).

## Scenarios

Each scenario file follows the existing `.integration.ts` shape from `packages/integration-tests/src/scenarios/`. They all use `beforeEach` to spin up a fresh `TestCadreHost` and `afterEach` to tear it down so no state bleeds across `it` blocks.

### 1. `cadre-host-bootstrap.integration.ts`

The first scenario is intentionally inlined (no `TestCadreHost`) for one reason: it's the test that *proves* the harness's install→start sequence works. If `TestCadreHost.stop()` is broken, the bootstrap test still passes; everyone else gets a useful failure.

Cases:

- **Fresh install → start → /api/status** — write the install, start the server, GET `/api/status`, assert `body.service.name === 'cadre-host'`, `body.service.version` is a non-empty string, `body.service.uptimeSeconds >= 0`, `body.connectivity.portMode` is one of the documented modes, `body.trustCircle === { members: 0, pending: 0 }`.
- **/api/settings reflects host.config.json** — GET `/api/settings`, assert `data.uiPort` matches what install wrote, `data.libp2pPort` matches, `data.upnpEnabled === true` (installer default), `data.dataDir === tmpDataDir`, `data.installId` is a non-empty string.
- **/ serves placeholder HTML in source-tree mode** — same assertion as `server.smoke.test.ts:164-170`. (The SPA bundle isn't expected in CI yet; if `dist/ui/index.html` is present, the test accepts either the placeholder or a real `<html>` document. The point is the route serves text/html with 200, not a hard string match.)
- **Idempotent install** — re-run `Installer.install` against the same data dir and assert `identity.key` byte-equal before/after (mirrors `installer.smoke.test.ts:111-123` but in the integration harness so the seam between installer and server startup is exercised).

### 2. `cadre-host-sse-events.integration.ts`

Uses `TestCadreHost` with `sseHeartbeatMs: 200`. The event stream is opened by `openEventStream()` (raw `node:http` GET on `/api/events` with `accept: text/event-stream`; parses `event:` / `data:` chunks — copy the parser from `packages/cadre-host/src/server/__tests__/sse-route.test.ts:22-41`).

Cases:

- **Initial connectivity event** — open the stream, assert the first non-heartbeat event is `{ type: 'connectivity-changed', portMode: ..., directReachability: ... }`. This catches a regression where the "fire one connectivity-changed at start" path (`server/index.ts:151-160`) gets dropped.
- **Trust-circle invite emits an event** — open the stream, POST `/auth/invites` with `{ label: 'phone' }`, await `next(e => e.type === 'trust-circle-changed')`, assert `kind === 'invited'`.
- **Trust-circle revoke emits an event** — POST `/auth/invites` to issue a token, then `DELETE /auth/invites/:token`, assert `next(...)` yields `{ type: 'trust-circle-changed', kind: 'revoked' }`.
- **Settings PUT does not (currently) emit a settings event** — there's no `settings-changed` event family declared in `events/types.ts`; this case asserts the absence (so a future ticket that adds one is intentional). If/when one is added, update the assertion to capture it instead.
- **NAT settings PUT routes through nat.putSettings** — call `PUT /api/settings` with `{ upnpEnabled: false }`, assert 200, then assert (by checking `nat.getStatus()` via the harness handle, not over HTTP) that the settings store on disk reflects the change. **Note**: there's no `connectivity-changed` route adapter today (see `events/types.ts:12-20` — only the boot-time emission). If this test wants an event, it must come from a future ticket; for now just assert the state mutation.
- **SSE cleanup** — open the stream, send 1 invite, close the stream, assert (via `bus.listenerCount()` accessible through the orchestrator-and-server's `events` field on `TestCadreHost.server`) that no listeners are leaked. Mirrors `sse-route.test.ts:109-117`.

### 3. `cadre-host-trust-circle.integration.ts`

Uses `TestCadreHost` with a custom `cadreNodeForTrustCircle` constructed by standing up a real `CadreNode` (steal the 30-line setup from `packages/cadre-host/src/auth/__tests__/trust-circle-integration.test.ts:36-64`). This is the only scenario that requires the real cadre-core stack.

Cases:

- **Issue → list → redeem → list → revoke-member → list cycle, all over HTTP** —
  1. `POST /auth/invites { label: "Mom's phone" }` → assert 200, capture `body.encodedInvite` and `body.token`.
  2. `GET /auth/trust-circle` → assert `pending.length === 1`, label matches.
  3. Derive a phone peerId from a fresh Ed25519 key (same as `trust-circle-integration.test.ts:76-77`). The HTTP route for redemption is the second-party path: there isn't a `POST /auth/redeem` exposed today — look at `auth/index.ts` for the actual exported handlers and decide whether redemption is HTTP-driven or service-call-driven. **If** there's no HTTP redeem endpoint, drive it via `trustCircle.redeemInvite(...)` directly through the harness handle (the assertion is that the *resulting state* is visible over `GET /auth/trust-circle` and that an event flows through SSE — that's the seam we care about).
  4. `GET /auth/trust-circle` again → `members.length === 1`, `pending.length === 0`.
  5. `DELETE /auth/members/<peerId>` → assert 200.
  6. `GET /auth/trust-circle` → `members.length === 0`.
- **DELETE on a missing token returns 404** — confirms the typed-error → HTTP mapping in `routes/trust-circle.ts` + `error-handler.ts`.
- **Issuing an invite with a blank label returns 400** — confirms the `TrustCircleError('invalid_label', ...)` path → 400.

### 4. `cadre-host-orchestrator-lifecycle.integration.ts`

Uses `TestCadreHost` with `spawnEntrypoint: path.join(import.meta.url, '../harness/fixtures/idle-child.mjs')` (resolve via `fileURLToPath`). The orchestrator's `createContainer` is called via `TestCadreHost.orchestrator.createContainer({ ... })` directly (no HTTP route exists for create today — `/api/nodes/:id/start` is a stub 501). After the child is registered we exercise the HTTP routes.

Cases:

- **GET /api/nodes lists the registered child** — after `createContainer`, GET `/api/nodes`, assert `data.nodes.length === 1`, `nodes[0].status === 'running'`.
- **GET /api/nodes/:id returns the row + stats** — assert `data.node.id` matches, `data.stats` either an object with `cpuPercent` etc. or `null` (per `routes/nodes.ts:43-49`).
- **GET /api/nodes/:id/logs tails the log file** — write something to `<workdir>/node.log` (the idle child won't emit anything on its own; this verifies `tailLogFile` integration with the live workdir).
- **POST /api/nodes/:id/stop transitions to stopped + emits an SSE event** — open an event stream first, POST stop, await `node-state-changed` event with `status: 'stopped'`, assert next `GET /api/nodes/:id` shows `status: 'stopped'`.
- **POST /api/nodes/:id/start returns 501 not_implemented** — pins the v1 stub contract (`routes/nodes.ts:91-101`). A future ticket replaces this once the auto-spawn path lands.
- **GET /api/nodes/unknown returns 404 with `not_found`** — confirms error mapping for the not-found branch.

### 5. `cadre-host-origin-guard.integration.ts`

Uses `TestCadreHost`. Three cases:

- **Loopback request → 200** — `GET /api/status` via the default harness path.
- **Foreign Host header → 403** — same approach as `server.smoke.test.ts:125-147` (node:http with `headers: { host: 'evil.example.com' }`), but assert the body shape too: `{ ok: false, error: { code: 'forbidden_origin', ... } }`.
- **Foreign Origin header (with valid Host) → 403** — node:http with `headers: { host: '127.0.0.1:<port>', origin: 'http://evil.example.com' }`. Confirms the Origin branch (`origin-guard.ts:48-58`) is wired — `server.smoke.test.ts` doesn't cover this.

### 6. `cadre-host-update-notify.integration.ts`

Uses `TestCadreHost` with `manifestUrl: server.url` and an explicit `updateFetcher` only if the manifest server's URL isn't loopback-accessible from the test (it is — so default fetch is fine). The dev key env var is set in `beforeEach` and unset in `afterEach`.

Cases:

- **Manifest with higher version → update-state.json + SSE event** —
  1. Start the manifest server with a signed manifest at `0.7.0` (`currentVersion: '0.0.0-test'`).
  2. Construct the `TestCadreHost` (which builds `UpdateService` against the fixture URL).
  3. Open an SSE stream.
  4. Call `await testHost.update.check()` directly through the harness handle (the route observer in `server/index.ts:163-191` polls every 60 s — too slow; the direct call mirrors what `cadre-host start` does at boot).
  5. **Tickle the server's update-available observer**: the observer only fires on `server.start()`. To get the SSE event, the simplest path is to re-enter the server lifecycle — but that mutates other state. Cleaner: assert the underlying contract directly — `GET /update/state` returns `available: { version: '0.7.0', ... }` and `update-state.json` on disk contains the expected JSON. Then call `testHost.server.events.publish({ type: 'update-available', version: '0.7.0' })` once to verify the SSE delivery path. Acknowledge in a code comment that the "boot-time observer" path is covered by `publishers.test.ts:164-215`; this scenario covers the *manifest → state → HTTP surface* seam end-to-end.
- **No apply mutation** — confirm by inspecting the harness's `UpdateService` state that `applyInProgress` remains undefined. We never call `apply()` and the auto-apply default is `false`. (Belt + suspenders: a global `vi.spyOn` on the executor isn't necessary because `update.check()` never invokes it.)
- **Manifest with equal/older version → no `available`** — restart the manifest server with `0.0.0-test` (same as current); `await update.check()`; assert `state.available` is undefined and `state.lastChecked` is set.
- **Bad signature → `lastError` recorded** — flip the env var to a different public key after signing, call `check()`, assert `state.lastError.code === 'signature_invalid'`. Mirrors `update-service.integration.test.ts:98-...` but goes through the HTTP fixture instead of `fakeFetch`.

## Code-paths exercised (for the reviewer)

These are the contracts the suite asserts. Anything not listed here is *not* under integration coverage:

- `Installer.install` → writes `host.config.json`, `identity.key`, `nat.json`, `logs/` and is idempotent on identity.
- `createLocalUiServer.start()` → binds an ephemeral loopback port and returns the resolved URL.
- `createLocalUiServer` event publishers — `onStateChange` adapter, boot-time `connectivity-changed`, trust-circle `kind: 'invited'/'revoked'` from route adapters. (Update-available observer covered by `publishers.test.ts`, not duplicated here.)
- Route → handler → service wiring for: `/api/status`, `/api/settings` GET+PUT, `/api/nodes` (list + detail + logs + stop + 501 start), `/api/events` (SSE delivery + cleanup), `/auth/invites` POST+DELETE, `/auth/trust-circle` GET, `/auth/members/:peerId` DELETE, `/update/state` GET, `/` (placeholder HTML).
- Origin guard: Host header allowlist + Origin header allowlist, both 403 with `forbidden_origin`.
- Settings PUT propagates to `NatService.putSettings` and `UpdateService.putSettings`.
- `UpdateService.check()` against a real loopback manifest endpoint with signed envelope, dev-key override.
- Error mapping: `TrustCircleError` → 400/404, unknown node → 404, unknown route under `/api/*` → 404.

## Known gaps (deferred to follow-up tickets)

- **Live `cadre-host install` against the real platform service-host** — the manual smoke checklist in `packages/cadre-host/service/README.md` remains the source of truth. Integration tests use `FakeServiceHost`.
- **Real `npm install -g` apply** — the apply path is stubbed in the update scenario; correctness is covered by `update-flow-hardening`.
- **Browser-driven SPA assertions** — no Playwright pass; manual browser-smoke (`scripts/smoke-cadre-host.mjs`) is the v1 story.
- **NAT UPnP against the host network** — `NatService.start()` runs but with a stub `cadreNode`; UPnP probing failures are tolerated.
- **Cross-machine `deliverSeed` from a host-managed node to a remote drone** — covered by `complete/3-deliverSeed-libp2p-v3-handler-signature.md` and the cross-network seed scenarios.
- **`connectivity-changed` SSE on settings change** — there's no route adapter that publishes one today; the scenario asserts state mutation only. If a future ticket adds the publisher, update the SSE scenario to await it.
- **Trust-circle redemption over HTTP** — depending on what `routes/trust-circle.ts` actually exposes today (no obvious `POST /auth/redeem`), the trust-circle scenario may have to drive redemption via `trustCircle.redeemInvite(...)` directly rather than over HTTP. If that's the case, file a follow-up ticket to expose a redeem endpoint (the operator-facing surface is the local UI, which today funnels through `cadre-host invite`; the redeem-side is the *other* device's job).

## Acceptance

- Six scenario files land in `packages/integration-tests/src/scenarios/`.
- `yarn workspace @serfab/integration-tests test` passes locally on Windows (this is a Windows dev box per the recent commit history). The cross-platform CI gap is documented as part of the review handoff.
- Type-check passes: `yarn workspace @serfab/integration-tests build` succeeds with no `any` leaks. Lint clean.
- No leaked Fastify listeners, no leaked tmp dirs (assert by listing `os.tmpdir()` for `integration-cadre-host-*` after a clean test run — should be empty).

## TODO

Phase 1 — workspace + harness foundation

- Add `"@serfab/cadre-host": "workspace:*"` to `packages/integration-tests/package.json` dependencies; run `yarn install` from the repo root and confirm the workspace symlink lands.
- Read `packages/cadre-host/src/orchestrator/pid-liveness.ts` and the `tokenMatches` helper to confirm what `.startup-token` must contain for re-attach to pass; align the `idle-child.mjs` fixture with it.
- Create `packages/integration-tests/src/harness/fixtures/idle-child.mjs` with the SIGTERM-handling idle loop described above.
- Create `packages/integration-tests/src/harness/fixtures/manifest-server.ts`.
- Implement `packages/integration-tests/src/harness/test-cadre-host.ts` with the shape described above. Re-export from `harness/index.ts`.

Phase 2 — scenarios

- `cadre-host-bootstrap.integration.ts` (inline setup; no `TestCadreHost`).
- `cadre-host-origin-guard.integration.ts` (cheapest second scenario; smokes the harness).
- `cadre-host-sse-events.integration.ts`.
- `cadre-host-orchestrator-lifecycle.integration.ts` (depends on `idle-child.mjs`).
- `cadre-host-trust-circle.integration.ts` (depends on real `CadreNode` setup — copy the 30-line block from `auth/__tests__/trust-circle-integration.test.ts`).
- `cadre-host-update-notify.integration.ts` (depends on `manifest-server.ts`).

Phase 3 — validate + hand off

- `yarn workspace @serfab/integration-tests test 2>&1 | tee /tmp/cadre-host-integration.log` (stream output; no silent `> log` redirection — the runner kills on 10 min idle).
- `yarn workspace @serfab/integration-tests build` to confirm typecheck.
- Inspect `os.tmpdir()` after the test run; if any `integration-cadre-host-*` directories remain, fix the offending teardown.
- Update the review-handoff with: the six exercised seams (above), the known-gaps list (above), and the cross-platform CI status (Windows-only smoke today; Linux/macOS CI gap remains).
