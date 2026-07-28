----
description: A party's list of owner keys could be taken over by anyone able to write to the control database — a stranger could add itself as an owner, and any owner could be deleted with no approval at all, including the last one. Both holes are closed and covered by tests.
files: schemas/control.qsql (OwnerKey block), packages/cadre-core/src/control-schema.ts (mirrored CONTROL_SCHEMA), packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts (17 tests), packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/src/control-database.ts (insertOwnerKey), docs/architecture.md
----

# `CadreControl.OwnerKey` — escalation and deletion holes closed

## What shipped

`OwnerKey` had three defects, each measured against a real control database:

1. **Self-authorization.** The `Authorized` CHECK carries a subquery, so Quereus defers it to
   COMMIT and evaluates it against the *post*-mutation row set. A key holding no owner row
   could insert itself, sign its own row, name itself `context.OwnerKey`, and be accepted.
   Two strangers could likewise seat each other in one transaction.
2. **Deletes were entirely unauthorized.** A bare `check (...)` covers insert + update only,
   so *any* owner row could be removed with no signature — including the last one, which
   permanently bricks the party's control plane (every other `CadreControl` table's CHECK
   requires an `OwnerKey` row).
3. **The bootstrap branch was not gated to the founding state.** `(select count(1) from
   OwnerKey) <= 1` was a post-image count, so it was also true of an unsigned update that
   re-pointed the sole owner row at an attacker key, and of a same-transaction
   delete-founder + insert-attacker swap.

The constraint block, mirrored byte-for-byte in `schemas/control.qsql` and
`packages/cadre-core/src/control-schema.ts`:

```sql
constraint MinOneOwner check on delete ((select count(1) from OwnerKey) >= 1),
constraint NoUpdate check on update (false),
constraint Authorized check on insert, delete (
    (old.Key is null and (select count(1) from committed.OwnerKey) = 0)
        or (old.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519')))
        or (new.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and A.Key <> old.Key and verify(digest(old.Key, old.StampId, 'remove'), context.Signature, A.Key, 'ed25519')))
)
```

`committed.OwnerKey` is Quereus's read-only view of the **pre-transaction** snapshot, pinned
at transaction start. Reading the authorizer set from it states the rule directly — *the
authorizer must have existed before this transaction* — which kills self-insertion, mutual
pairs, and rings of any length without the extra `Generation` column the sibling
`Strand.Manager` fix needed.

No writer, column, or signed payload changed. `ControlDatabase.insertOwnerKey` (the only
production writer, the genesis path) still works: on a fresh party `committed.OwnerKey` is
empty. Rotation is add-then-remove (no update path), and an owner cannot sign its own removal
(`A.Key <> old.Key`).

### Digest shapes (for a future admin flow)

| Operation | Signed message (via `buildAuthorizationMessage`) | `context.OwnerKey` |
|-----------|--------------------------------------------------|--------------------|
| Genesis (empty table) | none — unsigned | null |
| Enroll owner | `[new.Key, new.StampId]` | a pre-existing owner |
| Remove owner | `[old.Key, old.StampId, 'remove']` | a **different** pre-existing owner |

## Review findings

### Checked

Read the implement diff (`bec4a48`) before its handoff summary, then the whole `CadreControl`
schema, `control-database.ts`, `seed-bootstrap.ts`'s peer write paths, the drift guard, and
every doc that mentions `OwnerKey` (`docs/architecture.md`, `docs/cadre-host.md`,
`docs/STATUS.md`, `docs/reference-app-rn.md`). Attack paths and behavioural claims were
re-verified against a real control database with throwaway probe specs, deleted afterwards.

Specifically confirmed sound, no change needed:

- Every branch of `Authorized` is disambiguated by `old.Key is null` / `new.Key is null`, so
  insert and delete cannot borrow each other's clause.
- An unsigned delete supplies `context.OwnerKey = null`, which makes `A.Key = context.OwnerKey`
  null and the `exists` false — it does not accidentally match.
- Removing the old update-authorization branch breaks nothing: no code anywhere issues
  `update CadreControl.OwnerKey`, only `insertOwnerKey` writes the table.
- `MinOneOwner` is genuinely belt-and-braces for the sole-owner case (with one owner there is
  no *other* pre-existing owner to sign, so `Authorized` already refuses), but it is the only
  thing standing between the party and an unauthorizable control DB in the two-owner mutual
  removal, which is now pinned by a test.
- The two schema copies are byte-identical; the drift guard passes.

### Fixed in this pass (minor)

- **Stale comment in `control-database.ts:insertOwnerKey`** cited the deleted
  `(select count(1) from OwnerKey) <= 1` constraint as the branch that authorizes genesis.
  Rewritten to describe the actual `committed.OwnerKey` genesis branch and to point a reader
  at the documented digests for the paths this method does *not* cover.
- **Tests only asserted `rejects.toThrow()`.** Every rejection would have gone green on a
  mistyped statement or an incidental transaction error, silently retiring the attack it
  claimed to pin — the implement handoff flagged this gap itself. Added an
  `expectConstraintFailure(write, ...names)` helper and named the constraint each attack must
  trip (`Authorized`, `NoUpdate`, `MinOneOwner`; the last-owner unsigned delete violates two
  at once and accepts either, since the deferred queue does not promise an order).
