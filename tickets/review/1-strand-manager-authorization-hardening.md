description: Tightened the rules for who can administer a private group, so only real admins can appoint or remove admins and the last admin can never be removed (which used to freeze the group forever). Needs a review pass.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, docs/strands.md
difficulty: medium
----

# Manager authorization hardening (strand RBAC) — implement handoff

A closed strand's admins are the rows of `Strand.Manager`. Every admit path (issuing an
invite, adding a member directly, promoting an admin) requires an existing `Manager` row,
so that table is the whole access-control story. Three holes were closed, plus one narrower
fourth.

## What changed

**`Manager` table declaration** — replaced in BOTH copies (`schemas/strand.qsql` and the
`STRAND_SCHEMA` constant in `packages/quereus-plugin-sereus/src/strand-schema.ts`, which
must stay byte-equivalent):

- `constraint NoUpdate check on update (false)` — new. `Manager` rows are insert+delete
  only. An UPDATE would let a resignation signature (which proves only that
  `old.MemberKey` consented) double as a hand-off to an attacker-chosen key.
- `constraint MinOneManager check on delete ((select count(1) from Manager) >= 1)` — new.
  Deferred, so it sees the post-delete count; a strand can never reach zero managers.
- `constraint Authorized` — narrowed from `on insert, update, delete` to `on insert,
  delete`, with two fixes:
  - the bootstrap branch is now gated to INSERT (`old.MemberKey is null`) **and** to the
    founding state (`count(Manager) <= 1` **and** `count(Member) <= 1` **and** the new
    manager already has a `Member` row). Previously an ungated count test was also true
    for any DELETE dropping the count to ≤ 1.
  - the other-manager branch gained `A.MemberKey <> coalesce(new.MemberKey,
    old.MemberKey)`. The check is deferred, so it runs at commit against the POST-insert
    row set — without the `<>` the row being inserted was its own authorizer, and any key
    could self-promote by signing its own key.

**Writer docs only, no behavior change** (`packages/cadre-core/src/strand-membership-writer.ts`):
`removeManager`'s "KNOWN SCHEMA HAZARD" paragraph replaced with the new floor + the
add-then-resign hand-off order; `addManager` gained the self-promotion note;
`insertFounderManagerIfAbsent` now states that Header → Member → Manager ordering is
load-bearing (the bootstrap branch requires the founding `Member` row to exist).

**Docs**: new `## Who May Administer a Closed Strand` section in `docs/strands.md`, stating
the invariants in plain terms plus the two known gaps and their ticket slugs.

## Behavior now

| Operation | Outcome | Rejecting constraint (observed) |
|---|---|---|
| Founder bootstrap (Header → Member → Manager) | allowed | — |
| Existing manager promotes another key | allowed | — |
| Any key promotes **itself** | rejected | `Authorized` |
| Manager removes a different manager, ≥ 1 remains | allowed | — |
| Manager resigns itself, ≥ 1 other remains | allowed | — |
| Sole manager resigns | rejected | `MinOneManager` |
| Stranger removes the last manager | rejected | `MinOneManager` (also violates `Authorized`) |
| Stranger removes the second-to-last manager | rejected | `Authorized` |
| Any `update` on `Manager` | rejected | `NoUpdate` |
| Same-txn delete-sole + insert-successor | rejected | `Authorized` |

The rejecting-constraint column is measured, not inferred: a throwaway spec printed the
actual error for each path before the assertions were written, so the tests pin the
intended invariant rather than "something threw". Same throwaway spec confirmed that an
`update` on `Strand.MemberPeer` (a table with no `NoUpdate`) IS accepted — so the `Manager`
update rejection is genuinely the constraint, not "updates are unsupported here" and not a
parse error.

## Tests added

Six, in `packages/cadre-core/test/strand-membership-peer-rotation.spec.ts` (reusing
`openStrand` / `freshKeyPair` / `addExtraManagers` / `tableCount`). Each asserts BOTH the
rejection (with a regex pinning the constraint name where deterministic) and that the row
set is unchanged:

- `addManager`: an attacker promoting **itself** rejects (`/Authorized/`); count stays 1.
- `removeManager`: the sole founder resigning rejects (`/MinOneManager/` — `Authorized`
  passes on that path, so the floor is the only possible rejector); the founder row remains.
- `removeManager`: a stranger removing the last manager rejects; count stays 1.
- `removeManager`: with 2 managers, a stranger-signed removal rejects (`/Authorized/`,
  count stays 2) and the same removal signed by the other manager succeeds (count 1) — the
  no-bootstrap-bypass pin.
- Raw `update Strand.Manager set MemberKey = <attacker>` carrying a genuine founder
  self-resignation signature rejects (`/NoUpdate/`); the founder row is unchanged and no
  attacker row exists.
