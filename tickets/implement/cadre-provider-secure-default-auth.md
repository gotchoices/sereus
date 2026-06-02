description: Make provider auth closed-by-default, gate 'none' mode behind explicit opt-in, and enforce permission scopes at routes
files: packages/cadre-provider/src/config/types.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/server/permissions.ts (new), packages/cadre-provider/src/bin/provider.ts, packages/cadre-provider/README.md, packages/cadre-provider/src/server/__tests__/shutdown-after.test.ts, packages/cadre-provider/src/service/__tests__/container-seed-endpoint.test.ts
----

`@serfab/cadre-provider` is the multi-tenant Docker host. Today a provider launched with no config runs fully open: `DEFAULT_CONFIG.auth.mode` is `'none'` (`config/types.ts:117-119`), and in `'none'` mode `registerAuth` injects a synthetic wildcard identity `{ customerId: 'dev-customer', permissions: ['*'] }` into every request (`server/auth.ts:45-51`). Because `cadre-provider start` falls back to `DEFAULT_CONFIG` when no `--config` is given (`bin/provider.ts:37-45`), every caller becomes the same all-powerful customer — authentication and per-customer isolation are both bypassed. Separately, permission scopes are never enforced: routes check only the *presence* of `request.customer`, never whether the identity holds a scope for the action.

This ticket closes both gaps. The work is independent of the port-leak ticket and can land in either order.

## Closed-by-default auth

The fresh-start behavior must be **fail-closed**, and running with no authentication must be a deliberate, unmistakable opt-in rather than a silent fallback.

**Default mode.** Change `DEFAULT_CONFIG.auth.mode` from `'none'` to `'api-key'`. With no keys configured, every authenticated request returns `401` (the existing `api-key` path already does this when no hash matches and the store has no key). A provider started with zero config is therefore reachable but rejects all privileged calls — closed, not open.

**Explicit opt-in for `'none'`.** Add an acknowledgement to `AuthConfig`:

```ts
export interface AuthConfig {
  mode: 'none' | 'api-key' | 'oauth';
  /**
   * Required to run with mode 'none'. When mode is 'none' and this is not
   * true, the provider refuses to start. 'none' disables authentication and
   * grants every caller a wildcard identity — only for local/dev use.
   */
  allowInsecureNoAuth?: boolean;
  apiKeyHashes?: string[];
  jwksUri?: string;
  issuer?: string;
  audience?: string;
}
```

Wire an env override in `loadEnvConfig`: `PROVIDER_ALLOW_INSECURE_NO_AUTH === 'true'` → `auth.allowInsecureNoAuth = true` (only when `PROVIDER_AUTH_MODE` is also being set, matching the existing pattern where `config.auth` is constructed under the `PROVIDER_AUTH_MODE` guard — so set the flag inside that same block).

**Validation chokepoint.** Add a `validateAuthConfig(auth: AuthConfig): void` helper (in `config/loader.ts` or a small `config/validate.ts`) that throws a clear `Error` when `auth.mode === 'none' && auth.allowInsecureNoAuth !== true`:

> `auth.mode 'none' disables authentication and runs fully open. Set auth.allowInsecureNoAuth=true (or PROVIDER_ALLOW_INSECURE_NO_AUTH=true) to acknowledge, or use 'api-key'/'oauth'.`

Call it in two places for defense in depth:
- `loadConfig` (after the final merge) — so both `cadre-provider start` and `cadre-provider check` surface the error before anything binds a port.
- `registerAuth` (or `createProviderServer` before `registerAuth`) — so programmatic construction that bypasses `loadConfig` can't silently go open either.

When the opt-in IS present, `'none'` mode keeps its current behavior (wildcard `dev-customer`) — that path is intentionally unchanged; it just can no longer be reached implicitly.

## Permission scope enforcement

Define a tiny scope model and enforce it at every privileged/customer-scoped route, so an authenticated identity is constrained to the operations its `permissions` array allows. Ownership checks (`container.customerId !== customer.customerId`) already exist on the per-container routes and stay as-is — scopes are the second, orthogonal gate.

New module `server/permissions.ts`:

```ts
/** Permission scopes used by provider routes. */
export const Scope = {
  ContainersRead: 'containers:read',
  ContainersCreate: 'containers:create',
  ContainersDelete: 'containers:delete',
  ContainersSeed: 'containers:seed',
  BillingRead: 'billing:read',
} as const;
export type Scope = typeof Scope[keyof typeof Scope];

/**
 * True if `permissions` grants `scope`. Supports the global wildcard '*'
 * and per-resource wildcards like 'containers:*', plus exact matches.
 */
export function hasPermission(permissions: string[], scope: string): boolean;
```

`hasPermission` semantics: `'*'` grants everything; `'<resource>:*'` grants any scope with that resource prefix; otherwise exact string match. The existing wildcard identities (`['*']` for `none`-mode dev-customer, static `apiKeyHashes` admin, and store keys that carry `['*']`) therefore continue to pass all checks. Store/JWT-derived identities with narrower scopes (e.g. `['containers:read']`) are now actually constrained.

