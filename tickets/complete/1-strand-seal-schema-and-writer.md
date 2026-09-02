description: Added a way for the last manager of a private strand to deliberately step down, permanently freezing who belongs to it — schema rules plus the library calls that drive them.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts
----

# Sealing a strand — schema gates + writer API

A closed strand's admission authority is its `Strand.Manager` table: issuing or
cancelling an invitation, admitting a member, and promoting a manager all require a
`Manager` row. "Sealed" is therefore derived state, not a stored flag — a closed strand
whose `Manager` table its last manager deliberately emptied. Nobody can be admitted
again, which is the privacy guarantee the remaining members are buying: no key holds the
power to let in a party who would then read the strand's whole history.

## What landed

**Schema** (kept byte-equivalent across `schemas/strand.qsql` and `STRAND_SCHEMA` in
`packages/quereus-plugin-sereus/src/strand-schema.ts`; `strand-schema-drift.spec.ts`
proves it):

- `Manager.MinOneManager` removed. There is deliberately no min-one-manager floor — a
  manager-less closed strand is frozen, not bricked.
- `Manager.Authorized`'s self-removal path split by POST-image manager count: the
  existing `'resign'` tag is valid only when at least one manager survives; a new
  `'seal'` tag is valid only when none does. Both self-signed and stamp-bound, so a
  captured resignation can never seal and neither approval survives a re-seating.
- `Manager.Authorized`'s founding branch additionally requires that no `Manager` stamp
  has ever been retired into `Revocation`, so a sealed strand can never be re-founded by
  a lone survivor.
- `ConsumedInvite.NotSealed` (`exists (select 1 from Manager)`, deferred) kills any
  invitation issued before the seal — including one presented in the same transaction as
  the seal. Blocking the `ConsumedInvite` insert rolls back the `Member` insert riding
  with it, so no orphan member row.
- Cross-node caveat recorded on the `Manager` table: a seal must propagate before it
  binds a given node, so the ex-manager's own key could still admit on a node that has
  not seen the delete. Only that one key; no stranger gains anything.

**Writer** (`packages/cadre-core/src/strand-membership-writer.ts`, exported from
`index.ts`):

- `sealStrand(db, { managerKeyPair })` — signs the seal-tagged approval and lands the
  `Manager` delete plus its `Revocation` tombstone in one transaction. Quiet no-op if
  already sealed; throws if more than one manager exists, if the caller is not the sole
  manager, or if the strand is not founded yet. The TypeScript guards are UX; the schema
  is the trust boundary.
- `isStrandSealed(db)` — closed, zero `Manager` rows, and at least one retired `Manager`
  stamp.
- `removeManager` refuses a sole-manager self-resignation up front, naming `sealStrand`.
- `insertFounderManagerIfAbsent` skips the founding insert on a strand that has retired a
  manager seat, mirroring the schema's own gate so a founder restart of a sealed strand
  is quiet rather than a schema rejection.

Two existing tests that pinned `/MinOneManager/` were reworked to pin the new behaviour,
one on the local transactor and one on the network transactor.

The adversarial test matrix and the design-document updates are the follow-on ticket
`strand-seal-tests-and-docs` (in `implement/`), which this review extended.

## Review findings

### Checked

Read the implement diff (`8daf949^..8aab007`) in full before the handoff summary: both
schema copies, the writer, the package index, and the two reworked specs.

- **Schema, re-derived from scratch.** Enumerated every branch of `Manager.Authorized`
  and asked which can reach zero managers; traced `ConsumedInvite.NotSealed` against open
  strands and against the invite-join transaction; traced the new founding-branch
  `Revocation` gate against legitimate founding, founder restart, and re-founding; checked
  `Revocation.RowIsGone`'s junk-tombstone reach; checked `Member.MinOneMember`,
  `Member.NotAManager` and `MemberPeer`'s manager-remove branch in the post-seal state.
- **Writer.** Guard ordering and identity checks in `sealStrand`; the `removeManager`
  sole-manager refusal (including that it reads the count inside a caller-joined
  transaction, so an add-then-resign hand-off still passes); transaction and
  rollback shape (`inStrandTransaction` unchanged); delete/tombstone pairing; no `any`,
  no swallowed exceptions, no new resource ownership.
- **Docs and stale claims.** Grepped `MinOneManager`, `last manager`, `min-one-manager`
  and `last-manager` across `docs/`, `src/` and `test/`.
- **Site claims.** Grepped the open board for the touched paths before filing anything.
- **Validation.** `yarn lint` clean;
  `yarn workspace @serfab/quereus-plugin-sereus test` 99 passed / 1 todo (includes the
  schema drift guard, so the two schema copies are confirmed identical);
  `yarn workspace @serfab/cadre-core test` 105 files, 1683 passed / 1 skipped. All run
  after the fixes below. The skipped test and the todo are pre-existing and unrelated.

### Found and fixed in this pass (minor)

