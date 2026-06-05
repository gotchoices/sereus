description: Harden FormationInvite.AuthorizedAddOrRemove from a BARE STAMP (signs only digest(context.StampId)) to a row-bound + single-use authority signature, mirroring the Strand/AuthorityKey/ValidationKey scheme. Add a `StampId text not null unique` column, bind the signature to (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId), update insertFormationInvite to build the row-bound message via buildAuthorizationMessage and persist the unique StampId column (dropping the `context.StampId` value), and add transplant/tamper/replay regression tests. Closes the captured-(StampId,Signature) transplant + replay hole confirmed during review of formationinvite-fix-curve-and-wire-consent.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-formation-invite.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/test/control-schema-drift.spec.ts
----

## Problem (reproduced)

`FormationInvite.AuthorizedAddOrRemove` currently verifies an authority signature over
only `digest(context.StampId, 'sha256', 'utf8')` — a **bare stamp** where `StampId` is a
*context value*, not a persisted column. Nothing binds the signature to the row being
inserted, and the stamp is never retained, so:

1. **Transplant / privilege escalation.** A captured `(StampId, Signature)` from one
   invite authorizes the insert of a *different* invite row (attacker-chosen Token /
   sAppId / ExpiresAt / TotalUses / ValidationUrl).
2. **Replay.** The same `(StampId, Signature)` can be replayed to re-insert an invite
   after deletion — nothing makes the stamp single-use.

**Reproduced during this fix run** (transient spec, since removed): against the current
schema, signing a bare `digest(stampId)` and transplanting the `(stampId, signature)`
pair via raw SQL onto an attacker-chosen row (`Token='attacker-…'`, `TotalUses=999999`)
**succeeds** — the row lands. That is the vulnerability this ticket closes; the regression
tests below invert it (transplant must be REJECTED).

This is a tracked residual weakness, not a regression: the originating ticket
(`formationinvite-fix-curve-and-wire-consent`, now in `complete/`) modeled the minimal
fix on `CadrePeer`'s bare-stamp insert and explicitly scoped row-binding out.

## Target design (decisions resolved here)

Mirror the `Strand` hardening (`schemas/control.qsql` lines 31-46) and the
`buildAuthorizationMessage` writer contract (`control-database.ts:69-78`).

### Schema (apply BYTE-IDENTICALLY to both copies)

Add the single-use column and a row-bound, insert+delete-symmetric verify. The
`coalesce(new.F, old.F)` form binds to the NEW row on insert and the OLD row on delete —
the exact pattern `CadrePeer.AuthorizedInsert` already uses (`control.qsql:58-63`), so
there is precedent that it works for `check on insert, delete`.

```
-- An open invitation to form a strand with this party
table FormationInvite (
    Token text primary key, -- Just a random string
    sAppId text, -- The app for the strand that will be formed
    ExpiresAt datetime null,
    TotalUses int null check (TotalUses >= 0),
    ValidationUrl text null,   -- Web hook - send disclosure, IP address...
    StampId text not null unique,   -- single-use authorization nonce (anti-replay)
    constraint AuthorizedAddOrRemove check on insert, delete (
        -- Authorized by an authority signing over THIS row
        -- (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId); single-use via unique StampId.
        -- coalesce(new.F, old.F) binds the NEW row on insert and the OLD row on delete (cf. CadrePeer).
        exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(
            digest(coalesce(new.Token, old.Token), 'sha256', 'utf8', 'hex')
                || digest(coalesce(new.sAppId, old.sAppId), 'sha256', 'utf8', 'hex')
                || digest(coalesce(cast(coalesce(new.ExpiresAt, old.ExpiresAt) as text), ''), 'sha256', 'utf8', 'hex')
                || digest(coalesce(cast(coalesce(new.TotalUses, old.TotalUses) as text), ''), 'sha256', 'utf8', 'hex')
                || digest(coalesce(coalesce(new.ValidationUrl, old.ValidationUrl), ''), 'sha256', 'utf8', 'hex')
                || digest(coalesce(new.StampId, old.StampId), 'sha256', 'utf8', 'hex'),
            context.Signature, A.Key, 'ed25519', 'hex'))
    )
) with context (AuthorityKey text, Signature text);
```

