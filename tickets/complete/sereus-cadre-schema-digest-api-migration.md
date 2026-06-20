description: The schema-signing helper was calling the cryptographic digest function with the old (now-removed) argument shape, so signing/verifying an sApp schema threw at startup; this updated that one call to the new shape.
prereq: none
files:
  - C:/projects/sereus/packages/cadre-core/src/schema-verification.ts
  - C:/projects/sereus/packages/cadre-core/test/schema-verification.spec.ts
----

## What changed (implement stage)

Migrated `schemaDigest()` in `packages/cadre-core/src/schema-verification.ts` from
the removed 4-arg optimystic `digest(data, alg, inEnc, outEnc)` form to the new
3-arg framed-tuple form:

```ts
// before
return digest(payload, 'sha256', 'utf8', 'base64url') as string;
// after
return digest([payload], 'sha256', 'base64url') as string;
```

The single JSON-string payload is wrapped in a one-element field tuple (`[payload]`),
and the now-removed input-encoding arg (`'utf8'`) is dropped. Without this, the new
signature read `'utf8'` as the *output* encoding and `resolveOutputEncoder('utf8')`
threw `Unsupported output encoding: utf8` at module load through `signSchema`.

Schema signatures are produced and verified **entirely in TypeScript**
(`signSchema`/`verifySchema`) — there is no SQL-side `verify(digest(...))` counterpart
for schema signatures, so this digest can change shape without coordinating a SQL DDL
change. Per AGENTS.md ("Don't worry about backwards compatibility yet"), no re-sign of
persisted signatures is attempted; the sign/verify round-trip is self-consistent going
forward.

## Review findings

Adversarial pass over the implement diff (commit `5d22035`), reviewed with fresh eyes
before reading the handoff. The in-scope change is a single line; everything below was
checked against it.

### Correctness — checked, no findings
- **API shape verified against source.** Read optimystic
  `packages/quereus-plugin-crypto/src/crypto.ts`: the new `digest(fields, algorithm =
  'sha256', encoding: OutputEncoding = 'base64url')` exactly matches the migrated call
  `digest([payload], 'sha256', 'base64url')`. `'utf8'` is intentionally not a valid
  `OutputEncoding` (a digest is not UTF-8 text), confirming the old 3rd arg had to go.
- **`as string` cast is sound.** `digest` returns `string | Uint8Array`; with
  `'base64url'` it returns a string, so the cast is correct (would only be wrong for
  `'bytes'`).
- **`sign`/`verify` genuinely untouched/unchanged.** Confirmed their signatures in
  `crypto.ts` (`sign(data, key, curve, inputEncoding, keyEncoding, outputEncoding)`;
  `verify(data, sig, key, curve, inputEncoding, sigEncoding, keyEncoding)`) still match
  the 6-/7-arg call sites in `schema-verification.ts` — those lines were correctly left
  alone.
- **Only schema-signing path.** `grep` for `schemaDigest|signSchema|verifySchema|
  assertSchemaSignature` shows `schema-verification.ts` as the sole definer; all other
  hits are consumers (`strand-instance-manager`, `index`, tests). Nothing else
  recomputes a schema digest under the old shape.

### Tests — checked, adequate, no findings
- `npx vitest run test/schema-verification.spec.ts` (from `packages/cadre-core`):
  **14/14 pass.** Coverage is a genuine floor for a one-line change: sign→verify
  round-trip with real ed25519 keys, tamper rejection (schema, version, wrong key),
  malformed sig/key, and all `assertSchemaSignature` fail-closed/relaxed policy
  branches. The round-trip implicitly exercises the framed-tuple digest determinism. No
  additional cases warranted at this scope.

### Lint / typecheck — checked
- `eslint` on `schema-verification.ts` + its spec: **clean** (exit 0).
- `yarn typecheck` (cadre-core): `schema-verification.ts` is **absent** from the error
  list — the migrated line typechecks cleanly and added no errors.

### Pre-existing breakage — checked, confirmed pre-existing, already ticketed
- `yarn typecheck` reports **25** (the implement note said 24 — a minor undercount;
  it missed `test/seed-bootstrap.spec.ts:198`) `TS2554: Expected 1-3 arguments, but got
  4` errors. **Every one** is an old-shape 4-arg `digest(...)` call in files owned by
  the broader migration: `control-database.ts`, `device-token.ts`,
  `peer-authorization.ts`, `peer-record.ts`, `seed-bootstrap.ts`,
  `strand-membership-writer.ts`, and their `*.spec.ts`. The count discrepancy is
  immaterial — same root cause (optimystic's intentional `digest` signature change),
  all captured by `tickets/plan/cadre-digest-3arg-api-migration.md`.
- The runner's triage pass (commit `8e119c7`, after implement) already consumed
  `tickets/.pre-existing-error.md` and deferred to that plan ticket — no duplicate
  backlog ticket was filed. Verified the plan ticket still exists.
- **Disposition: not a regression from this ticket; no new ticket filed** (the major
  work is already a `plan/` ticket).

### Out-of-scope edits swept into the implement commit — noted, not reviewed, not reverted
- The commit also contains `packages/quereus-plugin-sereus/src/strand-schema.ts` and
  `schemas/strand.qsql` (`constraint Authorized check` → `check on insert, update,
  delete`) and a trailing-newline removal in `packages/cadre-core/vitest.config.ts`.
  These are **unrelated to the digest migration** — they are concurrent in-flight edits
  from other tickets (the plan ticket itself documents these were uncommitted in the
  working tree at filing). Per the "Never sanitize the working tree" rule they were
  correctly **not** reverted by the implementer, and they belong to a different ticket's
  review, not this one. Flagged here only so the record is honest about what landed in
  the commit. Note these SQL DDL files still contain old-shape `digest(...,'sha256',
  'utf8')` calls — that is the plan ticket's job, not this one's.

### Verdict
The scoped change is correct, minimal, lint/typecheck/test-clean, and is the complete
fix for the one path it owns. No minor fixes applied (nothing to fix), no major tickets
filed beyond the already-existing `cadre-digest-3arg-api-migration` plan ticket.