- Same-transaction swap (delete the validly self-signed sole manager + insert an unsigned
  successor, on a strand that already has 2 members) rejects at commit (`/Authorized/`);
  count stays 1 and still holds the founder.

## Validation run

All from a clean tree, streamed:

- `packages/quereus-plugin-sereus`: `yarn build` → OK; `yarn vitest run
  test/strand-schema-drift.spec.ts` → **15 passed** (the two schema copies are
  byte-equivalent).
- `packages/cadre-core`: the four strand specs → **62 passed** (was 56; +6 new).
- `packages/cadre-core`: full `yarn test` → **54 files, 761 passed, 1 skipped**.
- `packages/quereus-plugin-sereus`: full `yarn test` → 6 files passed, 1 failed —
  `test/e2e/networked.e2e.spec.ts` (4 tests). That file is already listed in
  `tickets/.pre-existing-known.md` as blocked on `control-db-convergence-optimystic-p2p`;
  it fails in libp2p transaction validation (`membership-not-admitted:low-confidence-downsize`)
  during table creation, before any `Strand.Manager` write. Not re-reported, not touched.
  The non-networked `test/e2e/strand-schema.e2e.spec.ts` — which seats founding
  Member+Manager rows — passes.
- Root `yarn lint` → clean. `typecheck` in both packages → clean.

Rebuild `quereus-plugin-sereus` before any cadre-core run: cadre-core's tests import the
plugin's built `dist`, so an unbuilt schema edit silently tests the OLD schema.

## Things the reviewer should look at

- **The schema block is not a literal byte-for-byte paste of the ticket's block into the
  TS file.** The comment `-- or authorized by ANOTHER existing manager. The \`<>\` is
  load-bearing:` contains backticks, which terminate the `STRAND_SCHEMA` template literal.
  The TS copy escapes them (`` \` ``), which produces an identical runtime string — the
  drift spec compares the *values* and passes. Worth eyeballing that the escape is the
  only delta.
- **Manager-seeding order.** Every site that seats a `Manager` row was checked: the writer
  (`bootstrapFounderMembership`, Header→Member→Manager), `test/e2e/strand-schema.e2e.spec.ts`
  (two sites, both insert `Member 'm1'` before `Manager 'm1'`), and the open-strand
  rejection cases. No Manager-first path exists. A future one would now be rejected — the
  failure mode is a bootstrap that dies at commit, which is loud, not silent.
- **`stranger removes the last manager` is over-determined.** Both `MinOneManager` and
  `Authorized` reject it; which one reports first is engine evaluation order, so that test
  pins only `/CHECK constraint failed/`. Deliberate — pinning a name there would be brittle.

## Known gaps (not covered here)

- **Two-node replay is NOT exercised.** The ticket asked to confirm a joining node
  replaying membership rows is not rejected by the new constraints. The only real
  coverage is `packages/integration-tests/.../strand-membership-closed-strand-e2e.integration.ts`
  and `packages/quereus-plugin-sereus/test/e2e/networked.e2e.spec.ts`, both already blocked
  on `control-db-convergence-optimystic-p2p`. Nothing in-process replays membership rows
  through the SQL DML path on a second node, so there was nothing coverable to add. The
  expectation is that replication ships block-level transactions rather than re-running
  SQL DML, so CHECK constraints do not re-evaluate on the receiving node — **this is
  reasoning, not a measurement.** If a reviewer can cheaply construct an in-process
  two-database replay, that is the highest-value follow-up here. The specific risk if the
  expectation is wrong: a strand that legitimately has several managers, or a manager
  removal replicated from the authorizing node, could be rejected on the receiver — the
  bootstrap branch's `count(Member) <= 1` gate is the most likely tripwire, since a
  receiving node sees the full member set.
- **Cross-node concurrent removal can still empty the table.** `MinOneManager` counts rows
  visible to one transaction. Parked as a `NOTE:` comment inside the constraint in
  `schemas/strand.qsql` / `strand-schema.ts` (and mirrored in `removeManager`'s doc and the
  new `docs/strands.md` section) rather than filed as a ticket — it only becomes work if
  partitioned rotation becomes a real workflow.
- **Add/remove signature reuse.** A manager's signature over `digest(X)` authorizes both
  adding X and removing X (same payload, no nonce), so a captured add-authorization
  replays as a removal. Untouched; tracked as `bug-strand-manager-authority-antireplay`.
- **Non-member managers remain allowed** by design — only the *founding* manager must also
  be a `Member`. `addExtraManagers` in the specs depends on this. Tracked as
  `debt-strand-manager-must-be-member`.
- **The same self-authorization shape exists in the control schema** and is not touched
  here; it is `fix/bug-control-ownerkey-self-authorization`.
