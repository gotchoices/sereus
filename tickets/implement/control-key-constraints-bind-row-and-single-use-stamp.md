----
description: Bind AuthorityKey/Strand/ValidationKey authorization signatures to the row contents (not a bare StampId) and make StampId single-use, closing the captured-stamp replay / privilege-escalation hole
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/test/control-database-genesis.spec.ts
----

## Problem (recap)

The `Authorized` check constraints on `AuthorityKey`, `Strand`, and `ValidationKey` verify an authority's ed25519 signature over `digest(context.StampId, 'sha256', 'utf8')` only. The signed payload is a bare stamp, unbound to the row being inserted, so:

- A captured `(StampId, Signature)` pair from any legitimate authority can be transplanted onto an attacker-chosen row — insert an arbitrary `AuthorityKey` (self-grant authority = privilege escalation) or an arbitrary `Strand`. The verify only asserts "some authority signed some stamp," not "this authority approved *this* row.
- Nothing enforces single-use, so the schema's "(not repeatable)" comment (control.qsql:10,13,22,34) is a lie — the same stamp/signature replays indefinitely.

`CadrePeer` (control.qsql:47-57) already does it right: it signs over `digest(new.PeerId, ...)` (and `|| digest(new.Multiaddr, ...)` on update), binding the signature to the row. The privileged tables must follow that pattern, plus add anti-replay.

## Design

Two changes, applied to all three privileged tables (`AuthorityKey`, `ValidationKey`, `Strand`):

### 1. Bind the signature to row contents + a nonce

The signed message becomes the byte concatenation of the per-field SHA-256 digests, in a fixed field order, with the StampId nonce as the final field:

```
message_bytes = sha256(utf8(field_1)) ++ sha256(utf8(field_2)) ++ ... ++ sha256(utf8(StampId))
```

Per table, the field order is:

| Table        | Signed fields (in order)                                              |
|--------------|----------------------------------------------------------------------|
| AuthorityKey | `new.Key`, `new.StampId`                                              |
| ValidationKey| `new.Key`, `new.StampId`                                              |
| Strand       | `new.Id`, `new.Type`, `coalesce(new.MemberPrivateKey,'')`, `new.StampId` |

