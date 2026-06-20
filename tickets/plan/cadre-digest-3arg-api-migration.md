description: A cryptographic helper in the shared optimystic library changed how it must be called, and most of the cadre code still calls it the old way — so the cadre-core package (plus the SQL plugin and integration tests) no longer builds and its signature checks would break; this migrates all of it to the new call shape and keeps the TypeScript and SQL sides producing identical digests.
prereq: none
difficulty: hard
files:
  - C:/projects/sereus/packages/cadre-core/src/control-database.ts
  - C:/projects/sereus/packages/cadre-core/src/control-schema.ts
  - C:/projects/sereus/packages/cadre-core/src/peer-record.ts
  - C:/projects/sereus/packages/cadre-core/src/peer-authorization.ts
  - C:/projects/sereus/packages/cadre-core/src/device-token.ts
  - C:/projects/sereus/packages/cadre-core/src/seed-bootstrap.ts
  - C:/projects/sereus/packages/cadre-core/src/strand-membership-writer.ts
  - C:/projects/sereus/packages/quereus-plugin-sereus/src/strand-schema.ts
  - C:/projects/sereus/packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts
  - C:/projects/sereus/packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts
  - C:/projects/sereus/packages/integration-tests/fixtures/simple-sapp.qsql
  - C:/projects/optimystic/packages/quereus-plugin-crypto/src/crypto.ts
  - C:/projects/optimystic/packages/quereus-plugin-crypto/src/plugin.ts
----

## Problem

Optimystic's `@optimystic/quereus-plugin-crypto` `digest()` was intentionally changed
(optimystic commits `8cea904` / `f10094c`, ticket `crypto-digest-variadic-config`) from
the old 4-arg blob form to a framed-tuple form. **Two** surfaces changed in lockstep:

1. **JS/TS export** (`crypto.ts`):
   - old: `digest(data, algorithm, inputEncoding, outputEncoding)`
   - new: `digest(fields: readonly DigestField[], algorithm = 'sha256', encoding: OutputEncoding = 'base64url')`
   - `data` is now an **array of fields**, the input-encoding arg is **gone**, and
     `'utf8'` is no longer a valid *output* encoding (`resolveOutputEncoder('utf8')`
     throws `Unsupported output encoding: utf8`).

2. **SQL function** (`plugin.ts`, registered into Quereus):
   - old (effectively): `digest(data, algorithm, inputEncoding, outputEncoding)`
   - new: `digest(f1, f2, ..., fN)` — **variadic over data fields**, hashed as one
     injective framed tuple. Algorithm + output encoding are **fixed at plugin-load
     time** from config (defaults `sha256` / `base64url`) and **cannot be passed
     per-call** anymore.

The narrow case (`cadre-core/src/schema-verification.ts`) was already fixed under ticket
`sereus-cadre-schema-digest-api-migration`. This ticket covers **everything else**, which
is the rest of the breakage from the same root cause.

### Current breakage (pre-existing, blocking the build)

`yarn typecheck` in `packages/cadre-core` reports **24 `TS2554: Expected 1-3 arguments,
but got 4`** errors — the package does not build. Concretely:

cadre-core **source** (runtime TS callers of the JS `digest`):
- `control-database.ts:25` (`generateStampId`), `control-database.ts:72`
  (`buildAuthorizationMessage`)
- `peer-record.ts:56`, `peer-authorization.ts:17`, `device-token.ts:38`
- `seed-bootstrap.ts:415`, `seed-bootstrap.ts:635`
- `strand-membership-writer.ts:50`, `strand-membership-writer.ts:71`

cadre-core **SQL DDL strings** (SQL `digest` calls embedded in schema constants — these
do not show up as TS errors but are semantically broken at runtime):
- `control-schema.ts` — many call sites, lines ~23,26,36,49,73,86,90,109,121,125,
  144–150,184 — including the **hex-concat** pattern
  `digest(x,'sha256','utf8','hex') || digest(y,'sha256','utf8','hex')`.

cadre-core **tests**: `authority-key.spec.ts`, `cadre-node-seed-trust.spec.ts`,
`device-token.spec.ts`, `peer-authorization.spec.ts`, `peer-record.spec.ts`,
`seed-bootstrap.spec.ts`, `strand-membership-writer.spec.ts`.

`quereus-plugin-sereus`: `src/strand-schema.ts` (SQL DDL, lines ~73,76,88,118,137,159,166),
`test/plugin.spec.ts:158` (`select digest('hello','sha256','utf8')`).

`integration-tests`: `fixtures/simple-sapp.qsql` (SQL DDL),
`strand-membership-closed-strand-e2e.integration.ts:141`,
`rbac-signed-write.integration.ts:111,117`.

## Why this is hard (the security-sensitive part)

Cadre's authorization model signs digests in TypeScript and **re-verifies them inside
SQL `check`/`when` constraints** (`verify(digest(...), signature, key, 'ed25519')`). For
a write to be accepted, the **TS-computed digest bytes must be byte-identical to the
SQL-computed digest bytes**. So this is not a find-and-replace: every TS caller and its
matching SQL DDL must migrate **together**, or signature verification silently fails (or,
worse, mis-verifies).

