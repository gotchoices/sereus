description: Row-bound authorization + single-use StampId hardening of the privileged control tables (AuthorityKey/ValidationKey/Strand). Captured-stamp replay / privilege-escalation hole closed. Reviewed and completed.
files: schemas/control.qsql, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/index.ts, packages/integration-tests/src/harness/test-network.ts, packages/cadre-core/test/control-authorization-binding.spec.ts
prereq:
----

## Summary

The `Authorized` CHECK constraints on the three privileged control tables previously
verified an authority's ed25519 signature over a **bare stamp** (`digest(context.StampId)`)
unbound to the row, with no single-use enforcement. A captured `(StampId, Signature)` pair
could be transplanted onto an attacker-chosen row (self-grant `AuthorityKey` = privilege
escalation, or an arbitrary `Strand`) and replayed freely.

This change binds every authority signature to the **row contents plus a single-use
nonce**:

- The signed message is the byte concatenation of per-field SHA-256 digests in a fixed
  field order, StampId last:
  `message = sha256(utf8(field_1)) ++ ... ++ sha256(utf8(StampId))`.
  Each field is a fixed 32-byte digest, so concatenation is unambiguous.
- `StampId` is now a real `text not null unique` column on all three tables (removed from
  `with context`); per-table uniqueness is the enforceable anti-replay mechanism.
- `buildAuthorizationMessage(fields)` in `control-database.ts` (re-exported from the
  package index) is the single source of truth for message bytes, used by signed writers
  and test/harness signers. ed25519 signs the raw bytes directly (no pre-hash); SQL
  verifies the identical bytes via hex-encoded digests concatenated with `||` and decoded
  by `verify(..., 'ed25519', 'hex')`.
- New `insertValidationKey` writer mirrors `insertStrand`. `insertStrand`'s callback
  changed from `signStampId` to `signMessage(message: Uint8Array)`. `insertAuthorityKey`
  bootstrap stays unsigned but now persists a client-generated unique `StampId` column.
- Harness `test-network.ts` signs message bytes directly (`signMessageEd25519`).

## Review findings

### What was checked

- **Implement diff read fresh** (commit `83bd34a`) before the handoff summary: schema
  (both copies), `control-database.ts`, `index.ts`, `test-network.ts`, and the new spec.
- **Crypto correctness** — read `@optimystic/quereus-plugin-crypto/src/crypto.ts` and
  confirmed `verify(data, sig, key, curve, inputEncoding, sigEncoding, keyEncoding)`
  semantics: SQL passes the concatenated hex digests with `inputEncoding='hex'` while
  `sig`/`key` keep their base64url defaults, and the TS signer produces the identical raw
  bytes (32-byte digests concatenated) signed with ed25519 (no pre-hash). SQL and TS
  operate on byte-identical messages. Verified the 4-arg `digest(..., 'hex')` and the
  multi-arg `verify(...)` forms are exercised (and therefore supported) by the passing
  spec.
- **Schema duplication** — diffed the embedded `CONTROL_SCHEMA` against
  `schemas/control.qsql`: only **two** differing lines, both pre-existing CadrePeer
  *comments* outside this change's scope; all constraint logic is byte-identical. (The
  drift hazard itself is owned by `control-schema-duplicated-no-drift-guard`.)
- **Caller audit** — `insertStrand` is called only from the harness `test-network.ts`
  (the RN reference-app caller is a not-yet-implemented ticket); the `signStampId →
  signMessage` signature change breaks no production caller. `insertAuthorityKey` callers
  (seed/peer-record/trust-circle specs, `test-party.ts`) are unaffected — its public
  signature is unchanged.
- **Bootstrap count semantics** — the `(select count(1) from AuthorityKey) <= 1` bypass
  was a flagged concern. The passing *transplant-rejected* AuthorityKey test proves the
  new row IS counted during the check (count = 2 on the second insert), so the bypass
  cannot be abused to insert an unsigned second authority key. Genesis remains idempotent
  (count = 1 on the first insert).
- **Attack-path reasoning** — transplant (different row), cross-table, exact replay, and
  field tamper are all closed: rebinding `verify` to the actual row fails any transplant,
  and PK + unique StampId block exact replay. Same-StampId reuse across *different* tables
  is possible but confers no advantage (each table still requires its own valid row-bound
  signature).
- **Lint** — `yarn lint`: 0 errors, 119 pre-existing backlogged warnings. Warnings in the
  changed files (`control-database.ts` any-types in plugin registration / fs require;
  `test-network.ts` unused imports) are all pre-existing; this change introduces none.
- **Tests** — `yarn workspace @serfab/cadre-core test`: all pass (304 before, 305 after
  the added case below). `cadre-core` build clean.
- **Docs** — `docs/architecture.md`, `cadre-host.md`, `cadre-consistency.md`, `STATUS.md`
  reference the control tables only at the purpose level (table inventory, authority-key
  trust anchoring); none document the constraint signature/StampId mechanism, so nothing
  is rendered stale by this change. No doc update required.

### Findings and disposition

- **Minor (fixed inline):** the spec had **no positive test for a closed strand carrying
  a real, non-null `MemberPrivateKey`** — the `coalesce(new.MemberPrivateKey, '')` path was
  only exercised negatively (the smuggled-key tamper case), which passes whenever `verify`
  fails for *any* reason and so could not confirm the non-empty member-key actually
  round-trips through both `buildAuthorizationMessage` and the SQL `coalesce`. Added
  `happy path: a closed strand carrying a real MemberPrivateKey round-trips` to
  `control-authorization-binding.spec.ts`, asserting the row persists with the exact
  member key, `Type='c'`, and a populated StampId. Test passes.

- **Major:** none. No new tickets filed.

- **Out of scope (already ticketed, intentionally untouched, verified still consistent):**
  - `FormationInvite.AuthorizedAddOrRemove` still uses the no-curve
    `verify(digest(context.StampId), context.Signature, A.Key)` form (defaults to
    secp256k1) — owned by `formationinvite-fix-curve-and-wire-consent`.
  - Two verbatim copies of the schema — owned by
    `control-schema-duplicated-no-drift-guard`; this change kept them in sync.

- **Noted, no action (no writer exists; correct by construction / documented):**
  - The Strand `FormationUsage`-branch insert path has no signed writer yet but must
    supply a fresh unique `StampId` to satisfy the new not-null/unique column — already
    called out in a schema comment; the future formation writer must honor it.
  - The AuthorityKey `old.Key is not null` (update/rotation) branch has no writer and no
    test; it was rebound consistently with the insert branches. Low priority until a key
    rotation writer is built.

### Validation performed (review pass)

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn lint` — 0 errors (pre-existing warnings only; none in the diff).
- `yarn workspace @serfab/cadre-core test` — **305 tests / 22 files pass** (added one
  closed-strand round-trip case to the existing 304).
- No pre-existing failures surfaced; `tickets/.pre-existing-error.md` not written.
- Integration-test scenarios not executed (slow/flaky, not agent-runnable in the idle
  budget); the only path touching this change is the `createStrand` harness, exercised
  indirectly. A reviewer with a stable environment may run the relevant scenario(s).
