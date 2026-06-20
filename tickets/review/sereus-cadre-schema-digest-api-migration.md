description: The schema-signing helper was calling the cryptographic digest function with the old (now-removed) argument shape, so signing/verifying an sApp schema threw at startup; this updates that one call to the new shape.
prereq: none
files:
  - C:/projects/sereus/packages/cadre-core/src/schema-verification.ts
  - C:/projects/sereus/packages/cadre-core/test/schema-verification.spec.ts
----

## What changed

Migrated `schemaDigest()` in `packages/cadre-core/src/schema-verification.ts` from
the removed 4-arg optimystic `digest(data, alg, inEnc, outEnc)` form to the new
3-arg framed-tuple form:

```ts
// before
return digest(payload, 'sha256', 'utf8', 'base64url') as string;
// after
return digest([payload], 'sha256', 'base64url') as string;
```

Two changes in one: the single JSON-string payload is wrapped in a one-element
field tuple (`[payload]`), and the now-removed input-encoding arg (`'utf8'`) is
dropped. Without this, the old arg-3 `'utf8'` was read by the new signature as the
*output* encoding, and `resolveOutputEncoder('utf8')` threw
`Unsupported output encoding: utf8`.

This is the only change in scope for this ticket. `signSchema` and `verifySchema`
both route through `schemaDigest`, so the sign/verify round-trip stays internally
consistent. `sign`/`verify`'s own multi-arg encoding signatures were **not** changed
by optimystic and remain untouched here.

## Why this is self-contained / safe

Schema signatures are produced and checked **entirely in TypeScript** (via
`signSchema`/`verifySchema`) — there is no SQL-side `verify(digest(...))` counterpart
for schema signatures. So this digest can change shape freely without coordinating a
SQL DDL change. (Contrast with the broader migration below, where TS-computed digests
*must* byte-match SQL constraints.) Per AGENTS.md "Don't worry about backwards
compatibility yet", no re-sign migration of persisted schema signatures is attempted;
any signature generated under the old API would no longer verify, but the round-trip
is self-consistent going forward.

## Validation performed

- `npx vitest run test/schema-verification.spec.ts` (from `packages/cadre-core`):
  **14/14 pass** — covers the full sign → verify round-trip with real ed25519 keys,
  tamper rejection (schema, version, wrong key), malformed sig/key handling, and all
  `assertSchemaSignature` fail-closed/relaxed policy branches.
- `yarn typecheck` (from `packages/cadre-core`): `schema-verification.ts` no longer
  appears in the error output (it typechecks cleanly).

## Reviewer: what to verify (and a floor, not a ceiling)

The 14-test suite is a floor. Worth an adversarial look:
- Confirm `digest([payload], 'sha256', 'base64url')` (single-element tuple) is the
  intended encoding and that nothing else persists/recomputes schema digests under the
  old shape (grep confirms `schema-verification.ts` is the only schema-signing path).
- Sanity-check that the framed-tuple digest of `[payload]` is stable/deterministic
  across the supported platforms (browser/node/RN) — it relies on optimystic's
  `encodeFields` framing.

## KNOWN GAP — broader package build is still red (pre-existing, NOT this ticket)

This ticket was scoped (by the source ticket) to `schema-verification.ts` only. While
working it, the same optimystic `digest` 3-arg change was found to break the **entire
cadre-core package build plus quereus-plugin-sereus and integration-tests** — the
identical 4-arg `digest(...)` call pattern appears in ~6 other cadre-core source files,
~7 cadre-core test files, the SQL DDL strings in `control-schema.ts` /
`quereus-plugin-sereus/src/strand-schema.ts` / `schemas/strand.qsql`, and integration
fixtures.

- `yarn typecheck` (cadre-core) reports **24 remaining `TS2554: Expected 1-3 arguments,
  but got 4` errors** that pre-date this edit (this edit removed one; it added none).
  So `packages/cadre-core` does **not** build, and `yarn test` for the package and the
  `convergence-stress` integration scenario named in the source ticket are **not fully
  green** — the convergence-stress module-load throw from `signSchema` is fixed, but the
  scenario is still blocked downstream by runtime `digest(...)` calls in
  `strand-membership-writer.ts` etc.
- This broader, **security-sensitive** migration (TS-computed digests must byte-match
  SQL `verify(digest(...))` constraints, and the SQL `digest` itself changed to a
  variadic framed tuple with load-time-fixed encoding) is captured in a new design
  ticket: **`tickets/plan/cadre-digest-3arg-api-migration.md`**, and flagged in
  `tickets/.pre-existing-error.md`. Do **not** treat the red package build as a
  regression from this ticket.