- **`isStrandSealed` reported `true` for a closed strand that was not founded yet.** The
  predicate was `closed && count(Manager) === 0`, but `bootstrapFounderMembership`
  commits `Header`, `Member` and `Manager` as three sequential statements — so between
  the first and the last, a perfectly ordinary strand being created satisfied it exactly.
  A replicating node that has `Header` but not yet the `Manager` rows reads the same way.
  Added the conjunct that actually makes a seal permanent: at least one retired `Manager`
  stamp in `Revocation` — the same condition the schema's founding branch uses. The
  implementer had already written the `strandHasManagerRevocation` helper for the
  bootstrap path; this reuses it. Latent rather than live (the export has no callers
  yet), which is why it was fixed here rather than filed.
- **`sealStrand` returned quietly claiming "already sealed" in that same state.** For an
  operation whose whole point is to permanently freeze admission, silently reporting
  success without freezing anything is the wrong failure mode. It now distinguishes the
  two: quiet no-op when a `Manager` stamp really has been retired (restart safety
  preserved), and an explicit throw naming "not founded yet" otherwise.
- JSDoc on both functions updated to state the three-conjunct definition and the new
  throw.

### Sanity-checked at the implementer's request — reasoning holds

The `strandHasManagerRevocation` skip added to `insertFounderManagerIfAbsent` (flagged in
the handoff as going slightly beyond the ticket text) is correct. Zero `Manager` rows
*and* a retired `Manager` stamp is exactly the state in which the schema's founding
branch is permanently closed, so mirroring that gate in the writer turns a guaranteed
schema rejection into a quiet skip rather than waiving anything. A crash between the
founding `Member` and `Manager` inserts leaves no `Revocation` rows at all, so a genuine
founding restart still completes — verified against the bootstrap ordering, which commits
each insert separately.

### Adversarial probes that found nothing

Recorded because "no finding" here is a result, not an omission:

- **Can a manager unilaterally seal a two-manager strand?** No. Removing the other
  manager in the same transaction needs the admin-remove branch, which looks for a live
  authorizer in the POST-image `Manager` table — empty after a seal, so the branch fails
  and the whole transaction rolls back.
- **Is `'seal'` really the only route to zero managers?** Yes. `'resign'` now requires a
  survivor, admin-remove structurally implies one, and the founding branch is
  insert-only.
- **Does `ConsumedInvite.NotSealed` break open strands,** which never hold `Manager`
  rows? Unreachable: `Invite.OnlyClosed` plus `ConsumedInvite.InviteExists` mean a
  `ConsumedInvite` row can only exist on a closed strand.
- **Can an ordinary member brick a live strand's founding branch** by filing a junk
  `Revocation('Manager', …)` tombstone? The founding branch also requires at most one
  member, so on any strand with a second member it was already unreachable — the schema
  comment's "self-harm only" claim stands, and the conjunct added above does not widen
  it.
- **Schema drift between the two copies.** None; the drift guard passes.

### Recorded as a tripwire, not filed

- `strandHasManagerRevocation` walks the whole append-only `Strand.Revocation` table when
  no `Manager` tombstone is present. Fine at strand scale, and it returns on the first
  match. `NOTE:` at the helper in `strand-membership-writer.ts` pointing at
  `debt-strand-tombstone-reap` and naming the alternative (a stored "founding closed"
  marker) if that table ever gets large.

### Appended to the follow-on ticket rather than filed separately

`strand-seal-tests-and-docs` (in `implement/`) already claims every gap the handoff
listed and both stale design documents, so new tickets would have been duplicates. Added
to it:

- `isStrandSealed` must be `false` on a closed-but-unfounded strand, with the reason the
  predicate is three conjuncts.
- `sealStrand` on an unfounded strand must throw, distinctly from the already-sealed
  no-op.
- A founder restart of a sealed strand must be a quiet no-op — the one behaviour in this
  diff with no test at all.
- `docs/strands.md:283` opens "A member-count floor mirrors the last-manager …", a
  comparison to a floor that no longer exists; the existing doc arm only covered the
  clause after it.
- The `docs/architecture.md` writer-list arm should state what "sealed" means, so no
  reader concludes an empty `Manager` table alone is the definition.

### Weighed and not filed

- **Duplication between `sealStrand` and `removeManager`.** Both end in the same
  delete-plus-tombstone pair, differing only in tag and signature. Extracting it would
  share two statements while the guard preambles stay different — churn without a
  readability win.
- **File size.** `packages/cadre-core/src/strand-membership-writer.ts` is 1,584 lines
  (`wc -l`), the package's second-largest behind `cadre-node.ts` at 4,770, which has its
  own ticket (`debt-cadre-node-single-file-size`). This one is a single cohesive family
  of signed-write functions and is majority JSDoc; no split warranted.

### Empty categories

- **Major findings: none.** The only defect was a two-conjunct predicate error in a
  new, not-yet-called export, fixed in place. Nothing surfaced at the invariant,
  representation, or layering level that would warrant climbing to a `debt-` ticket.
- **Blocked items: none.** No decision needed a human and no dependency sits outside
  this repo.
- **Pre-existing failures: none.** Both suites were green; no
  `tickets/.pre-existing-error.md` written.
