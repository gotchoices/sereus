description: Review the FormationInvite hardening from a BARE STAMP (verify over digest(context.StampId)) to a row-bound + single-use authority signature. Schema now has a `StampId text not null unique` column and binds AuthorizedAddOrRemove to (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId) via coalesce(new,old) (insert+delete symmetric, cf. CadrePeer). insertFormationInvite builds the row-bound message through buildAuthorizationMessage with an engine-canonicalised ExpiresAt and String(TotalUses), and persists the unique StampId. Closes the captured-(StampId,Signature) transplant + replay hole from formationinvite-fix-curve-and-wire-consent.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/integration-tests/src/harness/test-network.ts
----

## What landed

`FormationInvite.AuthorizedAddOrRemove` previously verified an authority signature over
only `digest(context.StampId, 'sha256', 'utf8')` — a bare stamp where `StampId` was a
**context value, not a persisted column**. Nothing bound the signature to the inserted row
and the stamp was never retained, so a captured `(StampId, Signature)` could (1) authorize a
*different* attacker-chosen invite (privilege escalation) and (2) be replayed. This run
moves `FormationInvite` onto the same row-bound + single-use scheme as
`Strand`/`AuthorityKey`/`ValidationKey`.

### Schema (mirrored byte-identically in `schemas/control.qsql` and `CONTROL_SCHEMA`)

- Added column `StampId text not null unique` (single-use anti-replay nonce), declared last.
- Replaced the `AuthorizedAddOrRemove` verify with a row-bound concatenation of per-field
  hex digests over **(Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId)**, using
  `coalesce(new.F, old.F)` so the same constraint binds the NEW row on insert and the OLD
  row on delete (the `check on insert, delete` pattern `CadrePeer.AuthorizedInsert` already
  uses). `ExpiresAt`/`TotalUses` are wrapped in `cast(... as text)` and null
  ExpiresAt/TotalUses/ValidationUrl coalesce to `''`.
- Dropped `StampId` from the `with context (...)` (now `AuthorityKey text, Signature text`),
  exactly as `Strand` did.

### Writer (`control-database.ts`)

- `insertFormationInvite` now builds the 6-field message via `buildAuthorizationMessage`
  (the existing single-source-of-truth used by `insertStrand`/`insertValidationKey`) and
  persists the unique `StampId` column under the new context shape. Public method signature
  is unchanged, so all callers (`cadre-node.ts` `publishFormationInvite`, the integration
  harness) transparently adopt the new message.
- Added `private async canonicalDatetime(epochMs)` — a `select datetime(?)` round-trip that
  returns the engine's canonical `PlainDateTime` string. This is the crux: the deferred
  CHECK (auto-deferred because it has a subquery) verifies against the **coerced** new row,
  where `ExpiresAt` is a canonical datetime string and `TotalUses` is an integer. The writer
  therefore signs the engine-canonical ExpiresAt (not a hand-rolled ISO slice — AGENTS.md
  forbids janky parsers) and `String(totalUses)` (⇔ `cast(new.TotalUses as text)`, the same
  `${n}` convention `peer-record.ts` already relies on). The canonical string is reused as
  the stored value (datetime parse is idempotent on it), so the signed source-of-truth and
  the persisted value are produced once.
- Rewrote the JSDoc (the old one documented the bare-stamp weakness as a follow-up).
- Fixed the now-stale "digest of the StampId" comment on the integration harness's
  `createInvitation` signer (behavior was already correct — it signs whatever raw bytes the
  writer builds).

## Use cases / validation (tests added to `control-authorization-binding.spec.ts`)

All exercise a real `CadreNode` (empty bootstrap, transaction profile) with raw-SQL helpers
(`rawInsertFormationInvite`, `rawDeleteFormationInvite`, `inviteMessage`) mirroring the
existing Strand/ValidationKey/AuthorityKey tests:

