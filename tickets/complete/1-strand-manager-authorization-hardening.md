description: Tightened the rules for who can administer a private group, so only real admins can appoint or remove admins and the last admin can never be removed. Reviewed — the rules hold one at a time, but a takeover route through a single multi-step transaction is still open and now tracked separately.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/cadre-core/test/strand-membership-writer.spec.ts, docs/strands.md, docs/architecture.md
----

# Manager authorization hardening (strand RBAC) — complete

## What shipped

A closed strand's administrators are the rows of `Strand.Manager`; every admit path
(issuing an invite, adding a member directly, promoting a manager) requires an existing
`Manager` row, so that table is the whole access-control story. Three constraint changes,
mirrored byte-equivalently in `schemas/strand.qsql` and the `STRAND_SCHEMA` constant in
`packages/quereus-plugin-sereus/src/strand-schema.ts`:

- **`NoUpdate check on update (false)`** — `Manager` rows are insert+delete only. An UPDATE
  would let a resignation signature (which proves only that `old.MemberKey` consented)
  double as a hand-off to an attacker-chosen key.
- **`MinOneManager check on delete ((select count(1) from Manager) >= 1)`** — deferred, so
  it sees the post-delete count. A strand can never reach zero managers (which would freeze
  it: no one left who can admit anyone).
- **`Authorized`** narrowed from `on insert, update, delete` to `on insert, delete`, with
  the bootstrap branch gated to INSERT *and* to the founding state (`old.MemberKey is null`,
  at most one `Manager`, at most one `Member`, and that member is this manager), and the
  other-manager branch gaining `A.MemberKey <> coalesce(new.MemberKey, old.MemberKey)` so a
  row cannot be its own authorizer.

Behavior table (measured, not inferred — a throwaway spec printed the actual rejecting
constraint for each path before the assertions were written):

| Operation | Outcome | Rejecting constraint |
|---|---|---|
| Founder bootstrap (Header → Member → Manager) | allowed | — |
| Existing manager promotes another key | allowed | — |
| Any key promotes **itself** | rejected | `Authorized` |
| Manager removes a different manager, ≥ 1 remains | allowed | — |
| Manager resigns itself, ≥ 1 other remains | allowed | — |
| Sole manager resigns | rejected | `MinOneManager` |
| Stranger removes the last manager | rejected | over-determined (both apply) |
| Stranger removes the second-to-last manager | rejected | `Authorized` |
| Any `update` on `Manager` | rejected | `NoUpdate` |
| Same-txn delete-sole + insert-successor | rejected | `Authorized` |
| **Two keys promote each other in one txn** | **accepted — see finding below** | — |

Six tests in `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` pin the
rejections (with a regex on the constraint name where deterministic) *and* that the row set
is unchanged. Writer JSDoc in `strand-membership-writer.ts` and a new
`## Who May Administer a Closed Strand` section in `docs/strands.md` state the invariants in
plain terms.

## Review findings

### Major — filed as a new ticket

