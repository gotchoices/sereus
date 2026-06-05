description: FormationInvite hardened from a BARE STAMP authority signature (verify over digest(context.StampId)) to a row-bound + single-use scheme. Schema gained `StampId text not null unique` and binds AuthorizedAddOrRemove to (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId) via coalesce(new,old). Review added an `Immutable` (check on update (false)) guard — the implement diff left UPDATE unauthorized, defeating the row-binding for mutable consent fields.
files: schemas/control.qsql, packages/cadre-core/src/control-schema.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/integration-tests/src/harness/test-network.ts
----

## What landed (implement)

`FormationInvite.AuthorizedAddOrRemove` previously verified an authority signature over only
`digest(context.StampId, 'sha256', 'utf8')` — a bare stamp where `StampId` was a context
value, not a persisted column. Nothing bound the signature to the inserted row and the stamp
was never retained, so a captured `(StampId, Signature)` could authorize a *different*
attacker-chosen invite (privilege escalation) and be replayed.

The implement run moved `FormationInvite` onto the same row-bound + single-use scheme as
`Strand`/`AuthorityKey`/`ValidationKey`:

- Added column `StampId text not null unique` (single-use anti-replay nonce).
- Replaced the verify with a row-bound concatenation of per-field hex digests over
  (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StampId), using `coalesce(new.F, old.F)`
  so the same constraint binds the NEW row on insert and the OLD row on delete.
- Dropped `StampId` from `with context (...)` (now `AuthorityKey text, Signature text`).
- `insertFormationInvite` now builds the 6-field message via `buildAuthorizationMessage`,
  signs the engine-canonicalised ExpiresAt (`select datetime(?)` round-trip) and
  `String(totalUses)`, and persists the unique `StampId`. Public signature unchanged.
- Fixed the stale "digest of the StampId" comment on the integration harness signer.

## Review findings

Reviewed the implement diff (`fd986b1`) with fresh eyes against SPP/DRY/modularity, error
handling, type safety, resource cleanup, and — given this is an authorization constraint —
the full attack surface, cross-referencing the quereus constraint engine.

### MAJOR (fixed inline this pass): unauthorized UPDATE bypassed the row-binding

The implement diff guarded `FormationInvite` with `constraint AuthorizedAddOrRemove check on
insert, delete (...)`. In quereus a **bare** `check (expr)` defaults to the row-op mask
`INSERT | UPDATE` (`quereus schema/table.ts` → `DEFAULT_ROWOP_MASK`,
`opsToMask`), so the sibling tables `AuthorityKey`/`ValidationKey`/`Strand` (all bare `check`)
re-run their authorization on UPDATE. `FormationInvite`'s explicit `on insert, delete`
**excludes UPDATE** — leaving in-place mutation completely unauthorized.

Impact: an attacker who can write to the replicated control DB could insert a legitimate
invite (which passes the row-bound verify) and then `update ... set TotalUses = 999999`
(or `ExpiresAt`, `sAppId`, `ValidationUrl`) with **no signature at all** — directly defeating
the row-binding the ticket exists to add, since `FormationUsage.Authorized` reads
`FI.TotalUses`/`FI.ExpiresAt`/`FI.ValidationUrl` to gate redemption.

This was pre-existing (the old bare-stamp schema also used `on insert, delete`), but it
nullifies this ticket's hardening goal for the mutable fields, and the fix is tiny and safe
(no source path ever updates a `FormationInvite` row — verified by grep over all `.ts`
sources; only the stale `dist/` artifact mentioned the old schema), so it was fixed in this
pass rather than deferred.

- **Fix:** added `constraint Immutable check on update (false)` to `FormationInvite` in both
  `schemas/control.qsql` and `CONTROL_SCHEMA` (byte-identical; mirrors the existing
  `FormationUsage.InsertOnly` pattern). Invites are insert/delete only.
- **Proof:** added regression test `FormationInvite tamper-via-update rejected` to
  `control-authorization-binding.spec.ts`. It was first run against the **unfixed** schema
  and FAILED (the unauthorized `update` resolved instead of rejecting), then passed after the
  guard — confirming both the vulnerability and the fix.

### Checked, accepted as-is (no action)

- **Row-binding / transplant / replay / per-field tamper / cross-table / delete branch.**
  The implement tests cover these and all pass. Re-derived the verify by hand: the schema
  concatenates per-field `digest(..., 'hex')` and decodes the whole hex string with verify's
  `'hex'` input — byte-identical to `buildAuthorizationMessage`'s `sha256(field)`
  concatenation. Per-field 32-byte digests give unambiguous framing (no delimiter/length
  confusion). `coalesce(new.F, old.F)` correctly selects new on insert / old on delete.
- **ExpiresAt / TotalUses engine-coercion agreement.** The happy-path writer test passes a
  *non-canonical* epoch-ms (`Date.parse('2031-03-04T12:34:56Z')`), so the writer's
  `canonicalDatetime` round-trip and `String(totalUses)` genuinely byte-match the deferred
  CHECK's `cast(... as text)` — if they diverged the insert would throw. Robust regardless of
  whether the CHECK reads the raw or re-coerced value, since the stored value is already
  canonical.
- **`sAppId` digested without `coalesce(..., '')`.** Consistent with `Strand.Type`. A null
  `sAppId` fails closed (digest(null) → verify rejects); the writer types it non-optional.
  Acceptable per schema convention; flagged by the implementer.
- **No `deleteFormationInvite` JS writer.** By design — there is no production delete path.
  The authorized-delete branch is exercised via raw SQL in tests. A future delete writer must
  sign the OLD-row-bound message (the test shows the shape).
- **delete-then-re-insert "resurrection".** Inherent to the unique-column-as-nonce design and
  shared by every privileged table: once a row is deleted its StampId is free, so a captured
  *original insert* authorization could be replayed. Requires an authority-signed delete to
  have happened first, and is not specific to this ticket. Informational only — not filed.
- **Field-order coupling** between the writer array and the schema digest order is
  runtime/test-guarded (the happy-path test is the tripwire); no compile-time tie is feasible
  across the JS↔SQL boundary. Accepted as documented.
- **Docs.** `docs/architecture.md` (FormationInvite row, line 463 "persists authority-signed
  FormationInvite rows") and `docs/STATUS.md` remain accurate — neither documents the
  per-table signing scheme, so no doc edit was needed.

### Not run

- **Integration tests** (`packages/integration-tests`, real-network, not agent-runnable per
  AGENTS.md). The harness `createInvitation` goes through the unchanged public writer; the
  unit tests prove the writer. An end-to-end multi-party redemption against the live
  optimystic backend has not been re-validated this run.

## Results

- `yarn vitest run` in `packages/cadre-core`: **323 passed / 25 files** (322 from implement +
  the new `tamper-via-update` regression test). The focused FormationInvite +
  `control-schema-drift` subset: 33 passed.
- `yarn typecheck` (cadre-core): clean.
- `npx eslint` on changed files: 0 errors (pre-existing warnings only, in untouched lines).
