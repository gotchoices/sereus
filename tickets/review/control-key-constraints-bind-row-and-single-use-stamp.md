description: Review the row-bound authorization + single-use StampId hardening of the privileged control tables (AuthorityKey/ValidationKey/Strand) — captured-stamp replay / privilege-escalation hole closed
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/test/control-authorization-binding.spec.ts
prereq:
----

## What changed (implement summary)

The `Authorized` CHECK constraints on the three privileged control tables previously
verified an authority's ed25519 signature over `digest(context.StampId, 'sha256', 'utf8')`
only — a **bare stamp, unbound to the row**. That let a captured `(StampId, Signature)`
pair be transplanted onto an attacker-chosen row (self-grant `AuthorityKey` = privilege
escalation, or an arbitrary `Strand`), and there was no single-use enforcement so the
"(not repeatable)" comments were false. This change binds every authority signature to the
row contents **plus** a single-use nonce.

### 1. Signature now bound to row contents + nonce

The signed message is the byte concatenation of per-field SHA-256 digests, in a fixed
field order, with the StampId as the final field:

```
message = sha256(utf8(field_1)) ++ ... ++ sha256(utf8(StampId))
```

Field order per table:

| Table         | Signed fields (in order)                                              |
|---------------|----------------------------------------------------------------------|
| AuthorityKey  | `new.Key`, `new.StampId`                                              |
| ValidationKey | `new.Key`, `new.StampId`                                              |
| Strand        | `new.Id`, `new.Type`, `coalesce(new.MemberPrivateKey,'')`, `new.StampId` |

SQL verifies the identical bytes via hex-encoded digests concatenated with `||` and
decoded by `verify(..., 'ed25519', 'hex')` (5th arg = data input encoding; signature/key
stay base64url). The TS signer signs the **raw concatenated bytes directly** — ed25519
needs no pre-hash. `sha256(utf8(field))` (32 bytes each) concatenated == the hex string
decoded, so SQL and TS agree exactly.

`buildAuthorizationMessage(fields: string[]): Uint8Array` (exported from `control-database.ts`
and re-exported from the package index) is the **single source of truth** for the message
bytes, reused by both signed writers and the test/harness signers.

### 2. StampId is now a single-use unique column

`StampId text not null unique` is a real column on all three tables (it was only a
`context` value before). Uniqueness on the table's own column is the enforceable
anti-replay mechanism — an attacker writing raw SQL cannot avoid the column, and a
duplicate stamp is rejected. `StampId` was removed from each `with context (...)`; the
constraints reference `new.StampId`.

**Why per-table uniqueness fully closes replay:** the message differs per table (distinct
content fields) and a fresh random stamp is generated per call. Replaying the same pair on
the same table+row is rejected by PK + unique StampId; transplanting onto a different row
or table makes the rebound `verify` fail. No replay path remains.

### Code changes

- **`schemas/control.qsql` + embedded `CONTROL_SCHEMA` in `control-database.ts`** — both
  copies edited byte-for-byte identically for the three tables (verified via diff; the only
  remaining inter-copy difference is a pre-existing CadrePeer comment outside this scope).
- **`insertAuthorityKey`** — bootstrap stays unsigned (authorized by the `count(1) <= 1`
  branch); now client-generates the stamp via `generateStampId(...)` and inserts it as a
  `StampId` column. The `StampId()` SQL function is no longer used here.
- **`insertStrand`** — callback changed from `signStampId: (stampId) => string` to
  `signMessage: (message: Uint8Array) => string`; builds the 4-field message via
  `buildAuthorizationMessage`; inserts `StampId` as a column; dropped from context.
- **`insertValidationKey`** — **added** (was recommended), mirrors `insertStrand` over
  `[key, stampId]`. Proves the scheme end-to-end and gives upcoming formation/validation
  work a ready helper.
- **`test-network.ts`** — `createStrand` callback now signs message bytes directly;
  `signData` replaced by `signMessageEd25519` (raw bytes, no pre-hash, no re-encode); the
  now-unused `sha256` import removed.

## Validation performed

- `yarn workspace @serfab/cadre-core build` — clean (exit 0).
- `yarn workspace @serfab/integration-tests build` — clean (exit 0); the `insertStrand`
  callback signature change compiles in `test-network.ts`.
- `yarn workspace @serfab/cadre-core test` — **all 304 tests / 22 files pass**, including
  the existing genesis spec (unchanged behavior) and the new binding spec (12 cases).
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

### New test: `control-authorization-binding.spec.ts` (12 cases)

Boots a real `CadreNode` (`profile: 'transaction'`, empty bootstrap — no network), shares
one node/authority across cases via `beforeAll`, drives the real writers and raw SQL:

- **bootstrap** persists a unique StampId on the founding authority row.
- **Strand happy path** — `insertStrand` succeeds; row present with populated `StampId`.
- **Strand transplant rejected** — valid sig for `S1` reused on a different `S2` → reject.
- **Cross-table transplant rejected** — a valid Strand pair used to insert an
  `AuthorityKey` → reject.
- **Strand replay rejected** — exact `(Id, StampId, Signature)` replayed → reject (PK +
  unique StampId).
- **Tamper rejected** — mutate `Type` (`o`→`c`) after signing → reject; also mutate
  `MemberPrivateKey` after signing for `''` → reject.
- **ValidationKey** — happy path (`insertValidationKey`), transplant rejected, replay
  rejected.
- **AuthorityKey** — happy path (existing authority enrolls a new authority via row-bound
  sig), transplant/self-grant rejected.

## Reviewer focus / known gaps (honest handoff)

- **Out of scope by design (separate tickets):**
  - `FormationInvite` curve discrepancy — its constraint still uses the no-curve
    `verify(digest(context.StampId), context.Signature, A.Key)` form and was intentionally
    **not** touched here. Owned by `formationinvite-fix-curve-and-wire-consent`.
  - The schema-duplication drift hazard (two verbatim copies of the schema) is real but
    out of scope; owned by `control-schema-duplicated-no-drift-guard`. This change keeps
    the two copies in sync — please re-verify the diff if you touch either.
- **FormationUsage strand-insert path (no signed writer yet):** the Strand `Authorized`
  alternate branch `exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)`
  is unchanged, but `Strand.StampId` is now `not null unique`. A future formation writer
  taking that path MUST still supply a fresh unique StampId or it will trip the not-null.
  This is called out in a schema comment; there is no test for that path yet because no
  signed formation-usage writer exists. Worth a reviewer check that nothing currently
  inserts a Strand via that branch without a StampId.
- **Integration test suite not executed** — only `integration-tests` *build* was run
  (per ticket). The real-network scenarios there are slow/flaky and not agent-runnable in
  a 10-min idle budget; the only one touching this path is `createStrand` (harness),
  exercised indirectly. A reviewer with a stable environment may want to run the relevant
  scenario(s).
- **Test stamp generation** — the spec uses `randomBytes(256,'base64url')` for raw-insert
  stamps (vs production `generateStampId`); both yield unique values, and uniqueness is all
  the constraint cares about. Not a concern, noted for clarity.
- **Bootstrap branch ordering** — the AuthorityKey `(select count(1) from AuthorityKey) <= 1`
  bootstrap bypass is preserved; the genesis spec confirms it still inserts exactly one row
  and is idempotent. Confirm the count semantics (new row counted during the insert check)
  are acceptable to you.