Route → required scope mapping (apply *after* the existing `customer` presence check, before doing work; on failure return `403` with code `INSUFFICIENT_SCOPE`):

| Route | Scope |
|-------|-------|
| `POST /containers` | `containers:create` |
| `GET /containers` | `containers:read` |
| `GET /containers/:id` | `containers:read` |
| `GET /containers/:id/peer` | `containers:read` |
| `DELETE /containers/:id` | `containers:delete` |
| `PUT /containers/:id/seed` | `containers:seed` |
| `GET /billing/status` | `billing:read` |
| `GET /billing/plans` | none (already unauthenticated listing) |
| `GET /status` | none (skipped by auth hook) |

Add a small inline guard helper in `routes.ts` to keep handlers DRY, e.g.:

```ts
function requireScope(reply: FastifyReply, customer: CustomerIdentity, scope: string): boolean {
  if (hasPermission(customer.permissions, scope)) return true;
  errorResponse(reply, 'INSUFFICIENT_SCOPE', `Missing required scope: ${scope}`, 403);
  return false;
}
```

…and in each handler: `if (!requireScope(reply, customer, Scope.ContainersCreate)) return reply;` (mirror the existing presence-check return style).

## Docs

Update `README.md`: document that the default is now closed (`api-key` with no keys rejects all calls), that `mode: 'none'` requires `allowInsecureNoAuth: true` / `PROVIDER_ALLOW_INSECURE_NO_AUTH=true`, and list the permission scopes and which routes require them. Update the `auth:` example block accordingly.

## Existing-test fallout

Several tests construct config with `auth: { mode: 'none' }` and rely on the wildcard identity to exercise routes. After this change those constructions must acknowledge the insecure mode or they will throw at server creation. Grep for `mode: 'none'` under `packages/cadre-provider` and add `allowInsecureNoAuth: true` to each (known: `server/__tests__/shutdown-after.test.ts:19`, and check `service/__tests__/container-seed-endpoint.test.ts`). The wildcard `['*']` identity these tests get still satisfies every scope guard, so no other changes are needed in them.

## Key tests (add)

In the spirit of TDD, the implementation should be covered by:

- **Default is closed:** `loadConfig()` (no file, no env) → `config.auth.mode === 'api-key'`. A server built from it, with no keys and an `Authorization` header that matches nothing, returns `401` on `POST /containers`.
- **`none` without opt-in is rejected:** `loadConfig({ overrides: { auth: { mode: 'none' } } })` throws; and `createProviderServer` with `{ auth: { mode: 'none' } }` (no flag) rejects. Error message mentions `allowInsecureNoAuth`.
- **`none` with opt-in works:** config `{ mode: 'none', allowInsecureNoAuth: true }` (or `PROVIDER_AUTH_MODE=none` + `PROVIDER_ALLOW_INSECURE_NO_AUTH=true`) → server starts and requests receive the `dev-customer` wildcard identity (existing route behavior).
- **Scope enforcement:** drive routes via `app.inject` with an injected identity (use an `authHooks.validateApiKey` returning a chosen `permissions` array under `mode: 'api-key'`, or a store key):
  - `permissions: ['containers:read']` → `GET /containers` `200`, but `POST /containers` and `DELETE /containers/:id` and `PUT .../seed` return `403 INSUFFICIENT_SCOPE`.
  - `permissions: ['containers:create']` → `POST /containers` `201`, `GET /containers` `403`.
  - `permissions: ['*']` → all routes pass scope (subject to ownership/validation as before).
  - `permissions: ['containers:*']` → all `containers:*` routes pass, `billing:read` does not.
- **`hasPermission` unit tests:** `'*'` matches anything; `'containers:*'` matches `containers:read` but not `billing:read`; exact match; empty array matches nothing.

## TODO

- [ ] Add `allowInsecureNoAuth?: boolean` to `AuthConfig` (`config/types.ts`); change `DEFAULT_CONFIG.auth.mode` to `'api-key'`.
- [ ] `loadEnvConfig`: set `auth.allowInsecureNoAuth = true` when `PROVIDER_ALLOW_INSECURE_NO_AUTH === 'true'` (inside the existing `PROVIDER_AUTH_MODE` block).
- [ ] Add `validateAuthConfig(auth)`; call it in `loadConfig` (post-merge) and in `registerAuth`/`createProviderServer`.
- [ ] New `server/permissions.ts` with `Scope` constants + `hasPermission`; unit-test it.
- [ ] Add `requireScope` guard in `routes.ts` and apply the route→scope mapping above; return `403 INSUFFICIENT_SCOPE`.
- [ ] Update `README.md` (closed default, opt-in for `none`, scope table).
- [ ] Fix existing tests that use `mode: 'none'` to add `allowInsecureNoAuth: true`.
- [ ] Add the scope-enforcement and default-closed tests above.
- [ ] Run `yarn workspace @serfab/cadre-provider build` and the package's vitest suite; ensure type-check and tests pass. Stream output with `| tee`.
