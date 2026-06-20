----
description: A shared crypto hashing helper changed how it must be called, and the cadre control-plane and strand libraries still call it the old way — so those packages no longer build and their signature checks would break. Migrate the TypeScript signers and the SQL constraints together so both sides keep producing identical digests.
prereq: none
files:
  - C:/projects/sereus/packages/cadre-core/src/control-database.ts
  - C:/projects/sereus/packages/cadre-core/src/control-schema.ts
  - C:/projects/sereus/schemas/control.qsql
  - C:/projects/sereus/packages/cadre-core/src/peer-record.ts
  - C:/projects/sereus/packages/cadre-core/src/peer-authorization.ts
  - C:/projects/sereus/packages/cadre-core/src/device-token.ts
  - C:/projects/sereus/packages/cadre-core/src/seed-bootstrap.ts
  - C:/projects/sereus/packages/cadre-core/src/strand-membership-writer.ts
  - C:/projects/sereus/packages/quereus-plugin-sereus/src/strand-schema.ts
  - C:/projects/sereus/schemas/strand.qsql
  - C:/projects/sereus/packages/cadre-core/src/schema-verification.ts (already migrated — reference pattern)
  - C:/projects/sereus/packages/cadre-core/test/*.spec.ts (the digest-calling specs — see TODO)
  - C:/projects/sereus/packages/quereus-plugin-sereus/test/plugin.spec.ts
  - C:/projects/optimystic/packages/quereus-plugin-crypto/src/crypto.ts (reference only — the new API)
  - C:/projects/optimystic/packages/quereus-plugin-crypto/src/plugin.ts (reference only — the new SQL registration)
difficulty: hard
----

## Goal

Migrate every remaining caller of `@optimystic/quereus-plugin-crypto`'s `digest`
in the **cadre-core** and **quereus-plugin-sereus** libraries (TS source + SQL DDL
+ unit specs) from the old 4-arg / 3-arg form to the new framed-tuple API, keeping
the TypeScript signer and its matching SQL `verify(...)` constraint **byte-identical**.

The narrow case (`schema-verification.ts`) is already migrated and is your reference
for the idiom. Integration-test surfaces are handled by the prereq-chained follow-up
`cadre-digest-variadic-integration` — do **not** touch them here.

This supersedes the two backlog duplicates `cadre-core-digest-variadic-api-migration`
and `migrate-cadre-to-variadic-digest-api` (same root cause, deleted by the plan stage).

## The new API (confirmed against optimystic HEAD)

`crypto.ts` — JS/TS export:
- old: `digest(data, algorithm, inputEncoding, outputEncoding)`
- new: `digest(fields: readonly DigestField[], algorithm = 'sha256', encoding: OutputEncoding = 'base64url')`
- `data` is now an **array of fields**; the input-encoding arg is **gone**;
  `'utf8'` is no longer a valid **output** encoding (`resolveOutputEncoder('utf8')`
  throws). Valid output encodings: `'base64url' | 'base64' | 'hex' | 'bytes'`.
- `digest(['hello'])` is a *framed* digest `sha256(0x01 ‖ TAG_TEXT ‖ varint(len) ‖ utf8('hello'))`,
  **not** `sha256("hello")`.

`plugin.ts` — SQL function (registered into Quereus, `numArgs: -1`):
- new: `digest(f1, f2, ..., fN)` — **variadic over data fields**. Algorithm + output
  encoding are fixed at plugin-load time (defaults `sha256` / `base64url`) and
  **cannot** be passed per-call.
- **Consequence (the trap):** any literal left in a SQL `digest(...)` call — including
  the 3-arg `digest(x, 'sha256', 'utf8')` form in the strand schema — is now hashed as
  an extra data field. These do **not** throw; they silently produce wrong bytes. The
  ticket's original 4-arg grep does not catch them — you must migrate the 3-arg SQL
  calls too.

Crucially, SQL `digest(...)` returns the base64url string of the digest, and SQL
`verify(data, sig, key, 'ed25519')` decodes `data` from base64url (its default input
encoding) back to the raw digest bytes. So a TS signer that signs the **raw digest
bytes** (`digest([...], 'sha256', 'bytes')`) is verified by the SQL side with no
explicit encoding args.

## Design decisions (resolved — apply uniformly)

**A. Plugin config stays default (`sha256` / `base64url`).**
`control-database.ts` registers the crypto plugin with no config; confirm
`quereus-plugin-sereus`'s `connectToStrand` registers crypto the same way (default
base64url). No registration change is expected — but verify it, because a non-default
encoding would silently break TS↔SQL parity.

**B. Migration rule, by call shape — mirror the existing field decomposition:**

- **Multi-field authorization messages** (control layer: `AuthorityKey`,
  `ValidationKey`, `Strand`, `FormationInvite` — currently built as
  `digest(f1,'…','hex') || digest(f2,'…','hex') || …` in SQL and as a raw-bytes
  concat of per-field `sha256` digests in TS `buildAuthorizationMessage`):
  collapse to **one** variadic call.
  - TS: `buildAuthorizationMessage(fields: string[])` returns
    `digest([...fields], 'sha256', 'bytes') as Uint8Array` (keep the `Uint8Array`
    return + the `signMessage(message: Uint8Array)` callback shape — callers and the
    ed25519-signs-raw-bytes contract are unchanged).
  - SQL: `verify(digest(f1, f2, …, fN), context.Signature, A.Key, 'ed25519')` —
    drop the `||`-concatenation **and** the trailing `'hex'` arg on `verify`
    (base64url default decodes the digest to the same raw bytes TS signed).
  - All fields stay TEXT on both sides (SQL already `cast(... as text)` / `coalesce(...,'')`;
    TS already passes strings), so per-field type tags agree.

- **Single concatenated-TEXT payloads** (peer-record, device-token, the strand
  layer, and single-column auth-insert digests like
  `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')`):
  keep the joined string as **one** field.
  - SQL: drop the now-illegal trailing `'sha256','utf8'` args, e.g.
    `digest(new.PeerId || '|' || new.Multiaddr || '|' || cast(new.UpdatedAt as text))`,
    `digest(coalesce(new.PeerId, old.PeerId))`.
  - TS: `digest([joined], 'sha256', 'base64url')` where a base64url string digest is
    signed/verified (peer-record, device-token, peer-authorization, seed-bootstrap,
    `verifyStrandPayload`); `digest([payload], 'sha256', 'bytes') as Uint8Array` where
    raw bytes are signed (`signStrandPayload`).

  Rationale: the TS helpers already own the canonical joined string (with documented
  `'|'`-delimiter safety), and one TEXT field on both sides is trivially byte-identical.
  Converting these to true multi-field would gratuitously change the helper contracts
  and introduce INT-vs-TEXT tag concerns for `UpdatedAt`. Multi-field stays multi-field;
  single-string stays single-string.

**C. `generateStampId`** is a purely local ID generator (never signed/verified against
SQL): `digest([peerId], 'sha256', 'bytes') as Uint8Array`, then `.slice(0, 16)`. The
changed framing is irrelevant since it is not cross-checked.

**D. Re-signing.** The framed digest differs from the old bare hash, so any persisted
signature is invalidated. Per AGENTS.md this is acceptable — keep sign/verify internally
consistent; do not preserve old bytes. The existing specs are the guardrail.

## Edge cases & interactions (write tests / verify these)

- **Field-tag parity (INT vs TEXT).** Every control-layer field must be TEXT on both
  sides. Keep `buildAuthorizationMessage(fields: string[])`; keep SQL `cast(... as text)`
  for `ExpiresAt`/`TotalUses`/`UpdatedAt`. A field left as INTEGER in SQL but passed as a
  JS string (or vice-versa) frames under a different tag and silently fails verify.
- **NULL vs empty-string framing.** The new encoder frames `NULL` (TAG_NULL, no payload)
  distinctly from `''` (TAG_TEXT, length 0). The existing code coalesces nullable bound
  fields to `''` on BOTH sides (`coalesce(new.MemberPrivateKey,'')` ⇔ `memberPrivateKey ?? ''`).
  Preserve every `coalesce(..., '')` / `?? ''` exactly; never let one side pass NULL where
  the other passes `''`.
- **insert-vs-delete binding.** `FormationInvite.AuthorizedAddOrRemove`,
  `CadrePeer.AuthorizedInsert`, `DeviceToken.AuthorizedInsert` use
  `coalesce(new.X, old.X)` so the same digest expression binds NEW on insert and OLD on
  delete. Preserve that in the collapsed multi-field call.
- **Drift specs.** `control-schema.ts` ⇔ `schemas/control.qsql`
  (`control-schema-drift.spec.ts`) and `strand-schema.ts` ⇔ `schemas/strand.qsql`
  (`strand-schema-drift.spec.ts`) must stay byte-identical. Edit both copies of each
  identically, or the drift specs fail.
- **3-arg SQL trap.** `strand-schema.ts` lines ~73,76,88,118,137,159,166 use
  `digest(payload, 'sha256', 'utf8')`. Migrate each to the bare `digest(payload)`
  single-field form. (`schemas/strand.qsql` mirrors these.)
- **Cross-package strand coupling.** `strand-membership-writer.ts` (cadre-core) signs
  payloads verified by `strand-schema.ts` (sereus plugin); cadre-core's strand specs load
  the schema via `connectToStrand` from `@serfab/quereus-plugin-sereus`. Both packages
  must migrate in this ticket or cadre-core's strand specs fail.
- **plugin.spec.ts.** `test/plugin.spec.ts:158` does `select digest('hello','sha256','utf8')`
  — under the variadic SQL function that now hashes three fields. Change to
  `select digest('hello')` and assert the value equals the JS `digest(['hello'])`
  (base64url) — i.e. the framed single-TEXT-field digest, not `sha256('hello')`.
- **Verification grep false-positives.** The new TS form `digest([x], 'sha256', 'base64url')`
  is a legitimate 3-arg call. When you sweep for leftovers, target a non-`[` first argument
  (old TS form) and any literal-bearing SQL `digest(`, not raw arg-count.

## TODO

### TS source (cadre-core)

- [ ] `control-database.ts`
  - `generateStampId`: `digest([peerId], 'sha256', 'bytes') as Uint8Array`, slice 16.
  - `buildAuthorizationMessage(fields: string[])`: return
    `digest([...fields], 'sha256', 'bytes') as Uint8Array`. Update the doc comment
    (it currently describes the per-field sha256 concatenation + hex-concat SQL mirror)
    to describe the single framed multi-field digest + bare variadic SQL mirror.
  - Confirm `registerPlugin(this.db, cryptoPlugin)` still uses default config.
- [ ] `peer-record.ts` `peerRecordSignedPayload`: `digest([joined], 'sha256', 'base64url')`.
- [ ] `peer-authorization.ts` `peerAuthorizationDigest`: `digest([peerId], 'sha256', 'base64url')`.
- [ ] `device-token.ts` `deviceTokenSignedPayload`: `digest([joined], 'sha256', 'base64url')`.
- [ ] `seed-bootstrap.ts` `createSeed` + `validateSeedSignature`:
  `digest([seedJson], 'sha256', 'base64url')` (both sites).
- [ ] `strand-membership-writer.ts`:
  - `signStrandPayload`: `digest([payload], 'sha256', 'bytes') as Uint8Array`, then
    `sign(hashBytes, …, 'bytes', …)` unchanged.
  - `verifyStrandPayload`: `digest([payload], 'sha256', 'base64url')`.
  - Fix the doc comments that quote the old `digest(payload, 'sha256', 'utf8')` SQL form.

### SQL DDL (edit each pair byte-identically)

- [ ] `control-schema.ts` **and** `schemas/control.qsql`:
  - `AuthorityKey.Authorized` (both branches), `ValidationKey.Authorized`,
    `Strand.Authorized`, `FormationInvite.AuthorizedAddOrRemove`: replace the
    `digest(f,'…','hex') || …` chains with one `digest(f1, f2, …, fN)` and drop the
    trailing `'hex'` on the enclosing `verify(...)`.
  - `CadrePeer.AuthorizedInsert/AuthorizedUpdate`, `DeviceToken.AuthorizedInsert/AuthorizedUpdate`,
    `FormationUsage.Authorized` (the `digest(new.Token || new.Disclosure, 'sha256','utf8')`
    branch): drop the trailing `'sha256','utf8'` from the single-field `digest(...)`.
- [ ] `strand-schema.ts` **and** `schemas/strand.qsql`: drop the trailing
  `'sha256','utf8'` from all `digest(...)` calls (lines ~73,76,88,118,137,159,166 in the TS copy).

### Unit specs (mirror the helper changes; many specs import the helpers and need no digest edit)

- [ ] Direct `digest(...)` callers to migrate to the array form:
  `test/authority-key.spec.ts`, `test/cadre-node-seed-trust.spec.ts`,
  `test/device-token.spec.ts`, `test/peer-authorization.spec.ts`,
  `test/peer-record.spec.ts`, `test/seed-bootstrap.spec.ts`,
  `test/strand-membership-writer.spec.ts`.
- [ ] `quereus-plugin-sereus/test/plugin.spec.ts`: fix the `select digest('hello',…)` assertion.
- [ ] Add a focused **round-trip parity** test (TDD, fast) before the broad sweep:
  one representative of each shape — (a) a control multi-field message signed via
  `buildAuthorizationMessage` and accepted by a `select verify(digest(f1,…,fN), …)`,
  (b) a peer-record single-string payload, (c) a strand single-string payload.
  Each: a correct signature verifies `true`; tampering one field verifies `false`.

### Validation gates (stream output with `tee`, never silent redirect)

- [ ] `yarn workspace @serfab/cadre-core typecheck 2>&1 | tee /tmp/cc-tsc.log` — 0 errors
  (the 24 `TS2554` errors are gone).
- [ ] `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cc-test.log` — green.
- [ ] `yarn workspace @serfab/quereus-plugin-sereus typecheck && yarn workspace @serfab/quereus-plugin-sereus test 2>&1 | tee /tmp/sereus-test.log` — green
  (incl. `strand-schema-drift.spec.ts`, `plugin.spec.ts`).
- [ ] Sweep for leftovers in these two packages: old-form TS `digest(<non-array>, …)`
  and any SQL `digest(` carrying a literal `'sha256'`/`'utf8'`/`'hex'`/`'base64url'`
  argument. Expect none.

## Handoff note for the reviewer

The single dominant failure mode is **TS↔SQL byte-parity**: a subtle field-tag or
NULL/`''` mismatch fails closed (verify rejects every signed row) rather than throwing.
The unit specs that sign in TS and assert SQL acceptance are the guardrail — confirm they
genuinely exercise verify (not skipped). Integration coverage lands in
`cadre-digest-variadic-integration`.
