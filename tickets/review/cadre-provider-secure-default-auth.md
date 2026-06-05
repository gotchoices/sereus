description: Review closed-by-default provider auth + permission scope enforcement (incl. a new auth-skip precision fix)
files: packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/permissions.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/config/validate.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/README.md, packages/cadre-provider/src/server/__tests__/permissions.test.ts, packages/cadre-provider/src/server/__tests__/auth-scope-enforcement.test.ts, packages/cadre-provider/src/config/__tests__/auth-closed-default.test.ts
----

# Review: cadre-provider secure-default auth + scope enforcement

`@serfab/cadre-provider` was previously open-by-default: `DEFAULT_CONFIG.auth.mode` was
`'none'`, and `'none'` mode injects a wildcard `dev-customer { permissions: ['*'] }` into
every request — so a provider started with no config authenticated nobody and isolated
no one. Permission scopes existed on identities but were never checked at routes.

This ticket closes both gaps: **fail-closed default** (`api-key`, rejects all calls with
no keys), **explicit opt-in** for the insecure `none` mode (`allowInsecureNoAuth` /
`PROVIDER_ALLOW_INSECURE_NO_AUTH`), and **per-route scope enforcement** (`403
INSUFFICIENT_SCOPE`).

## Provenance — read this first

- The **source + docs** for closed-default auth and scope enforcement landed earlier in
  commit `eeee104` (scope-leaked from an unrelated ticket). That covers `config/types.ts`,
  `config/loader.ts`, `config/validate.ts` (new), `server/auth.ts`, `server/permissions.ts`
  (new), `server/routes.ts`, `index.ts`, and `README.md`. I **re-verified** all of it
  against the spec — it matches.
- This run added the **test coverage** (3 new test files) that was never committed, AND a
  **new source fix** described next.

## ⚠️ New source change this run — scrutinize this (NOT in eeee104)

While re-verifying, I found the spec's `GET /billing/status → billing:read` requirement was
**unreachable**. The auth `preHandler` skipped auth for any URL ending in `/status`
(`request.url.endsWith('/status')`) to make the health endpoint public — but
`/api/v1/billing/status` *also* ends in `/status`. So that route was silently
unauthenticated: `request.customer` was never set and the handler returned `401` for
everyone, meaning `billing:read` could never be enforced (and, pre-ticket, the route was
effectively dead — it always 401'd).

Fix (mirrors the spec's intent that `/status` is skipped but `/billing/status` is gated):
- `server/auth.ts`: `AuthContext` gained a required `basePath: string`. The skip now
  compares the **exact** path (query stripped) against `${basePath}/status` and
  `${basePath}/health` instead of a loose `endsWith`.
- `server/server.ts`: `basePath` is now computed *before* `registerAuth` and passed in.

This is a behavior change beyond the eeee104 set — the reviewer should confirm it's the
right call. `AuthContext` is exported from the package index, so this is technically a
breaking interface change (new required field); grep confirmed `registerAuth`/`AuthContext`
has no callers outside the package.

## What to validate

Build + type-check (tsc) and the vitest suite, streamed:

```
yarn workspace @serfab/cadre-provider build      # exit 0 (tsc, also the type-check)
yarn workspace @serfab/cadre-provider test       # 70 passed (11 files)
```

Results this run: **build exit 0**, **70/70 tests pass**, lint on changed files **0 errors**
(2 pre-existing `no-explicit-any` *warnings* at `auth.ts:60,138` — the long-standing
`(request as any).customer` cast, not introduced here).

## Behavior to confirm (use cases)

Closed-by-default:
- `loadConfig()` (no file, no env) → `auth.mode === 'api-key'`, no `apiKeyHashes`.
- A server from that config + `Authorization: Bearer <unmatched>` → `401` on
  `POST /containers`. No `Authorization` header → `401`.
- `GET /api/v1/status` is still reachable with no auth.

`none` opt-in gate:
- `loadConfig({ overrides: { auth: { mode: 'none' } } })` **throws**; error text mentions
  `allowInsecureNoAuth`. `createProviderServer({ config: { auth: { mode: 'none' } ... } })`
  **rejects** (defense-in-depth in `registerAuth`).
- `{ mode: 'none', allowInsecureNoAuth: true }` (or `PROVIDER_AUTH_MODE=none` +
  `PROVIDER_ALLOW_INSECURE_NO_AUTH=true`) → server starts; requests get the `dev-customer`
  wildcard (e.g. `GET /containers` → `200`).

Scope enforcement (driven via `app.inject` + an `authHooks.validateApiKey` that returns a
chosen `permissions` array under `mode: 'api-key'`):
- `['containers:read']` → `GET /containers` `200`; `POST /containers`,
  `DELETE /containers/:id`, `PUT .../seed` all `403 INSUFFICIENT_SCOPE` (scope is checked
  *before* the container lookup, so a bogus id still 403s).
- `['containers:create']` → `POST /containers` `201`, `GET /containers` `403`.
- `['*']` → containers + `billing:status` all pass scope.
- `['containers:*']` → containers pass, `GET /billing/status` → `403`.
- `GET /billing/plans` needs no scope (passes even with `permissions: []`).
- `hasPermission` unit: `'*'` matches anything; `'containers:*'` matches `containers:read`
  not `billing:read`; exact match; empty array matches nothing; no prefix-boundary leak
  (`containers:*` ✗ `containersx:read`).

Test files added:
- `src/server/__tests__/permissions.test.ts` — `hasPermission` unit matrix.
- `src/config/__tests__/auth-closed-default.test.ts` — `loadConfig`/`validateAuthConfig`
  default + opt-in + env paths (snapshots/restores `PROVIDER_*` auth env vars).
- `src/server/__tests__/auth-scope-enforcement.test.ts` — server-level closed-default,
  `none` gate, and the full scope matrix via `app.inject`.

## Known gaps / where my tests are a floor, not a ceiling

- **OAuth/JWT scope path is untested.** All scope tests drive the `api-key` +
  `validateApiKey` hook. The `oauth`/`validateJwt` branch produces a `CustomerIdentity` the
  same way, so scope enforcement *should* behave identically, but there is no test
  exercising a JWT-derived narrowed identity. Worth a glance.
- **Store-key path is untested at the route level.** The spec offered "or a store key" as an
  alternative to the hook; I only used the hook. The default `store.getApiKey` lookup that
  builds `{ permissions: apiKey.permissions }` and feeds the scope gate has no end-to-end
  route test here (the store layer itself is tested elsewhere).
- **No multi-tenant ownership-vs-scope interaction test.** Ownership checks
  (`container.customerId !== customer.customerId`) are unchanged and were already covered
  for the shutdown paths, but I didn't add a case proving scope + ownership compose (e.g. a
  scoped caller hitting *another* customer's container — should be `403 FORBIDDEN` after
  passing the scope gate). Cheap to add if the reviewer wants it.
- **The auth-skip fix changes a public interface.** If any out-of-tree consumer constructs
  `registerAuth` directly, they now must pass `basePath`. In-repo there are none.
- **`bin/provider.ts` not re-touched.** `start`/`check` both route through `loadConfig`,
  which now calls `validateAuthConfig`, so the CLI surfaces the `none`-without-opt-in error
  before binding a port — but I did not add a CLI-level test for that path.
