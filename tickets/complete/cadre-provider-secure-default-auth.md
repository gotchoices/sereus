description: Closed-by-default provider auth + per-route permission scope enforcement, incl. precise /status auth-skip fix
files: packages/cadre-provider/src/server/auth.ts, packages/cadre-provider/src/server/server.ts, packages/cadre-provider/src/server/permissions.ts, packages/cadre-provider/src/server/routes.ts, packages/cadre-provider/src/config/validate.ts, packages/cadre-provider/src/config/loader.ts, packages/cadre-provider/src/config/types.ts, packages/cadre-provider/README.md, packages/cadre-provider/src/server/__tests__/permissions.test.ts, packages/cadre-provider/src/server/__tests__/auth-scope-enforcement.test.ts, packages/cadre-provider/src/config/__tests__/auth-closed-default.test.ts
----

# Complete: cadre-provider secure-default auth + scope enforcement

`@serfab/cadre-provider` is now **fail-closed by default**. `DEFAULT_CONFIG.auth.mode` is
`api-key` (with no keys → every privileged route 401s), the insecure `none` mode requires
an explicit `allowInsecureNoAuth` / `PROVIDER_ALLOW_INSECURE_NO_AUTH` acknowledgement
(enforced both at `loadConfig` and defensively in `registerAuth`), and every privileged
route enforces a permission scope (`403 INSUFFICIENT_SCOPE`) ahead of the container lookup
and ownership check.

The source/docs landed in `eeee104` (scope-leaked from `sapp-schema-signature-gate-enforce`);
the implement run (`4a26ed6`) added the three test files plus a new source fix for the
`/status` auth-skip (see below). This review pass verified all of it and added two
interaction tests.

## Review findings

### Scope of review
Read the implement diff (`4a26ed6`) and the leaked source (`eeee104`) with fresh eyes, then
the full current state of `auth.ts`, `server.ts`, `permissions.ts`, `routes.ts`,
`config/{validate,loader,types}.ts`, `README.md`, and all three test files.

### Build / lint / tests
- `yarn workspace @serfab/cadre-provider build` → **exit 0** (tsc type-check clean).
- `yarn workspace @serfab/cadre-provider test` → **72 passed** (11 files; was 70, +2 added
  this pass).
- `eslint` on all changed files → **0 errors**. 9 pre-existing `no-explicit-any` *warnings*
  remain from the long-standing `(request as any).customer` cast (2 in `auth.ts`, 7 in
  `routes.ts`); not introduced here, tolerated at `warn` level. See "pre-existing debt".

### The new source change this run (auth-skip precision fix) — verified correct
The implement run replaced `request.url.endsWith('/status') || …endsWith('/health')` with an
exact, query-stripped compare against `${basePath}/status` and `${basePath}/health`, threading
a new required `AuthContext.basePath` set from the same `basePath` variable that feeds
`registerRoutes` (server.ts:111 — single source, so route paths and skip paths cannot drift).
- **Correct and necessary**: pre-fix, `/api/v1/billing/status` ended in `/status` and was
  silently skipped → `request.customer` unset → handler always 401'd, so `billing:read` was
  unenforceable and the route effectively dead. Post-fix it authenticates + scope-gates.
- **Regression is locked in**: reverting to the `endsWith` skip would make the
  `['*']` test (expects billing `200`) and `['containers:*']` test (expects billing `403`)
  fail with `401`, because the hook identity would never be attached. Confirmed by reasoning
  through the revert.
- **Interface change is safe**: `AuthContext`/`registerAuth` are exported from the package
  index but have no callers outside the package (grep-confirmed; the only `registerAuth*`
  hits elsewhere are an unrelated `registerAuthorityPeer` in integration-tests). Pre-1.0, no
  back-compat concern per AGENTS.md.

### Correctness / behavior — confirmed
- `hasPermission` wildcard logic (`*`, `<resource>:*`, exact, empty-set, no prefix-boundary
  leak) — correct; unit matrix covers it.
- Scope is checked *before* container lookup and ownership (routes.ts), so a bogus id 403s on
  scope — covered.
- Closed default, `none`-without-ack throw (loadConfig + server construction), env opt-in
  paths — covered.
- README auth/permissions section and the route→scope table match `routes.ts` exactly
  (`billing:read` for `/billing/status`; `/billing/plans` and `/status` public). Docs are
  current.

### Tests added this pass (minor — filled flagged floor gaps)
Both were called out in the handoff as untested; cheap and high-value for security code:
- **scope + ownership compose**: a wildcard-scoped caller hitting *another* customer's
  container clears the scope gate but gets `403 FORBIDDEN` (not `INSUFFICIENT_SCOPE`),
  proving the two gates compose and order correctly.
- **oauth/JWT scope enforcement**: a `validateJwt`-derived narrowed identity
  (`['containers:read']`) is scope-enforced identically to api-key (`GET` 200, `POST` 403),
  covering the previously-untested oauth branch.

### Findings filed as new tickets
None. No major issues found.

### Minor observations (no action taken — documented, not defects)
- **Pre-existing `(request as any).customer` debt** (9 warn-level lint hits): could be
  removed cleanly via a Fastify module augmentation (`declare module 'fastify'` adding
  `customer?: CustomerIdentity`). Pre-existing, orthogonal to this ticket's security scope,
  and tolerated at `warn`; left untouched to keep the pass focused.
- **`${basePath}/health` is in the auth-skip list but no `/health` route is registered**
  (only `/status` exists). Harmless — an unauthenticated request to `/health` just 404s.
- **`PROVIDER_AUTH_MODE` is cast to the union without validation**: a typo'd mode is not
  `none`/`api-key`/`oauth`, so it matches no branch in `auth.ts` and every call 401s —
  fails *closed*, which is the safe direction.

### Remaining floors not exercised (acceptable, noted)
- The default `store.getApiKey` → `{ permissions }` path is not route-tested here (store
  layer tested elsewhere); the hook path that feeds the identical scope gate is covered.
- API-key expiry / `apiKeyHashes` admin-key (`['*']`) route paths are not exercised
  end-to-end. Low risk — same downstream gate as the tested hook path.

## End
