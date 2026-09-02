description: Review the new "seal" mechanism that lets the last manager of a private strand deliberately step down, permanently freezing who belongs to it.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts
----

# Review: sealing a strand (schema gates + writer API)

Implements the mechanism from the design in the original implement ticket (now this
file's history): a closed strand's admission authority is its `Strand.Manager` table,
and "sealed" = a closed strand with zero `Manager` rows — derived state, no stored
flag. The wide adversarial test matrix and docs are the follow-on
`strand-seal-tests-and-docs` (currently in implement/).

## What landed

**Schema** (both copies — `schemas/strand.qsql` and `STRAND_SCHEMA` in
`packages/quereus-plugin-sereus/src/strand-schema.ts`; the drift guard
`strand-schema-drift.spec.ts` passes, so they are byte-equivalent):

- `Manager.MinOneManager` deleted. Table comment rewritten: no min-one floor by
  design; a manager-less closed strand is frozen (sealed), not bricked, and that
  freeze is a privacy guarantee. Includes the seal-propagation `NOTE:` (cross-node
  convergence caveat — ex-manager's own key can still admit on a node that hasn't
  seen the delete yet).
- `Manager.Authorized` self-removal branch split by POST-image count: `'resign'` tag
  valid only when `count(Manager) >= 1` after the delete; new `'seal'` tag valid only
  when count `= 0`. Both self-signed, stamp-bound (single-use). Deferred subqueries,
  so counts are post-image.
- `Manager.Authorized` bootstrap branch gained
  `and not exists (select 1 from Revocation R where R.TableName = 'Manager')` —
  founding closes forever once any manager stamp is retired, so a sealed strand can
  never be re-founded by a lone survivor. Comment documents the accepted
  self-harm-only junk-tombstone window during founding.
- `ConsumedInvite.NotSealed` — `exists (select 1 from Manager)`, deferred/post-image:
  invitations issued before the seal can never consume after (or in the same
  transaction as) the seal; blocking the insert blocks the whole join, no orphan
  `Member` row.
- All `MinOneManager` comment cross-references swept (repo grep clean outside
  tickets/docs history; docs are the follow-on ticket's job).

**Writer** (`packages/cadre-core/src/strand-membership-writer.ts`):

- `sealStrand(db, { managerKeyPair })` — new export. Already-sealed → quiet no-op
  (restart-safe); >1 manager → throws naming `removeManager`; caller not the sole
  manager → throws. Signs `['Strand.Manager','seal',key,stampId]`, one transaction:
  delete + `Revocation` tombstone. JSDoc states TS guards are UX, not the trust
  boundary.
- `isStrandSealed(db)` — new export: `closed && count(Manager) === 0`. The
  `Header.Type` read is load-bearing (open strands never hold `Manager` rows, so a
  bare count would call every open strand sealed). Private `strandIsClosed` helper
  uses the module's scan idiom.
- `removeManager` — sole-manager self-resign now refused up front with an error
  naming `sealStrand`; JSDoc rewritten (hand-off order, cross-node caveat, @throws).
- `insertFounderManagerIfAbsent` (inside `bootstrapFounderMembership`) — **goes
  slightly beyond the ticket text**: added a `strandHasManagerRevocation(db)` skip so
  a founder RESTART of an already-sealed strand quietly skips the founding `Manager`
  insert instead of failing loudly against the new bootstrap gate. Rationale in its
  JSDoc; a crash between founding Member/Manager inserts leaves no Revocation rows,
  so genuine founding restarts still complete. Reviewer should sanity-check this
  reasoning.
- `revokeMember` JSDoc `MinOneManager` reference fixed.

**Exports** (`packages/cadre-core/src/index.ts`): `sealStrand`, `isStrandSealed`,
`type SealStrandParams`; block comment mentions sealing.

**Tests flipped** (the two `/MinOneManager/` pins):

- `strand-membership-manager-rotation.spec.ts` — "rejects the SOLE manager resigning
  (sealing is the only path to zero managers)": asserts the TS guard
  (`/sealStrand/`), a raw resign-tagged sole-manager delete (with tombstone) rejects
  `/Authorized/`, then `sealStrand` succeeds leaving `count(Manager)=0` with the
  `Member` row intact. Section comment + incidental mentions (`:501`, `:520`,
  `:601`) reworded.
- `strand-membership-network-transactor-parity.spec.ts` — "accepts the sole manager
  sealing, then rejects re-admission (Manager.Authorized, deferred)": seal accepted
  on the network transactor, then `addManager` by the ex-manager's own key rejected
  `/Authorized/`. Header + comments updated.

## Validation run

- `yarn lint` — clean.
- `yarn workspace @serfab/quereus-plugin-sereus test` — 99 passed, 1 todo (includes
  the schema drift guard).
- `yarn workspace @serfab/cadre-core test` — 105 files, 1683 passed, 1 skipped.
  (Required `yarn workspace @serfab/quereus-plugin-sereus build` first — the
  stale-build guard catches src edits.)

## Known gaps (reviewer: these are the floor, not the ceiling)

Most of the design's edge-case matrix is deliberately deferred to
`strand-seal-tests-and-docs` and has NO direct test yet:

- `ConsumedInvite.NotSealed` — no test consumes a pre-seal invitation after sealing,
  and none tries seal+consume in one transaction.
- `isStrandSealed` — no unit test at all (notably: open strand must report `false`;
  sealed closed strand `true`).
- `sealStrand` TS guards — no test for the >1-manager throw, the not-the-manager
  throw, or the already-sealed quiet no-op.
- Founder-restart-of-sealed-strand skip (`strandHasManagerRevocation`) — untested.
- Two-manager joint seal in one raw transaction (schema-accepted by design),
  seal+leave in one transaction, non-sole manager signing `'seal'` (must reject) —
  untested.
- Re-founding rejection is only covered via the parity test's `addManager` attempt;
  the raw generation-0 insert with null context after member dwindle is untested.
- Docs (`docs/architecture.md` `MinOneManager` mentions at ~:634/:670) untouched —
  explicitly the follow-on ticket's scope.

No pre-existing failures encountered.