- **Two keys can promote each other in one transaction and take the strand over.**
  `Authorized` is deferred, so it evaluates at commit against the post-image. The `<>` guard
  excludes only the row's *own* key, not sibling rows inserted in the same transaction — so
  two freshly-generated keypairs that each sign the other's promotion are both accepted
  (each is the other's "existing" manager), and the same transaction can then delete every
  real manager, since by then the attacker rows are managers and `MinOneManager` is
  satisfied by them. **Reproduced against a real strand DB**: the commit succeeds and the
  founder is evicted, leaving `Manager` holding exactly the two attacker keys. The control
  case — the same insert issued as a lone statement — is correctly rejected with
  `CHECK constraint failed: Authorized`, so the hole is specifically the same-transaction
  window. This is not a regression (the pre-change schema had a strictly wider hole: any
  single key could self-promote); it is the same class of defect left unclosed. Filed as
  `tickets/fix/1-strand-manager-same-txn-mutual-promotion.md`, and marked with an
  `OPEN HOLE:` comment at the constraint in both schema copies. Not fixed inline: a `CHECK`
  expression can only see the post-image, so "did this authorizer exist before the
  transaction?" is not answerable from where the rule currently lives — that is a design
  question, not an edit.

### Minor — fixed in this pass

- **`docs/architecture.md` was never updated by the implement stage** (only `docs/strands.md`
  was). Three passages were left describing the old schema, one of them flatly wrong:
  - The "Manager-removal hazards" paragraph still carried a ⚠️ warning that removing the
    last or second-to-last manager "is accepted regardless of signature" and that a
    min-one-manager invariant "is deferred to a future schema change" — the exact thing this
    ticket shipped. Rewritten to state the closed hazard, `MinOneManager`, `NoUpdate`, the
    add-then-resign hand-off order, and both remaining gaps.
  - The `addManager` bullet still explained the bootstrap shortcut as "no longer applies
    because the count is ≥ 2" and did not mention the `<>` self-promotion guard. Corrected.
  - The closed-strand bootstrap bullet described an ungated `count(…) <= 1` branch. Corrected
    to the narrow founding-state gate, and it now says why Header→Member→Manager order is
    load-bearing rather than conventional.
- **`docs/strands.md` overstated the guarantee.** "A key cannot promote itself" is true per
  promotion but reads as a blanket rule; qualified, and the mutual-promotion gap added to
  the known-gaps list with its ticket slug.
- **Stale header comment** in `strand-membership-peer-rotation.spec.ts` still explained the
  bootstrap branch as a count test. Corrected.

### Gap from the handoff — closed

The implement handoff named "an in-process two-database replay" as the highest-value
follow-up: the new bootstrap branch is gated on `count(Member) <= 1`, so if a node that
acquires an already-populated strand replayed membership rows as SQL DML, the founding
`Manager` row would be re-checked against a multi-member strand and rejected. Added
`hydrates a grown strand (3 members, 2 managers) into a fresh Database without re-running
membership CHECKs` to `strand-membership-writer.spec.ts` — it grows a strand past the
founding state, shuts the connection down, and hydrates a brand-new `Database` over the
same persisted blocks. It passes, so rows arrive as committed blocks and the CHECKs do not
re-run. The test also promotes a third manager in the warm session on the signature of a
manager appointed in the cold one, proving the hydrated rows really back the constraints
rather than being an inert snapshot. This is the in-process analogue only — a genuine
two-node replay still runs solely through the scenarios blocked on
`control-db-convergence-optimystic-p2p`.

### Checked, nothing found

- **Manager-seeding order.** Every site that seats a `Manager` row re-verified: the writer
  (Header→Member→Manager), both sites in `quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`,
  and the open-strand rejection cases. No Manager-first path exists; a future one would fail
  loudly at commit, not silently.
- **`NoUpdate` breaking a real caller.** No code path anywhere updates a `Manager` row —
  grepped across all packages. `MemberPeer` (which has no `NoUpdate`) still accepts updates,
  so the rejection is genuinely the constraint.
- **Schema copy equivalence.** The TS copy escapes the backticks that would terminate the
  template literal; the drift spec compares runtime values and passes (15 tests), and the
  escape is still the only delta after this pass's added comment.
- **Same-transaction hand-off variants.** Delete-sole-plus-insert-successor is rejected;
  a newly-inserted manager cannot authorize anything the attacker does not already hold the
  private key for; a multi-row delete cannot be signed by one signature.

### Conditional concerns — parked as tripwires, not tickets

- **Cross-node concurrent removal can still empty the `Manager` table.** `MinOneManager`
  counts rows visible to one transaction, so two partitioned nodes each removing a different
  manager can both see a survivor. Fine today; only becomes work if partitioned rotation
  becomes a real workflow. Parked as a `NOTE:` inside the constraint in both schema copies,
  and mirrored in `removeManager`'s JSDoc and the `docs/strands.md` section.

### Out of scope, already tracked

- `bug-strand-manager-authority-antireplay` — one signature over `digest(X)` authorizes both
  adding X and removing X, so a captured add-authorization replays as a removal.
- `debt-strand-manager-must-be-member` — a manager key need not have a `Member` row (by
  design today; `addExtraManagers` in the specs depends on it).
- `bug-control-ownerkey-self-authorization` — the same self-authorization shape in the
  control schema. The new mutual-promotion ticket cross-references it: whatever closes the
  strand case should be checked against `CadreControl`'s owner-key branch too.
- **`Strand.Member` has no delete constraint at all** (the schema carries a
  `-- TODO: handle member revocation constraint`), so any key can delete member rows. Noted
  here for the record; unchanged by this ticket and outside its scope. It does not compound
  the manager story — `MinOneManager` and the founding-state gate mean an emptied `Member`
  table cannot be parlayed into a manager seat.

## Validation

Plugin rebuilt first (cadre-core's tests import the plugin's built `dist`, so an unbuilt
schema edit silently tests the OLD schema).

- `packages/quereus-plugin-sereus`: `yarn build` OK; `yarn vitest run test/strand-schema-drift.spec.ts` → **15 passed**.
- `packages/cadre-core`: full `yarn test` → **54 files, 762 passed, 1 skipped** (761 before
  this review pass; +1 hydration test).
- `packages/quereus-plugin-sereus`: full `yarn test` → 6 files passed, 1 failed —
  `test/e2e/networked.e2e.spec.ts` (4 tests), already listed in
  `tickets/.pre-existing-known.md` as blocked on `control-db-convergence-optimystic-p2p`. It
  fails in libp2p transaction validation (`membership-not-admitted:low-confidence-downsize`)
  during table creation, before any `Strand.Manager` write. Not re-reported, not touched.
- Root `yarn lint` → clean. `yarn typecheck` in both packages → clean (exit 0).
