description: Reconcile ContainerStatusResponse.health with the real /status wire shape — strands live under node.strands, not at the top level. Reuse ContainerHealthStatus and have getContainerStatus parse /status into that type (via fetchContainerHealthStatus) instead of assigning an untyped `any`, so this class of drift is compiler-caught.
files: packages/cadre-provider/src/types.ts, packages/cadre-provider/src/service/container-service.ts, packages/cadre-provider/src/service/container-health.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-provider/src/service/__tests__/billing-collect-usage.test.ts
----

## Problem (confirmed)

`ContainerStatusResponse.health` (`packages/cadre-provider/src/types.ts:86-95`) declares strand
counts at the **top level** (`health.strands.{total,active,idle,hibernating}`). The real `/status`
payload emitted by the cadre-cli health server is the `HealthStatus` shape
(`packages/cadre-cli/src/server/health.ts:17-40, 130-144`), where strands live under
**`node.strands`** — never at the top level.

`ContainerService.getContainerStatus` (`container-service.ts:170-189`) assigns the parsed `/status`
JSON straight into `response.health`:

```ts
if (healthRes.ok) {
  response.health = await healthRes.json();   // runtime shape: { ..., node: { strands } }
}
```

This only compiles because `Response.json()` is typed `any`. At runtime `response.health.strands`
is `undefined` (the data is at `response.health.node.strands`), so any consumer trusting the
declared type reads `undefined`.

## Verification done in fix stage

- **Wire shape confirmed:** `HealthServer.getHealthStatus()` (`health.ts:130-144`) builds
  `{ status, timestamp, uptime, peerId, multiaddrs, node: { ..., strands: {...} } }` — strands are
  strictly under `node`.
- **No runtime crash today:** the *only* consumer of `response.health` is the route handler
  `GET /containers/:id` (`routes.ts:128-151`), which forwards the whole `status` object verbatim as
  JSON. A repo-wide grep for `health.strands` / `health.node` found **no** code reading
  `response.health.strands`. So the harm is a lying type contract, not a thrown error.
- **`node.strands` is the proven path:** the billing tests
  (`billing-collect-usage.test.ts:55-59, 72-74, 92-94, 112-114`) already mock `/status` with the
  real `node: { strands: {...} }` body and assert the billing path reads it correctly via the
  `ContainerHealthStatus` type / `fetchContainerHealthStatus` helper introduced for
  `cadre-provider-billing-not-persisted`. That helper is the natural source of truth here.

## Chosen approach — reconcile the type to reality (reuse `ContainerHealthStatus`)

Of the two options in the source ticket, take the **lower-risk "reconcile to reality"** path
rather than mapping `node.strands` up to a flat field:

- It is DRY (AGENTS.md): `ContainerHealthStatus` already exists in
  `container-health.ts:26-32` and is the wire-accurate type the billing path consumes.
- It makes `getContainerStatus` reuse the existing `fetchContainerHealthStatus(container)` helper
  instead of doing its own fetch + `any` parse — one place that knows the `/status` shape, so the
  compiler catches future drift.
- AGENTS.md says "Don't worry about backwards compatibility yet", so changing the public `health`
  contract from `health.strands` to `health.node.strands` is acceptable. The previously-declared
  `health` only exposed `{ status, uptime, strands }`; reconciling to `ContainerHealthStatus`
  (`{ status, uptime, node?: { strands? } }`) loses nothing that was declared and gains correctness.

### Target shape

`ContainerStatusResponse.health` becomes `ContainerHealthStatus | undefined`:

```ts
import type { ContainerHealthStatus } from './service/container-health.js';

export interface ContainerStatusResponse {
  container: Container;
  health?: ContainerHealthStatus;
}
```

`getContainerStatus` collapses its bespoke fetch/try-catch into the shared helper:

```ts
if (container.status === 'running') {
  response.health = await fetchContainerHealthStatus(container);
}
```

(`fetchContainerHealthStatus` already short-circuits to `undefined` when `healthEndpoint` is
missing, the fetch throws, or the response is non-OK — so the existing `&& container.healthEndpoint`
guard and the inline try/catch both become redundant and should be removed. The current code also
imports `statusUrlFromHealthEndpoint` directly; once the helper is used that import is dead — drop
it if no longer referenced.)

Note `ContainerHealthStatus.node.strands` is optional, so downstream code that wants strand counts
must read `response.health?.node?.strands?.active ?? 0` (matching how the billing path already
treats it). Document that in the type doc-comment if helpful.

## Watch-outs

- `types.ts` importing from `service/container-health.js` introduces a `types -> service` import
  edge. Confirm this doesn't create a cycle (`container-health.ts` imports only `Container` from
  `../types.js`, which is type-only, so a `type`-only import both directions should be fine — keep
  the import in `types.ts` as `import type`). If the lint/build complains about layering, the
  fallback is to move `ContainerHealthStatus`/`ContainerStrandCounts` into `types.ts` and have
  `container-health.ts` import them from there. Prefer the simple `import type` first.
- `fetchContainerHealthStatus` returns `ContainerHealthStatus | undefined`; assigning to optional
  `health?` is fine (assigning `undefined` is equivalent to leaving it unset for JSON output).

## TODO

- [ ] In `types.ts`: change `ContainerStatusResponse.health` to `ContainerHealthStatus | undefined`
      via `import type { ContainerHealthStatus } from './service/container-health.js'`. Remove the
      inline top-level `strands` block. Verify no import cycle (fall back to relocating the type into
      `types.ts` only if the build/lint flags a layering problem).
- [ ] In `container-service.ts` `getContainerStatus`: replace the manual
      `fetch(statusUrlFromHealthEndpoint(...))` + `response.health = await healthRes.json()` block
      with `response.health = await fetchContainerHealthStatus(container)` guarded on
      `container.status === 'running'`. Update the import (drop `statusUrlFromHealthEndpoint` if now
      unused; add `fetchContainerHealthStatus`).
- [ ] Add a test (new `container-service.getContainerStatus` test under
      `packages/cadre-provider/src/service/__tests__/`) that mocks `fetch` with the real
      `HealthStatus`-shaped body (`{ status:'healthy', uptime, node:{ strands:{...} } }`) for a
      `running` container with a `healthEndpoint`, calls `getContainerStatus`, and asserts:
        - `result.health?.node?.strands?.active` equals the mocked active count (contract now honest),
        - the fetch hit the derived `/status` URL (mirror `billing-collect-usage.test.ts:79`),
        - `health` is `undefined` when the container is not `running` / fetch fails (helper degrades).
      Reuse the `jsonResponse` / fetch-mock pattern from `billing-collect-usage.test.ts:28-31, 45-46`.
- [ ] Build + typecheck the package: `yarn workspace @serfab/cadre-provider build` (stream output
      with `2>&1 | tee`). Confirm the `any`-assignment is gone and the type now flows.
- [ ] Run the provider test suite: `yarn workspace @serfab/cadre-provider test 2>&1 | tee /tmp/provider-test.log`.
      The existing billing tests must stay green (they already assert the `node.strands` shape).
- [ ] Handoff to review: note that this is a deliberate public-contract change for
      `GET /containers/:id` (`health.strands` -> `health.node.strands`), justified by AGENTS.md's
      "no backwards compatibility yet" stance and DRY reuse of `ContainerHealthStatus`. If any docs
      describe the old flat `health.strands` shape, flag/update them (none found in fix-stage grep,
      but reviewer should double-check `docs/`).