- **Two coverage gaps closed.** `an owner enrolled by the founder can itself enroll a third
  owner` pins that authority is transitive across transactions (the rule is "any pre-existing
  owner", not "the founder"). `the founding transaction may seat more than one unsigned key`
  pins a real semantic change the handoff did not mention — see below.
- **Undocumented behaviour change.** Because the bootstrap branch now tests the
  *pre-transaction* count rather than the post-image, a founding transaction may insert any
  number of unsigned keys, where the old `count <= 1` capped it at one. Not an escalation —
  whoever writes the founding transaction already owns the party outright — but the schema
  comment claiming "first owner key" was wrong. Comment corrected in both copies and the
  behaviour is now under test.
- **`docs/architecture.md` table cell** had grown to a ~90-word paragraph in a column whose
  other cells are 5–10 words, which is unreadable as a table. Compressed to the scannable
  claim; the detail already lives in the schema's constraint comments and in the trust-anchor
  paragraph at line 321.
- **Two schema comments asserted anti-replay guarantees the code does not provide** — the
  `StampId` column comment ("single-use authorization nonce (anti-replay)") and the enroll
  branch's "single-use via unique StampId". Corrected in both copies, with a pointer to the
  ticket below. A false security comment is worse than none.

### Filed as new tickets (major)

Both were reproduced against a real control database during this review, and both are
**pre-existing** — neither is introduced or worsened by this diff.

- **`tickets/backlog/bug-control-remove-then-replay-resurrection`** — `StampId` uniqueness only
  spans *live* rows, so once a row is deleted its stamp frees up and the original enrollment
  signature verifies again. Verified: enroll owner K → properly signed removal of K → replay
  the original insert verbatim → K is an owner again. The same works for `CadrePeer`, which is
  worse there because `removePeer` is a live production path and the approval is stored on the
  row itself (`VouchOwner`/`VouchSig`), so the peer being removed can read and keep it. This
  makes every removal undoable by any writer holding the original approval.
- **`tickets/backlog/bug-control-approval-signatures-not-scoped-to-table`** — signed approval
  messages carry no table, action, or party identity. `OwnerKey.Authorized` and
  `ValidationKey.Authorized` both verify `digest(Key, StampId)` against an owner key, so an
  owner's approval to add a narrowly-scoped *validation* key is byte-identical to an approval
  to add that key as a full **owner**. Verified via the shipped `insertValidationKey` API, then
  replaying its signature as an `OwnerKey` insert: accepted. Dormant in-repo (no caller outside
  tests) but the API ships. Filed separately from the two existing anti-replay tickets because
  a nonce does not fix it and it wants one domain-separation scheme across all of `CadreControl`.

Both tickets recommend the human promote them ahead of feature work; they are in `backlog/`
to match where the sibling control-plane security follow-ups already sit, not because they are
speculative.

### Recorded as tripwires, not tickets

- **`MinOneOwner` is a per-transaction, locally-visible count.** Two partitioned nodes each
  removing a different owner can each see a survivor and still converge to zero owners. Already
  parked by the implementer as a `NOTE:` beside the constraint in both schema copies (mirroring
  `Strand.Manager.MinOneManager`); left as-is. Conditional: partitioned owner rotation is not a
  workflow today.

### Checked and inconclusive — no finding raised

- **Warm-restart schema apply.** Adding constraints to a table that already has rows could in
  principle fail the declarative diff. Probed by re-applying `CONTROL_SCHEMA` over a live,
  populated catalog: it processed `OwnerKey` (the first table, and the only one this diff
  changes) without complaint, then tripped on an unrelated `ALTER COLUMN CadrePeer.UpdatedAt
  SET DATA TYPE int`. That probe is *not* the production warm-restart path — the real one
  hydrates persisted vtab schemas before applying — so the `CadrePeer` error is most likely an
  artifact of the probe rather than a defect, and there is no in-repo test that exercises a
  true warm restart of a persisted control DB. Recorded here rather than filed, because I could
  not substantiate a real failure; the honest state is "the new `OwnerKey` constraints showed no
  problem, and warm restart of a persisted control DB remains untested either way".

### Known gaps carried forward from implement (re-checked, still true)

- **No multi-node coverage.** Nothing exercises these constraints over a real replicated control
  network; `committed.*` correctness depends on the Optimystic vtab honouring Quereus's
  `_readCommitted` flag, proven here only on a single local node. The cross-node path is blocked
  behind `control-db-convergence-optimystic-p2p` (see `tickets/.pre-existing-known.md`).
- **The replicated `OwnerKey` table is still not a trust anchor.** A node whose *local* copy is
  genuinely empty satisfies the genesis branch and can seat its own key, which then replicates.
  `docs/architecture.md:321` says exactly that; the node-local `TrustedOwnerStore` remains the
  real anchor. Reviewed and agreed with that framing.
- **No migration.** Per project policy there is none for control databases written before this
  change; an already-polluted `OwnerKey` table stays polluted, the fix only prevents further
  escalation.
- **The enroll and remove paths have no production writer** — reachable only via raw SQL. No
  speculative writer was added; the digests are documented above and in the schema comments.
- **Severity framing.** The attacker needs write access to the party's control collection. The
  Optimystic control-DB protocols expose no per-stream authorization hook
  (`tickets/blocked/control-repo-protocol-stream-authz-optimystic`), and
  `membership-connection-gater.ts` is a deliberately fail-open *connection* gate. So the
  clearly-reachable attacker is an already-admitted cadre peer escalating itself; the network
  layer should not be described as stopping this.

## Validation

| Command | Result |
|---------|--------|
| `packages/cadre-core` → `yarn vitest run test/control-ownerkey-self-authorization.spec.ts test/control-schema-drift.spec.ts` | 17 passed |
| `packages/cadre-core` → `yarn test` | 55 files, **790 passed / 1 skipped** |
| `packages/cadre-host` → `yarn test` | 54 files, **448 passed / 3 skipped** |
| repo root → `yarn typecheck` | clean |
| repo root → `yarn lint` | clean (exit 0) |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
