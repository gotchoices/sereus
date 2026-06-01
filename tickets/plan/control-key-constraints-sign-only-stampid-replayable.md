----
description: AuthorityKey/Strand/ValidationKey Authorized constraints sign only StampId, enabling captured-stamp replay and privilege escalation
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts
----
The `Authorized` check constraints on the `AuthorityKey`, `Strand`, and `ValidationKey` control tables verify an authority's ed25519 signature over `digest(context.StampId, 'sha256', 'utf8')` only — the signature does not bind to the contents of the row being inserted. See `schemas/control.qsql` lines 6-16 (AuthorityKey), 21-25 (ValidationKey), and 33-39 (Strand). The same constraint logic is duplicated in the embedded schema copy in `packages/cadre-core/src/control-database.ts`.

The writers reinforce the gap. `insertAuthorityKey` (control-database.ts:351-364) inserts the bootstrap key with `StampId = StampId()` and no signature, while `insertStrand` (control-database.ts:376-401) generates a client-side stamp via `generateStampId(peerId)` and signs only that stamp (`signStampId(stampId)`), passing the row's `Id`/`Type`/`MemberPrivateKey` as plain values that the signature never covers.

Because the signed payload is just the stamp and nothing binds it to the new row, a captured `(StampId, Signature)` pair from a legitimate authority can be replayed against these tables to insert an attacker-chosen row. An observer who sees one valid stamp/signature can insert an arbitrary `AuthorityKey` (granting itself authority — privilege escalation) or an arbitrary `Strand` row, since the verify only asserts "some authority signed some stamp," not "this authority approved this specific row."

Compounding this, there is no table tracking consumed StampIds and no uniqueness or anti-replay constraint on the stamp. The schema comments claim each authorization is "(not repeatable)" (control.qsql:10, 13, 22, 34), but nothing enforces single-use, so the "(not repeatable)" claim is unenforced and the same stamp/signature can be submitted repeatedly.

By contrast, the `CadrePeer` constraints (control.qsql:47-57) get this right: `AuthorizedInsert` verifies the authority signature over `digest(coalesce(new.PeerId, old.PeerId), ...)` and `AuthorizedUpdate` verifies over `digest(new.PeerId, ...) || digest(new.Multiaddr, ...)`, binding the signature to the actual row contents being written. The privileged control-table constraints should follow this pattern.

Expected behavior:
- Privileged control-table authorization signatures (AuthorityKey, Strand, ValidationKey) must cover the contents of the row being inserted (e.g. `new.Key`, `new.Id`, `new.Type`, plus any stamp/nonce), not a bare StampId, so a signature cannot be transplanted onto a different row.
- StampIds — or an equivalent nonce — must be enforced single-use (e.g. a consumed-stamp table or a uniqueness/anti-replay constraint) so a captured stamp cannot be replayed, making the schema's "(not repeatable)" guarantee real.
- The signing helpers in `control-database.ts` (`insertAuthorityKey`, `insertStrand`, and any analogous ValidationKey writer) must be updated to sign over the row contents the new constraints require.

Key files:
- `schemas/control.qsql` (AuthorityKey :6-16, ValidationKey :21-25, Strand :33-39; CadrePeer :47-57 as the correct contrast)
- `packages/cadre-core/src/control-database.ts` (embedded schema copy; `insertAuthorityKey` :351-364, `insertStrand` :376-401)
