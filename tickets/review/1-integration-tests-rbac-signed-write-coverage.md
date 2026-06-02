description: Review the new sApp signed-write RBAC integration coverage (authorized accepted / unauthorized rejected on a real strand) and the repaired+collapsed simple-sapp fixture.
prereq:
files: packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts, packages/integration-tests/fixtures/simple-sapp.qsql, packages/integration-tests/src/fixtures/index.ts, packages/integration-tests/src/scenarios/happy-path.integration.ts, tickets/.pre-existing-error.md

# Summary

Adds the missing sApp-level RBAC integration coverage and repairs/collapses the
`verify()`-gated fixture. A new scenario drives a signed write through a **real**
two-`CadreNode` strand (formed over libp2p) and asserts authorized writes are accepted
while unauthorized ones are rejected. The malformed fixture was repaired so it actually
verifies signatures, and the dead fixture surface was retired.

**Status: build + typecheck green; the new scenario passes (3.7s).**

# What changed

### `packages/integration-tests/fixtures/simple-sapp.qsql` — repaired, now the single source
- `AuthorizedWrite` now digests the **concatenated authenticated payload**
  `new.Id || '|' || new.Name || '|' || coalesce(new.Value,'')` with `'sha256','utf8'`
  (was passing `new.Name`/`new.Value` as the digest *algorithm*/*encoding* args — the
  core malformation). Both the insert and update branches now require a valid signature
  (the old fixture only signed on update, so a missing/forged signature on insert went
  unchecked).
- All `verify()` calls now pass the explicit `'ed25519'` curve (the suite's member keys
  are ed25519; `verify()`/`sign()` default to secp256k1). Schema and signer are on the
  same curve.
- `AuthorizedDelete` digests `old.Id` with `'sha256','utf8'` (was relying on the default
  `base64url` input encoding).
- Update branch also pins `new.CreatedBy = context.MemberKey` so ownership can't be
  reassigned.
- Context is `with context (MemberKey text, Signature text null)` — `Signature` is
  nullable so a *missing* signature reaches `verify()` (→ false) rather than tripping a
  NOT-NULL context error, which lets the "missing signature" negative exercise the real
  verify path.

### `packages/integration-tests/src/fixtures/index.ts` — collapsed to one source
- Removed the inline `SIMPLE_SAPP_LOGIC` duplicate and the dead `wrapSAppSchema` helper.
  `simple-sapp.qsql` (loaded via `loadSimpleSApp()`) is now the single source of truth,
  so there is no second copy of the app logic to drift. `MINIMAL_SAPP_LOGIC` is retained
  (still used by other scenarios).
- `loadSimpleSApp()` is now exercised by two scenarios (rbac + happy-path).

### `packages/integration-tests/src/scenarios/happy-path.integration.ts`
- Switched from the removed `SIMPLE_SAPP_LOGIC` import to `await loadSimpleSApp()`.
  (happy-path's `createStrand` is a stub that only stores the schema string, so the
  constrained content is inert there.)

### `packages/integration-tests/src/scenarios/rbac-signed-write.integration.ts` — NEW
Two real `CadreNode`s, `formStrand` over libp2p, `addStrand({ strandRow, sAppConfig })`
on each side (sAppConfig signed via `createSignedSAppConfig`/`signSchema`, ed25519). All
RBAC writes go through `strand.database!.getDatabase().exec(...)` with
`with context MemberKey = ?, Signature = ?` DML.

# Key contract the reviewer should verify

**Signer ↔ constraint payload identity** (the crux of the repair):
- Signer: `hashBytes = digest(\`${Id}|${Name}|${Value ?? ''}\`, 'sha256','utf8','bytes')`,
  then `sign(hashBytes, memberPrivKey, 'ed25519')`.
- Constraint: `verify(digest(Id||'|'||Name||'|'||coalesce(Value,''),'sha256','utf8'), Signature, MemberKey, 'ed25519')`.
- These agree because `digest(...,'utf8')` (default `base64url` output) is the base64url
  form of the same hash bytes, and `verify()`'s default `base64url` input encoding
  decodes it back to those bytes. Confirm the JS `${Value ?? ''}` and SQL
  `coalesce(Value,'')` stay byte-identical for any value the tests use (all non-null
  here).

**`with context` DML param ordering**: positional `?` bind in textual order, context
placeholders first. INSERT uses `... with context MemberKey=?, Signature=? values(?,?,?,?)`
(6 params: MemberKey, Signature, Id, Name, Value, CreatedBy). UPDATE/DELETE put
`with context` right after the table name, before `set`/`where` (parser allows it there
or trailing). Verified against `control-database.ts:394-398` and the Quereus parser
(`parser.ts:2046-2154`).

# Test cases (what is asserted)

All assertions are **local to the writer (Alice)** — sApp RBAC is enforced at write time
on the writing node, so this is mode-independent and deterministic.

1. **Authorized insert accepted** — M inserts `item-1` (`CreatedBy=M`, valid sig) →
   succeeds; row present with correct Name/Value/CreatedBy.
2. **Authorized update accepted** — M updates `item-1.Value` with a fresh valid sig →
   succeeds; value changes.
3. **Unauthorized insert rejected — wrong-payload signature** — `CreatedBy/MemberKey=M`
   but sig is over a different payload → `rejects.toThrow()`; `item-2` absent.
4. **Unauthorized insert rejected — missing (null) signature** → rejects; `item-3` absent.
5. **Unauthorized update rejected — wrong member** — N (≠M) tries to update M's row with
   a *valid* sig of N's own → rejects via the ownership clause
   (`old.CreatedBy = context.MemberKey`); `item-1` unchanged (`Value='updated'`,
   `CreatedBy=M`).
6. **Unauthorized delete rejected — non-creator** — N deletes `item-1` → rejects;
   `item-1` still present.
7. **Authorized delete accepted — creator** — M deletes `item-1` → succeeds; row gone.

# Resolved question from the source ticket

The ticket flagged a possible production gap: *can `with context` DML reach `App.*` DML
when `executeSchema` wraps the schema in `declare schema App { ... } apply schema App;`?*
**It works.** The authorized signed insert/update/delete were accepted and the negatives
rejected through `StrandDatabase.getDatabase().exec(... with context ...)`. No backlog
ticket needed for this path.

# Known gaps / honest limitations (please scrutinize)

- **Cross-node replication is NOT asserted.** The two-node strand runs in `bootstrap`
  (local-transactor) mode because no `CadrePeer` rows exist yet (control-sync unwired),
  so writes stay node-local. The scenario keeps a real, non-throwing check that the
  constrained schema **applies on Bob's node** and treats replication as a *logged
  best-effort observation* (`replication observed=false`), not a gating assertion. This
  is the same limitation that makes `strand-formation-e2e` Phase 2 ("replicate data")
  pre-existing-red — see `tickets/.pre-existing-error.md`. Networked-mode replication is
  owned by ticket `2-integration-tests-real-control-sync-and-scenario-honesty`. A
  reviewer wanting end-to-end RBAC-under-replication should treat that as the follow-up,
  not re-litigate it here.
- **Single effective writer.** Because of bootstrap mode, Bob's DB never receives the
  writes; the "wrong member N" case exercises a different *MemberKey in context*, not a
  different *node*. That is the correct unit of sApp RBAC (application identity, not peer
  identity), but note it is not a second-node-initiated write.
- **Negative case (b) rejects via the ownership clause before the signature is decisive.**
  N signs validly to isolate `old.CreatedBy = context.MemberKey` as the rejecting
  predicate. If a reviewer prefers, an additional case where N supplies an *invalid* sig
  would also reject (redundantly) via the verify clause.
- **`coalesce`/`||` byte-equivalence** with the JS payload is only exercised for non-null
  `Value`. A row with a null `Value` (both sides → empty segment) would be worth adding.
- The scenario re-declares small local copies of `wsTransports`/`createTestNodeConfig`/
  `createMockProvisioner`/`createSignedSAppConfig` (mirroring `strand-formation-e2e`,
  where they are file-local and not exported). Possible DRY cleanup: lift these into the
  harness. Left as-is to avoid touching the e2e file.

# Validation performed

- `yarn workspace @serfab/integration-tests typecheck` → exit 0
- `yarn workspace @serfab/integration-tests build` → exit 0
- `yarn workspace @serfab/integration-tests test rbac-signed-write` → **1 passed** (3.7s)
- Diagnostic: `... test strand-formation-e2e -t "replicate data"` → fails at HEAD
  (pre-existing; documented in `tickets/.pre-existing-error.md`).

Not run: the full integration suite (many heavy real-network scenarios; several are
slow/flaky independent of this change). happy-path was not run — its `createStrand` stub
only stores the schema string, and `loadSimpleSApp()` file resolution is already proven
to work by the passing rbac scenario.
