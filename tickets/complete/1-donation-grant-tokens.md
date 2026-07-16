description: The "grant token" layer for cadre-host — lets the host owner hand out redeemable tokens so a specific friend/family member can ask the host to donate nodes, capped per grantee. Issuance, validation, and quota only; the service that actually provisions nodes is a later ticket.
prereq:
files: packages/cadre-host/src/donation/types.ts, packages/cadre-host/src/donation/grant-store.ts, packages/cadre-host/src/donation/grant-service.ts, packages/cadre-host/src/donation/index.ts, packages/cadre-host/src/donation/__tests__/grant-store.test.ts, packages/cadre-host/src/donation/__tests__/grant-service.test.ts, packages/cadre-host/src/server/routes/grants-admin.ts, packages/cadre-host/src/server/__tests__/grants-admin-route.test.ts, packages/cadre-host/src/server/index.ts, packages/cadre-host/src/server/error-handler.ts, packages/cadre-host/src/bin/host.ts, packages/cadre-host/src/index.ts
----

# Complete: donation grant-token layer

## What shipped

The **grant-token layer** for cadre-host — the social-scale analogue of
cadre-provider's API-key gate. A grant token authorises one *grantee* (a
friend/family member's cadre authority) to ask this host to donate cadre nodes,
up to a per-grantee cap. This ticket delivered **only** issuance, validation, and
quota; the lifecycle service that consumes a validated grant to provision a node
is the downstream `2-donation-service` ticket, which imports the `GrantValidator`
interface defined here.

- `src/donation/types.ts` — `Grant`, `GrantDenyReason`, `GrantValidation`,
  `GrantValidator`, `GrantFile`, `GrantAdminHandlers`, `GrantError` /
  `GrantErrorCode`.
- `src/donation/grant-store.ts` — `GrantStore`, atomic JSON store at
  `<dataDir>/grants.json` (write-then-rename), modelled on `TrustCircleStore`.
- `src/donation/grant-service.ts` — `GrantService implements GrantValidator`:
  synchronous `issue` / `validate` / `validateForProvision` / `revoke` / `list`,
  plus `createGrantAdminHandlers`.
- `src/donation/index.ts` — re-exports.
- `src/server/routes/grants-admin.ts` — loopback admin surface
  `POST/GET /grants-admin`, `DELETE /grants-admin/:token` (no bearer).
- `src/server/index.ts` — optional `grants?: GrantService`; mounts admin routes.
- `src/server/error-handler.ts` — `GrantError` → HTTP status mapping.
- `src/bin/host.ts` — `grant issue|list|revoke` CLI (thin HTTP clients).
- `src/index.ts` — exports the donation surface.

## Review findings

Adversarial pass over the implement diff (commit `db96b98`), read before the
handoff. Checked correctness, DRY, modularity, type safety, error handling,
resource cleanup, security posture, and test coverage across happy/edge/error
paths.

### Fixed inline (minor)

- **`GrantStore.save()` write failures leaked a bare `Error`.** `load()`
  carefully wraps read/parse I/O in `GrantError('storage_error')` (→ 500), but
  `save()` let a `writeFileSync`/`renameSync` failure (disk full, permission,
  path collision) escape as a generic `Error` → error-handler code `"internal"`.
  Wrapped the write/rename in the same `storage_error` mapping so a failed
  `issue`/`revoke` reads consistently. Added a test that forces the temp-file
  write to fail (`grant-store.test.ts` → "wraps a write failure as
  storage_error"). Donation suite now 31 tests (was 30).

### Checked, no change needed

- **Security posture / loopback-only mount.** Confirmed `/grants-admin` is gated
  the same as every other management route: `registerOriginGuard` is a **global
  `onRequest` hook** on the Fastify app (`server/index.ts:143`), so the
  no-bearer admin routes inherit the Host/Origin check + `127.0.0.1` bind. The
  code comment's `docs/cadre-host.md § Security posture` reference resolves
  (section exists at line 105). DNS-rebind/CSRF from a browser page is defeated
  by the origin guard. Genuinely loopback-only — verified, not assumed.
- **Quota-edge race** (two concurrent provisions both seeing count = N-1 pass).
  Not a defect in this layer: `validateForProvision` is a pure function of the
  caller-supplied count; serialisation is `2-donation-service`'s job (it owns the
  grant→node lock). Documented in code + handoff. Agreed with the boundary.
- **revoked-over-expired precedence** and **liveNodeCount not consulted for
  unknown/revoked/expired tokens** — both intentional and tested; correct.
- **Token logged via `debug`** (`grant-service.ts` `issue`/`revoke`). Matches the
  existing trust-circle convention (`auth/trust-circle.ts:111,209`); `debug` is
  off by default. No new smell — left as-is for consistency.
- **Full suite green** post-fix: `yarn workspace @serfab/cadre-host typecheck`
  (0), `yarn test` (413 passed, 3 pre-existing skips), `yarn lint` (0).

### Tripwires (parked, not ticketed)

- **`grants.json` rewritten in full on every mutation** — `NOTE:` tag already at
  `grant-store.ts` `save()`. Negligible at household scale; revisit only if
  grant counts grow large.

### Deliberate deferrals confirmed (no ticket)

- **No SSE `*-changed` event on grant issue/revoke.** Correct to skip — there is
  no SPA grants page yet; an event now would be a dead `LocalUiEvent` variant.
  Revisit when the UI lands (`4-donor-docs-and-integration`).
- **No docs update.** `docs/cadre-host.md` has no grant section and its CLI list
  (line 404) omits the `grant` subcommands. Documentation is routed through
  `4-donor-docs-and-integration` per the source ticket — left as-is.
- **`GrantStore.remove()` has no admin caller yet** (revoke marks, doesn't
  remove). It is a legitimate store primitive for a future "prune stale grants"
  admin action and is unit-tested; left in place for the downstream ticket.
- **Route silently ignores non-number `maxNodes`/`ttlMs`** (e.g. a string body)
  and falls back to defaults rather than 400. Minor input-strictness gap, not a
  correctness bug; the CLI always sends numbers. Not worth churn now.

## No new tickets

Nothing rose to major. No fix/plan/backlog tickets filed; the one minor defect
was fixed inline and all deferrals are already owned by downstream tickets
(`2-donation-service`, `4-donor-docs-and-integration`).