The canonical example is `control-database.ts`:

- `buildAuthorizationMessage(fields)` builds
  `sha256(utf8(f1)) ++ sha256(utf8(f2)) ++ ... ++ sha256(utf8(StampId))` by calling
  `digest(field,'sha256','utf8','bytes')` per field and concatenating the raw 32-byte
  digests.
- The matching SQL constraint (`control-schema.ts`) rebuilds the same bytes via
  `digest(f1,'sha256','utf8','hex') || digest(f2,'sha256','utf8','hex') || ...` and lets
  `verify(..., 'ed25519', 'hex')` decode the hex back to bytes.

Under the new API **neither** form is expressible as-was: the per-call `'hex'`/`'bytes'`
output encoding is gone (SQL encoding is load-time-fixed), and a single-field framed
digest is `sha256(0x01 ‖ TAG_TEXT ‖ varint(len) ‖ utf8(field))`, **not** `sha256(utf8(field))`.

## Design decisions to make (this is why it's a plan, not a mechanical fix)

1. **Adopt the variadic framed tuple, or keep per-field concatenation?**
   The new idiom replaces "concatenate N separately-hashed digests" with **one**
   `digest(f1, f2, ..., fN)` call that injectively frames the whole tuple. Recommended:
   adopt the single multi-field digest everywhere (cleaner, domain-separated, arity-safe,
   and exactly what the new API is for) — e.g. `buildAuthorizationMessage` becomes a
   single `digest([...fields], 'sha256', 'base64url')` on the TS side and
   `digest(field1, field2, ..., StampId)` in SQL. Decide and apply **uniformly**.

2. **Output encoding alignment.** The SQL `digest` now emits whatever the plugin was
   registered with. cadre-core registers the crypto plugin in `control-database.ts`
   (`registerPlugin(cryptoPlugin)`) — confirm/keep the default `base64url`, and make the
   TS side use `digest([...], 'sha256', 'base64url')` to match, with `verify(...)`'s
   `inputEncoding` left at its `base64url` default (drop the `'hex'` args). Where raw
   bytes are needed in TS (e.g. `generateStampId` slicing 16 bytes, or any
   `...'bytes'` caller), use `digest([...], 'sha256', 'bytes') as Uint8Array`.

3. **String-concat fields vs separate fields.** Existing single-field calls like
   `digest(new.Key || '|' || coalesce(new.Expiration,''), 'sha256','utf8')` can either
   stay one concatenated TEXT field — `digest(new.Key || '|' || coalesce(new.Expiration,''))`
   — or become true multi-field — `digest(new.Key, new.Expiration)`. Pick one convention;
   whichever is chosen, the TS signer must mirror it field-for-field and in the same order.

4. **All signatures change → re-sign.** The framed digest differs from the old bare hash,
   so any persisted signature/digest is invalidated. Per AGENTS.md ("Don't worry about
   backwards compatibility yet") this is acceptable; the work is to keep sign/verify
   internally consistent, not to preserve old bytes. The existing `*.spec.ts` files that
   compute a digest in TS and assert it verifies via SQL are the guardrail — migrate them
   and rely on them to prove TS/SQL agreement.

## Suggested decomposition (for the implement ticket(s) this plan emits)

Keep changes coordinated by surface so each implement ticket leaves a buildable state:
- **cadre-core core**: the 6 TS source files + `control-schema.ts` DDL, migrated together
  (signer + constraint in lockstep), plus the matching `*.spec.ts` updates. Gate on
  `yarn typecheck` + `yarn test` in `packages/cadre-core`.
- **quereus-plugin-sereus**: `strand-schema.ts` DDL + `test/plugin.spec.ts`. Gate on its
  own typecheck/test.
- **integration-tests**: the two `*.integration.ts` helpers + `simple-sapp.qsql`. Gate on
  the `convergence-stress` and `rbac-signed-write` scenarios going green.
- Decide whether these are one implement ticket or three `prereq`-chained ones; they share
  the TS/SQL agreement contract, so a single coordinated ticket is defensible, but the
  integration-test pass should land **after** the library packages.

## In-flight working-tree caution

At time of filing, the working tree already has **uncommitted edits** to
`packages/quereus-plugin-sereus/src/strand-schema.ts`, `schemas/strand.qsql`, and
`packages/cadre-core/vitest.config.ts` (other tickets / a human promoting the board). Do
**not** revert or clobber these — rebase the migration onto whatever those land as.
`schemas/strand.qsql` still contains old-form `digest(..., 'sha256', 'utf8')` calls that
also need migrating; coordinate with the in-flight strand-schema work.

## Acceptance criteria

- `yarn typecheck` and `yarn test` pass in `packages/cadre-core` and
  `packages/quereus-plugin-sereus`.
- The `convergence-stress` and `rbac-signed-write` integration scenarios pass (TS-signed
  writes are accepted by the SQL constraints — proving TS/SQL digest agreement).
- No remaining 4-arg `digest(...)` call sites in sereus (`rg "digest\([^)]*,[^)]*,[^)]*,"`
  comes back clean except intentional non-crypto `.digest('hex')` Node hash usages in
  `cadre-provider`/reference-app polyfills).
