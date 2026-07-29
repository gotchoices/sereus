----
description: Removing members from a private group used to require no permission at all — anyone could evict anyone, or everyone. Removal is now signature-gated and a removed person cannot re-admit themselves; review the new constraints, writers, and tests.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-member-revocation.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, docs/strands.md
difficulty: hard
----

# Review: authorize `Strand.Member` removal

## What was broken

`Strand.Member` is a closed strand's read gate (`StrandMemberRegistry.isMember`). A bare
Quereus `check (...)` defaults to insert|update, so `Member` DELETEs passed through ZERO
constraints. Reproduced against a real closed strand:

- `delete from Strand.Member where Key = ?` with null context — anyone evicts anyone.
- Bare `delete from Strand.Member` — total lockout, including the founder.
- An evicted invite-member re-inserted itself using its stale `ConsumedInvite` row.
- A member delete could orphan that key's `Manager` row.

## The fix (all landed; design rationale lives as comments on the `Member` table in `schemas/strand.qsql` — read that first)

**Schema** (both copies — `schemas/strand.qsql` and the embedded copy in
`packages/quereus-plugin-sereus/src/strand-schema.ts` — verified in sync):

- `Member.Authorized` now `check on insert, delete`, following `control.qsql`
  `OwnerKey`'s shape: `committed.*` pre-transaction authorizer reads and
  domain/action-tagged signed digests — `digest('Strand.Member', 'add'|'remove', key)` —
  so an admission approval can't replay as an eviction or vice versa.
- Delete branches: a `committed.Manager` row may sign a remove-tagged digest over
  `old.Key` (manager revocation), or the departing key itself signs the same tagged
  digest (self-departure via `context.MemberSignature`).
- Founder bootstrap branch gated to inserts on an empty `committed.Member` set.
- Invite branch gained a freshness clause: only a same-transaction fresh
  `ConsumedInvite` admits — a stale row from an earlier join can't re-admit an evictee.
- `Member.MinOneMember` (`check on delete`): member count can't reach zero.
- `Member.NotAManager` (`check on delete`): can't un-member a key still holding a
  `Manager` row; reads the post-image, so resign+revoke in ONE transaction passes.

**Writers** (`packages/cadre-core/src/strand-membership-writer.ts`, exported via `index.ts`):

- `signStrandMemberAction(action, memberKey, priv)` — tagged-digest signer.
- `revokeMember(db, { managerKeyPair, memberKey })` — manager-signed targeted delete.
- `leaveStrand(db, { memberKeyPair })` — self-signed departure.
- `addMemberByManager` re-signed to the tagged 'add' digest (was an untagged bare key).
- Founder/invite Member inserts now bind `MemberSignature = null` explicitly.

**Docs**: `docs/strands.md` → "Who May Administer a Closed Strand" gained a
"Removing Members" subsection (rules, forward-looking-only revocation residual, member
private key retention); known-gaps bullets extended to cover the member floor's
cross-node caveat and member-removal replayability.

## Validation performed

- `yarn build`, `yarn lint` from root: clean.
- cadre-core vitest: 60 files, 905 passed / 1 skipped — includes UNMODIFIED
  `strand-founder-bootstrap.spec.ts`, `strand-membership-invite.spec.ts`, and
  `strand-membership-peer-rotation.spec.ts` (the last calls `addMemberByManager`, so it
  pins that the schema's add branch and the re-signed writer agree).
- quereus-plugin-sereus e2e: 7 files, 66 passed / 1 todo. Its six raw `Strand.Member`
  inserts now bind `MemberSignature = null`.
- NEW `packages/cadre-core/test/strand-member-revocation.spec.ts`: 14/14 pass, covering
  unsigned + stranger-signed removal, mass delete, wipe-then-seat rollback, targeted
  `revokeMember`, `leaveStrand` + C-signs-B rejection, add↔remove tag replay both
  directions, stale-`ConsumedInvite` re-insert rejection then manager re-admit,
  fresh-invite re-admit, sole-member floor (raw strand, no manager seated — isolates
  MinOneMember from NotAManager), NotAManager sequential + same-transaction
  resign+revoke, and same-transaction-manager `committed.*` pin.

## Reviewer notes — treat tests as a floor, not a finish line

- **The new spec was written in one run and first executed in the next** — it passed
  first try, so its constraint-name pins (`/Authorized/`, `/CHECK constraint failed/`)
  are correct but untested against near-miss variants. Probe for uncovered branch
  combinations.
- **`MemberPeer` rows of a revoked member survive**, and self-signed `MemberPeer`
  deletes succeed contrary to stale doc comments in `strand-membership-writer.ts`
  (`registerMemberPeer`'s "Out of scope" note). Deliberately NOT fixed here — owned by
  `strand-memberpeer-revocation-cleanup` (in implement/). Don't file it again.
- **`Manager` table untouched** — its own live-count bootstrap branch left as is.
- **`strand-member-registry.ts` needed no changes** (reads only; writes go through
  `consumeInvite`/`addMemberByManager`).
- **No nonce/timestamp added on purpose**: removal approvals remain replayable (a
  captured "remove X" can re-evict a re-admitted X). Owned by
  `bug-strand-manager-authority-antireplay` (fix/, seq 3.5), which depends on `Member`
  staying in this tagged-digest form.
- **Cross-node floor caveat**: `MinOneMember`, like `MinOneManager`, counts rows one
  node can see; concurrent removals on different nodes can still converge to zero.
  Documented in schema + docs; not attempted here.
- **Revocation is forward-looking**: a revoked member keeps replicated data and the
  strand member private key; a real read cut-off means re-forming the strand (see
  docs/strands.md "Closed-Strand Member Key Handling").
