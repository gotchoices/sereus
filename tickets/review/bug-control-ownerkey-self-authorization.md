description: A party's owner-key list could be taken over by anyone able to write to the control database — a stranger could enroll itself as an owner, and any owner could be deleted with no authorization at all, including the last one. Both holes are now closed and covered by tests.
files: schemas/control.qsql (OwnerKey block, lines 4-49), packages/cadre-core/src/control-schema.ts (mirrored CONTROL_SCHEMA, lines 15-60), packages/cadre-core/test/control-ownerkey-self-authorization.spec.ts (new, 14 tests), packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/test/control-authorization-binding.spec.ts, packages/cadre-core/src/control-database.ts (insertOwnerKey, line 545 — unchanged), docs/architecture.md (lines 34, 321)
difficulty: medium
----

# `CadreControl.OwnerKey` — escalation and deletion holes closed

## What changed

`OwnerKey` had three defects, all previously measured against a real control database:

1. **Self-authorization.** The `Authorized` CHECK carries a subquery, so Quereus defers it
   to COMMIT and evaluates it against the *post*-mutation row set. A key holding no owner
   row could insert itself, sign its own row, name itself `context.OwnerKey`, and be
   accepted — the in-flight row satisfied its own authorizer subquery. Two strangers could
   likewise seat each other in one transaction.