In SQL this is expressed with **hex** digest output so the `||` concatenation is byte-aligned and verify can decode it cleanly (unlike the default base64url, where two 43-char strings don't byte-align). Example for AuthorityKey:

```sql
verify(
  digest(new.Key, 'sha256', 'utf8', 'hex') || digest(new.StampId, 'sha256', 'utf8', 'hex'),
  context.Signature, A.Key, 'ed25519', 'hex'
)
```

`verify(data, signature, publicKey, curve, inputEncoding, sigEncoding, keyEncoding)` — pass `'ed25519'` and `'hex'` for data input encoding; signature and key stay default base64url (that's how they're stored/produced today).

The TS signer signs the **raw concatenated bytes directly** (ed25519 needs no pre-hash) — it must NOT re-hash the concatenation. `sha256(utf8(field))` (32 bytes each) concatenated equals the hex string above decoded, so SQL `verify` and the TS signer agree exactly.

### 2. Make StampId single-use via a unique column

Add `StampId text not null unique` as a real column on each of the three tables (currently `StampId` is only a `context` value). Uniqueness on the table's own column is the enforceable anti-replay mechanism: an attacker writing raw SQL cannot avoid supplying the column, and the table rejects a duplicate stamp. A cooperative "consumed-stamp ledger" was considered and rejected — a check constraint can't *force* a side-insert, so a ledger only the honest writer populates is not enforceable.

Why per-table uniqueness fully closes replay (not just global): the signed message differs per table (distinct content fields), and a legitimate authority generates a fresh random stamp per call. Replaying a captured pair against the *same* table+row is rejected by the row PK and the unique StampId; transplanting onto a *different* row or a *different* table makes the signature verify fail because the bound message no longer matches. So row-binding + per-table unique stamp leaves no replay path.

`StampId` moves out of `with context (...)` and into the column list; the constraints reference `new.StampId`. Context becomes `(AuthorityKey ..., Signature ...)` only.

### Schema edits — apply identically to BOTH copies

The schema is duplicated verbatim in `schemas/control.qsql` and the embedded `CONTROL_SCHEMA` constant in `control-database.ts` (the embedded copy is what runs in production / React Native). **Every edit below must be mirrored byte-for-byte in both copies** — see the open `control-schema-duplicated-no-drift-guard` plan ticket for the underlying hazard; do not let these two drift. Do not touch the `FormationInvite` curve discrepancy here — it is out of scope (owned by `formationinvite-fix-curve-and-wire-consent`).

**AuthorityKey** — add `StampId text not null unique`; keep the bootstrap bypass `(select count(1) from AuthorityKey) <= 1`; rewrite both signature branches (old-authority rotation via `old.Key`, and peer-authority via `exists`) to verify over `digest(new.Key,'sha256','utf8','hex') || digest(new.StampId,'sha256','utf8','hex')` with `'ed25519','hex'`. Context → `(AuthorityKey text null, Signature text null)`.

**ValidationKey** — add `StampId text not null unique`; verify over `digest(new.Key,...,'hex') || digest(new.StampId,...,'hex')`. Context → `(AuthorityKey text, Signature text)`.

**Strand** — add `StampId text not null unique`; the authority branch verifies over the 4-field message (`Id`, `Type`, `coalesce(MemberPrivateKey,'')`, `StampId`); **keep** the alternate `exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)` branch unchanged. Context → `(AuthorityKey text, Signature text)`. Note: the formation-usage strand-insert path (no signed writer exists yet) must also supply a fresh unique `StampId` — call this out in the code comment so the future formation writer doesn't trip the not-null.

### Writer edits — `packages/cadre-core/src/control-database.ts`

Add a shared, exported canonical-message builder (single source of truth reused by every signed writer and by test/harness signers):

```ts
/** Canonical authorization message: concatenation of per-field SHA-256 digests, in field order. */
export function buildAuthorizationMessage(fields: string[]): Uint8Array {
  const parts = fields.map(f => digest(f, 'sha256', 'utf8', 'bytes') as Uint8Array);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
```

**`insertAuthorityKey`** (bootstrap, :351-364): stop relying on the `StampId()` SQL function in context. Generate the stamp client-side (`generateStampId(this.config.libp2pNode.peerId.toString())`) and insert it as a column value: `insert into CadreControl.AuthorityKey (Key, StampId) with context AuthorityKey = null, Signature = null values (?, ?)`. Bootstrap stays unsigned (the `count <= 1` branch authorizes it); the only change is persisting a unique stamp.

**`insertStrand`** (:376-401): change the callback from `signStampId: (stampId: string) => string` to `signMessage: (message: Uint8Array) => string`. Build the message in cadre-core and hand the signer dumb bytes:

```ts
const stampId = generateStampId(peerId);
const message = buildAuthorizationMessage([strandId, type, memberPrivateKey ?? '', stampId]);
const signature = signMessage(message);
// insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
//   with context AuthorityKey = ?, Signature = ? values (?, ?, ?, ?)
```

(Drop `StampId` from the context clause; add it to the column list.)

**`insertValidationKey`** (new — recommended): mirror `insertStrand` for the `ValidationKey` table (`message = buildAuthorizationMessage([key, stampId])`). The table exists in the schema but has no writer yet; adding the writer proves the new scheme end-to-end and gives the upcoming formation/validation work a ready helper. If you choose to defer it, leave a code comment documenting the canonical scheme so a future writer can't get it wrong — but prefer adding it with a test.

### Caller edits — `packages/integration-tests/src/harness/test-network.ts`

`createStrand` (:105-110) currently passes `(stampId) => signData(stampId, party.authorityPrivateKey)`. Change the callback to sign the message bytes directly:

```ts
(message: Uint8Array) => signMessageEd25519(message, party.authorityPrivateKey)
```

where `signMessageEd25519(message, privateKey)` = `uint8ArrayToString(ed25519.sign(message, privateKey.slice(4, 36)), 'base64url')` — i.e. the existing `signData` (:27-37) minus the `sha256(...)` pre-hash and minus the UTF-8 encode, since it now receives raw bytes. Keep the existing `signData` only if something else still needs it; otherwise replace it.

## Tests (TDD)

Reuse the genesis harness pattern in `packages/cadre-core/test/control-database-genesis.spec.ts` — a real `CadreNode` with `profile: 'transaction'` (no network peers), `generatePrivateKey`/`getPublicKey` from `@optimystic/quereus-plugin-crypto`, and `db.getDatabase()` for raw `eval`/`exec`. Add `packages/cadre-core/test/control-authorization-binding.spec.ts` covering:

- **Bootstrap still works**: `ensureAuthorityKey` inserts exactly one row and is idempotent (existing genesis spec must still pass — it will, given bootstrap stays unsigned; only the embedded insert SQL gains the StampId column).
- **Happy path**: `insertStrand` with a correctly-built signature succeeds; the row is present with a populated `StampId`.
- **Transplant rejected (privilege escalation)**: build a valid signature for `AuthorityKey` Key=K1 (or a Strand Id=S1); attempt a raw `insert` of a *different* Key=K2 (Strand Id=S2) reusing the same `(StampId, Signature)` → constraint rejects (verify fails on the rebound message). Expected: the insert throws / row count unchanged.
- **Cross-table transplant rejected**: take a valid Strand `(StampId, Signature)` and attempt to insert an `AuthorityKey` with it → rejected.
- **Replay rejected (single-use)**: perform a valid signed insert, then replay the *exact* same `(Key/Id, StampId, Signature)` → rejected by the unique `StampId` column (and PK). Expected: throws / no duplicate.
- **Tamper rejected**: valid stamp+sig but mutate one signed field (e.g. Strand `Type` `'o'`→`'c'`, or `MemberPrivateKey`) in the insert → verify fails.
- If `insertValidationKey` is added: mirror the happy-path + transplant + replay cases for `ValidationKey`.

Run from the affected packages and stream output:
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log`
- `yarn workspace @serfab/cadre-core build` (typecheck the writer/interface change)
- `yarn workspace @serfab/integration-tests build` (the `insertStrand` callback signature change must compile in test-network.ts)

Watch for pre-existing failures unrelated to this diff (network/integration flakiness); if any surface that are clearly not caused by these edits, follow the pre-existing-error protocol rather than chasing them here.

## TODO

- [ ] Add `buildAuthorizationMessage(fields: string[]): Uint8Array` (exported) to `control-database.ts`.
- [ ] Edit `schemas/control.qsql`: add `StampId text not null unique` to AuthorityKey, ValidationKey, Strand; rewrite each `Authorized` verify to the row-bound hex-digest message; move `StampId` out of `with context` into columns; keep bootstrap bypass and the Strand FormationUsage branch.
- [ ] Mirror the exact same edits in the embedded `CONTROL_SCHEMA` constant in `control-database.ts` (production/RN path).
- [ ] Update `insertAuthorityKey` to client-generate the stamp and insert it as a `StampId` column (no `StampId()` SQL function, unsigned bootstrap unchanged otherwise).
- [ ] Update `insertStrand`: callback → `signMessage: (message: Uint8Array) => string`; build message via `buildAuthorizationMessage`; insert `StampId` column; drop `StampId` from context.
- [ ] (Recommended) Add `insertValidationKey` mirroring `insertStrand`.
- [ ] Update `test-network.ts` `createStrand` callback + replace/adjust `signData` to sign raw message bytes (no pre-hash).
- [ ] Add `control-authorization-binding.spec.ts` with the transplant / cross-table / replay / tamper / happy-path cases above.
- [ ] `yarn workspace @serfab/cadre-core build` + `test`, and `yarn workspace @serfab/integration-tests build`, all green (stream with `tee`).
- [ ] Honest review handoff: note the FormationInvite curve issue and the schema-duplication guard are intentionally out of scope (separate tickets), and whether `insertValidationKey` was added or deferred.