- **Happy path, all options (writer).** `insertFormationInvite(..., { expiresAtMs, totalUses,
  validationUrl })` round-trips and persists a non-empty `StampId`. This is the ONLY
  integration proof that the writer's engine-canonicalised ExpiresAt and `String(TotalUses)`
  byte-match the deferred-CHECK coerced values — if they diverged, the verify would reject
  and the insert would throw. (It also implicitly proves the `cast(ExpiresAt as text)` is a
  no-op, since the canonical datetime string verifies through it.)
- **Transplant rejected.** A valid signature for invite A reused on a different Token with
  escalated `TotalUses=999999` → rejected; count unchanged; attacker row absent.
- **Per-field tamper rejected.** sign-one / insert-another for each of sAppId, ExpiresAt,
  TotalUses, ValidationUrl → all rejected (Token tamper is the transplant case).
- **Replay rejected.** Exact `(row, StampId, Signature)` re-insert → rejected.
- **Single-use (isolates the unique column).** A *different* token with its OWN valid
  signature reusing a still-live `StampId` → rejected purely by the unique column (the
  row-bound verify passes, so this is not redundant with the PK).
- **Delete branch (row-bound).** A forged delete signature is rejected and the row remains;
  a delete signature bound to the OLD row (stored columns incl. StampId) succeeds and removes
  it — exercising the `coalesce(new, old)` delete path.
- **Cross-table transplant rejected.** A FormationInvite signature cannot authorize a
  `Strand` insert.

The pre-existing happy-path/non-authority/redeem/expiry tests in
`control-formation-invite.spec.ts` pass unchanged (their `signMessage` callback transparently
adopts the new message).

## Results

- `yarn vitest run` in `packages/cadre-core`: **322 passed / 25 files** (incl. the new tests,
  the formation-invite suite, and `control-schema-drift`).
- `yarn typecheck` (cadre-core): clean.
- `npx eslint` on the changed files: 0 errors (3 warnings, all pre-existing in untouched
  `initialize`/`loadSchema` lines).

## Known gaps / what the reviewer should scrutinize (tests are a floor, not a ceiling)

- **No `deleteFormationInvite` JS writer exists.** The delete branch is exercised only via
  raw SQL in tests. If a delete writer is added later it MUST sign the OLD-row-bound message
  using the stored `old.StampId` (the test shows the exact shape). Worth confirming the
  reviewer agrees no production delete path is silently missing.
- **`sAppId` has no `coalesce(..., '')` fallback** (it is digested directly, like
  `Strand.Type`). The writer treats it as required (non-optional param), so a null `sAppId`
  is out-of-scope/undefined — consistent with the schema convention but unverified for the
  null case. Confirm this matches intent.
- **Integration tests were NOT run** (real-network, not agent-runnable per AGENTS.md). The
  harness `createInvitation` goes through the unchanged public writer and the unit tests
  prove the writer, but an end-to-end multi-party redemption run against the live optimystic
  backend has not been re-validated this run.
- **Engine-coercion assumptions to re-confirm against source if in doubt:** (a) deferred
  CHECK runs against the coerced new row (`runtime/emit/constraint-check.ts` coerceNewSection
  → validateAndParse); (b) `cast(int as text)` === `String(int)` and `cast(datetime as text)`
  is a no-op on the canonical string; (c) `datetime(<epochMs>)` returns the same canonical
  string the column coercion produces (`func/builtins/conversion.ts` DATETIME_FUNC →
  `types/temporal-types.ts` DATETIME_TYPE.parse). I verified (b)/(c) directly in the quereus
  source and via the green happy-path test; (a) is the same property the already-landed
  Strand/ValidationKey binding relies on.
- **`buildAuthorizationMessage` field-order coupling.** The writer's array order and the
  schema's digest concatenation order MUST stay in lockstep (Token, sAppId, ExpiresAt,
  TotalUses, ValidationUrl, StampId). There is no compile-time guard tying them together —
  only the runtime verify and the tests. A reviewer reordering either side would silently
  break signing; the happy-path test is the tripwire.