2. **Deletes were entirely unauthorized.** A bare `check (...)` covers insert + update only.
   The constraint never named `delete`, so *any* owner row could be removed with no
   signature — including the last one, which permanently bricks the party's control plane
   (every other `CadreControl` table's CHECK requires an `OwnerKey` row).
3. **The bootstrap branch was not gated to the founding state.** `(select count(1) from
   OwnerKey) <= 1` was a post-image count, so it was also true of an unsigned update that
   re-pointed the sole owner row at an attacker key, and of a same-transaction
   delete-founder + insert-attacker swap.

The `OwnerKey` constraint block in **both** schema copies is now:

```sql
constraint MinOneOwner check on delete ((select count(1) from OwnerKey) >= 1),
constraint NoUpdate check on update (false),
constraint Authorized check on insert, delete (
    (old.Key is null and (select count(1) from committed.OwnerKey) = 0)
        or (old.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and verify(digest(new.Key, new.StampId), context.Signature, A.Key, 'ed25519')))
        or (new.Key is null and exists (select 1 from committed.OwnerKey A where A.Key = context.OwnerKey and A.Key <> old.Key and verify(digest(old.Key, old.StampId, 'remove'), context.Signature, A.Key, 'ed25519')))
)
```

`committed.OwnerKey` is Quereus's read-only view of the **pre-transaction** snapshot,
pinned at transaction start (`CadreControl` already used it for `FormationUsage.Monotonic`).
Reading the authorizer set from it states the rule directly — *the authorizer must have
existed before this transaction* — which kills self-insertion, mutual pairs, and rings of
any length without the extra `Generation` column the sibling `Strand.Manager` fix needed.

No writer, column, or signed payload changed. `ControlDatabase.insertOwnerKey` (the only
production writer, the genesis path) is untouched and still works: on a fresh party
`committed.OwnerKey` is empty. No production code enrolls a second owner or deletes one;
those paths exist only in the schema and in the new tests. **Rotation is add-then-remove**
(no update path), and **an owner cannot sign its own removal** (`A.Key <> old.Key`).

## Digest shapes (for anyone writing a future admin flow)

| Operation | Signed message (via `buildAuthorizationMessage`) | `context.OwnerKey` |
|-----------|--------------------------------------------------|--------------------|
| Genesis (empty table) | none — unsigned | null |
| Enroll owner | `[new.Key, new.StampId]` | a pre-existing owner |
| Remove owner | `[old.Key, old.StampId, 'remove']` | a **different** pre-existing owner |

The `'remove'` scoping mirrors `CadrePeer.AuthorizedDelete`: an enrollment signature can
never be replayed as a removal, or vice versa. Both directions are pinned by tests.

## Use cases for validation

Boot a `CadreNode` (`{ controlNetwork: { partyId: <unique>, bootstrapNodes: [] }, profile:
'transaction' }`), seed one founder with `ensureOwnerKey`, then drive raw SQL through
`node.getControlDatabase()!.getDatabase()`. **A fresh node per case** — these attacks mutate
the owner set (one emptied it pre-fix), so a shared DB leaks state between probes.

Should be **accepted**:

- `ensureOwnerKey` on a fresh party seats the founder (the only production path).
- A pre-existing owner enrolls a second owner, signing `[Key, StampId]`.
- A pre-existing owner removes a *different* owner, signing `[Key, StampId, 'remove']`.

Should be **rejected**, with the owner row set unchanged:

- A stranger enrolling itself by signing its own row (`Authorized`).
- Two strangers seating each other in one transaction (`Authorized`).
- An unsigned delete of one owner while two exist (`Authorized`).
- An unsigned delete of the last owner (`MinOneOwner` fires first).
- A signed *mutual* removal that would empty the table (`MinOneOwner`).
- An owner signing its own removal (`Authorized`, the `A.Key <> old.Key` clause).
- An unsigned update re-pointing the sole owner row (`NoUpdate`).
- An unsigned delete-of-founder + insert-of-attacker in one transaction (`Authorized`).
- An enrollment signature replayed as a removal, and a removal signature replayed as an
  enrollment (`Authorized`).
- A garbage signature presented by a *real* owner — the negative control. This is the case
  that would go green if a future edit disabled the constraint outright, so it is the one
  worth keeping honest.

Each of those rejection paths was individually confirmed to raise a
`ConstraintError: CHECK constraint failed: <name>` for the **intended** constraint (checked
with a throwaway spec during implementation, then deleted), not an incidental SQL or
transaction error. That check is not itself automated — the committed tests assert
`rejects.toThrow()` only.

## What was run

| Command | Result |
|---------|--------|
| `packages/cadre-core` → `yarn vitest run test/control-schema-drift.spec.ts` | 1 passed (the two schema copies match) |
| `packages/cadre-core` → `yarn vitest run test/control-ownerkey-self-authorization.spec.ts` | 14 passed |
| `packages/cadre-core` → `yarn test` | **55 files, 788 passed / 1 skipped** |
| `packages/cadre-host` → `yarn test` | **54 files, 448 passed / 3 skipped** (includes `trust-circle-integration.test.ts`, which inserts an owner key) |
| repo root → `yarn typecheck` | clean |
| repo root → `yarn lint`, plus `npx eslint` on the new spec | clean |

No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.

## Known gaps — read before signing off

- **No multi-node coverage.** Nothing exercises these constraints over a real replicated
  control network. `committed.*` correctness depends on the Optimystic vtab honouring
  Quereus's `_readCommitted` flag; that is only proven here on a single local node. The
  cross-node path is blocked behind `control-db-convergence-optimystic-p2p` (see
  `tickets/.pre-existing-known.md`) — do not re-report those integration failures.
- **`MinOneOwner` is a per-transaction, locally-visible count.** Two partitioned nodes each
  removing a different owner can each see a survivor and still converge to zero owners.
  Parked as a `NOTE:` beside the constraint in both schema copies (mirroring
  `Strand.Manager.MinOneManager`); it is a tripwire, not work, because partitioned owner
  rotation is not a workflow today.
- **The replicated `OwnerKey` table is still not a trust anchor.** A node whose *local* copy
  is genuinely empty satisfies the genesis branch and can seat its own key, which then
  replicates. `docs/architecture.md:321` was **sharpened, not retracted**, to say exactly
  that; the node-local `TrustedOwnerStore` remains the real anchor. If review disagrees with
  that framing, that paragraph is the place to argue it.
- **No migration.** Per project policy there is none for control databases written before
  this change. A pre-existing DB whose `OwnerKey` table was already polluted stays polluted;
  the fix only prevents further escalation.
- **The enroll and remove paths have no production writer.** They are reachable only via raw
  SQL. Digest shapes are documented above and in the schema comments; no speculative writer
  was added.
- **Severity framing (unchanged from the fix ticket, worth re-checking).** The attacker needs
  write access to the party's control collection. The Optimystic control-DB protocols expose
  no per-stream authorization hook (`tickets/blocked/control-repo-protocol-stream-authz-optimystic`),
  and `membership-connection-gater.ts` is a deliberately fail-open *connection* gate. So the
  clearly-reachable attacker is an already-admitted cadre peer escalating itself; the network
  layer should not be described as stopping this.