Note the `with context` drops `StampId` (now a column, not a context value) — exactly as
`Strand` did. Final field order is **(Token, sAppId, ExpiresAt, TotalUses, ValidationUrl,
StampId)** = column-declaration order with the single-use stamp last (matches Strand's
"stamp last" convention).

#### Why the `cast(... as text)` and the engine-canonicalised ExpiresAt matter

This was the crux of the research. `AuthorizedAddOrRemove` contains a subquery (`exists
(select 1 from AuthorityKey …)`), so Quereus **auto-defers** it to commit. Deferred CHECKs
run against the *coerced* NEW row (`quereus …/runtime/emit/constraint-check.ts:393
coerceNewSection` → `validateAndParse` → the column logical type's `.parse`). Therefore in
the verify:

- `new.TotalUses` is a coerced **integer**, and `digest(...)` requires a **string** input
  (the crypto plugin does `toBytes(data, 'utf8')` on a `string`; see
  `optimystic/.../quereus-plugin-crypto/src/crypto.ts:93` and `plugin.ts:32`). So
  `cast(new.TotalUses as text)` is **required** to get the decimal-string form. The writer
  must produce the byte-identical string with `String(totalUses)`.
- `new.ExpiresAt` is a coerced **canonical PlainDateTime string** (e.g.
  `2026-06-04T12:34:56`, no `Z`, trailing-zero fractional seconds dropped — see
  `quereus/.../types/temporal-types.ts:174 DATETIME_TYPE.parse`). The writer signs a string
  it builds in JS; it must equal that canonical form. Hand-rolling that canonicalisation
  (`Date.toISOString()` slicing) is fragile (fractional-second formatting differs from
  Temporal) and is exactly the "janky parser" AGENTS.md forbids. **Instead, obtain the
  canonical string from the engine**: `datetime(?)` calls the same `DATETIME_TYPE.parse!`
  (`quereus/.../func/builtins/conversion.ts:169 DATETIME_FUNC`), so
  `select datetime(<epochMs>)` returns the exact stored form. Use it for the message field
  (and you may pass that same canonical string as the insert value — `parse` is idempotent
  on canonical input — to keep a single source of truth).

`cast(new.ExpiresAt as text)` is technically redundant (the coerced datetime is already a
string) but keep it for symmetry/explicitness; verify with a quick test that it is a no-op.

### Writer (`insertFormationInvite`, control-database.ts:528)

- Keep `const stampId = generateStampId(this.config.libp2pNode.peerId.toString());`.
- Build the per-field message strings:
  - Token → `token`; sAppId → `sAppId` (text, no transform).
  - ExpiresAt → `''` when `options.expiresAtMs == null`, else the **engine-canonicalised**
    string from a small `private async canonicalDatetime(epochMs)` helper that does
    `for await (const row of this.db!.eval('select datetime(?) as c', [epochMs])) return row.c as string;`
    (mirror the `nextUseNumber` eval pattern; `datetime(?)` is a pure scalar — no network).
  - TotalUses → `''` when null, else `String(options.totalUses)`.
  - ValidationUrl → `options.validationUrl ?? ''`.
  - StampId → `stampId`.
- `const message = buildAuthorizationMessage([token, sAppId, expiresAtField, totalUsesField, validationUrlField, stampId]); const signature = signMessage(message);`
- Change the insert to add the `StampId` column and the new context shape:
  ```
  insert into CadreControl.FormationInvite (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId)
    with context AuthorityKey = ?, Signature = ?
    values (?, ?, ?, ?, ?, ?)
  ```
  Bind `[authorityKey, signature, token, sAppId, <expiresAt>, options.totalUses ?? null, options.validationUrl ?? null, stampId]`.
  For `<expiresAt>` either pass `options.expiresAtMs ?? null` (epoch-ms; coercion yields the
  same canonical value the deferred CHECK sees) OR the canonical string from the helper
  (idempotent) — prefer the canonical string so the signed source-of-truth and the stored
  value are produced once.
- Rewrite the JSDoc: it currently documents the bare-stamp weakness as a follow-up
  (control-database.ts:515-519) — replace with the row-bound + single-use description used
  on `insertStrand`/`insertValidationKey`.

There is **no `deleteFormationInvite` writer** today (only `insertFormationInvite` +
`cadre-node.ts:1005 publishFormationInvite`). The `coalesce(new,old)` delete branch is
therefore exercised only via raw SQL in tests; no new JS writer is required. If a delete
writer is added later it must sign the old-row-bound message using the stored `old.StampId`.

## Tests

The existing happy-path / non-authority / redeem / expiry tests in
`control-formation-invite.spec.ts` keep passing unchanged: their `signMessage` callback
signs whatever bytes `insertFormationInvite` builds, so they transparently adopt the new
row-bound message. Add the new coverage (mirror the structure in
`control-authorization-binding.spec.ts`, which already has the raw-SQL helpers, `freshStamp`,
and the import of `buildAuthorizationMessage`):

- **Happy path with all options**: `insertFormationInvite(token, sApp, …, { expiresAtMs,
  totalUses, validationUrl })` round-trips and persists a non-empty `StampId` — this is the
  only integration test that proves the writer's engine-canonicalised ExpiresAt + `String`
  TotalUses match the deferred-CHECK coerced values.
- **Transplant rejected**: sign a full row-bound message for invite A, then raw-insert a
  DIFFERENT row (different Token and/or TotalUses) reusing the captured `(StampId,
  Signature)` → rejected; row count unchanged; the attacker row absent.
- **Per-field tamper rejected**: sign for one value, insert another, for each bound field
  (sAppId, ExpiresAt, TotalUses, ValidationUrl) → rejected. (Token tamper is implicitly the
  transplant case.)
- **Replay rejected**: a valid raw insert succeeds; re-inserting the exact `(row, StampId,
  Signature)` is rejected by the unique `StampId` (and PK).
- **Delete branch (row-bound)**: raw-insert a valid invite, then `delete … with context
  AuthorityKey = ?, Signature = ?` where the signature is built over the OLD row's bound
  message (including the stored `StampId`) → succeeds; a forged/transplanted delete
  signature → rejected, row remains.
- Optional: **cross-table transplant rejected** — a FormationInvite signature cannot
  authorize a Strand/AuthorityKey insert (parallels the existing cross-table test).

Test-authoring tip: in raw-SQL tests, use an already-canonical datetime **string literal**
for ExpiresAt (e.g. `'2030-01-01T00:00:00'`) as BOTH the inserted value and the message
field — `DATETIME.parse` is idempotent on canonical input, so no per-test engine
canonicalisation is needed. Update the raw-insert helper to include the `StampId` column and
the `with context AuthorityKey = ?, Signature = ?` shape (the `StampId` context value is gone).

## Schema-drift guard

`control-schema-drift.spec.ts` byte-compares `schemas/control.qsql` against the embedded
`CONTROL_SCHEMA` in `control-schema.ts` (normalising only EOL/trailing newlines). Apply the
schema edit **identically** to both copies or the build fails.

## TODO

- Edit `schemas/control.qsql` FormationInvite: add `StampId text not null unique`, replace
  `AuthorizedAddOrRemove` with the row-bound verify above, drop `StampId` from `with context`.
- Mirror the identical edit into `CONTROL_SCHEMA` in `control-schema.ts`.
- Update `insertFormationInvite` (control-database.ts): add `canonicalDatetime` helper, build
  the 6-field row-bound message via `buildAuthorizationMessage`, persist `StampId`, switch the
  insert column list + `with context AuthorityKey/Signature`, and rewrite the JSDoc.
- Add transplant / per-field tamper / replay / delete-branch (and optional cross-table)
  regression tests (extend `control-formation-invite.spec.ts` or add to
  `control-authorization-binding.spec.ts`); add a happy-path-with-all-options round-trip.
- Run `yarn vitest run` in `packages/cadre-core` (stream with `tee`); ensure the new tests,
  the existing formation-invite suite, and `control-schema-drift` are green.
- Run `yarn typecheck`/`yarn lint` for `packages/cadre-core`; keep SQL reserved words lowercase.
