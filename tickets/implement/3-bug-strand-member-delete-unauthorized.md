----
description: Anyone at all can remove members from a private group — including removing everyone, which locks the group's own owner out. Removal needs to require permission, and a removed person must not be able to walk back in.
files: schemas/strand.qsql (DONE), packages/quereus-plugin-sereus/src/strand-schema.ts (DONE), packages/cadre-core/src/strand-membership-writer.ts (DONE), packages/cadre-core/src/index.ts (DONE), packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts (DONE), packages/cadre-core/test/strand-member-revocation.spec.ts (WRITTEN, never executed), docs/strands.md (NOT DONE)
difficulty: hard
----

# Authorize `Strand.Member` removal — code + tests WRITTEN; validate, docs, handoff remain

<!-- resume-note -->
## Resume note (FIFTH run hit soft budget — all code/test edits landed; NOTHING validated yet)

Runs 1–3 were discovery, run 4 landed the schema (both copies, committed at `7b6beb1`),
run 5 (this one) landed ALL remaining code and test edits in the working tree. Every
design decision is final and already encoded in `schemas/strand.qsql`'s `Member` table
comments — do not re-investigate. What run 5 changed (all uncommitted, working tree):

- `packages/cadre-core/src/strand-membership-writer.ts`:
  - Added `StrandMemberAction` type + `signStrandMemberAction(action, memberKey, priv)`
    (variadic tagged digest `['Strand.Member', action, key]`, raw-bytes signing, same
    path as `signStrandPayload`).
  - `insertFounderMemberIfAbsent` + `consumeInvite`'s Member insert: context lists now
    include `MemberSignature = null`; founder doc comment now cites the empty
    `committed.Member` bootstrap branch.
  - `addMemberByManager`: now signs `signStrandMemberAction('add', …)` (was the old
    untagged bare-key payload) and binds `MemberSignature = null`; doc updated.
  - NEW `revokeMember(db, { managerKeyPair, memberKey })` + `RevokeMemberParams` and
    `leaveStrand(db, { memberKeyPair })` + `LeaveStrandParams`, both JSDoc'd in the
    module's style.
- `packages/cadre-core/src/index.ts`: exports `signStrandMemberAction`, `revokeMember`,
  `leaveStrand`, `type StrandMemberAction`, `type RevokeMemberParams`,
  `type LeaveStrandParams` added to the strand-membership-writer block.
- `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`: all six raw
  `Strand.Member` inserts now bind `MemberSignature = null` (verified by grep — the two
  Invite inserts were NOT touched); the three stale `count <= 1` comments refreshed to
  the committed-set bootstrap wording.
- NEW `packages/cadre-core/test/strand-member-revocation.spec.ts` (~12 tests): all the
  ticket's specified cases — unsigned/stranger-signed removal /Authorized/, mass delete
  /CHECK constraint failed/, wipe-then-seat rollback, `revokeMember` targeted removal,
  `leaveStrand` + C-signs-B rejection /Authorized/, add↔remove tag replay /Authorized/
  both directions, stale-ConsumedInvite re-insert /Authorized/ then `addMemberByManager`
  re-admit, fresh-invite re-admit, MinOneMember isolation (raw strand via
  `openRawStrand()` + `insertHeader` — NO manager seated), NotAManager sequential +
  one-txn variants, committed.* same-txn-manager pin. Scaffolding copied from
  `strand-membership-peer-rotation.spec.ts` (`openStrand`, `freshKeyPair`, `tableCount`,
  `inTransaction`, `makeSAppConfig`, `afterEach` shutdown loop — the afterEach WAS
  missing at first write and was added; confirm it's present before running).

**THE NEW SPEC HAS NEVER BEEN EXECUTED. No build, lint, or test run happened in run 5.**
Treat every constraint-name pin as unverified: if a `/Authorized/` pin fails because a
sibling constraint reports first, weaken only that pin to `/CHECK constraint failed/`
with a comment — never reorder schema constraints to satisfy a test.

## Remaining work

### E. Validation (do FIRST — nothing has been run)

- `yarn build`, `yarn lint` from repo root.
- cadre-core vitest suite AND quereus-plugin-sereus e2e suite — stream with
  `2>&1 | tee /tmp/<name>.log` (10-min idle killer; never silent-redirect).
- Existing specs `strand-founder-bootstrap.spec.ts` and
  `strand-membership-invite.spec.ts` must pass UNMODIFIED — they prove founder
  bootstrap and invite consumption survive the new branches.
- `strand-membership-peer-rotation.spec.ts` must also pass unmodified — it calls
  `addMemberByManager`, which now signs the tagged digest; a failure there means the
  schema's add branch and the writer disagree.
- Fix what fails; pre-existing unrelated failures go through
  `tickets/.pre-existing-known.md` / `.pre-existing-error.md` per workflow rules.

### F. `docs/strands.md`

"Who May Administer a Closed Strand" (~line 142): add a member-revocation subsection —
any manager may remove a member via the remove-tagged signature; a member may leave by
self-signature; a removed member cannot re-admit itself (its consumed invite is spent;
re-admission requires a fresh manager action — `addMemberByManager` or a fresh invite);
a manager must resign before losing membership (NotAManager); the strand never drops to
zero members (MinOneMember, same local-count caveat as the manager floor). Residual: a
revoked member keeps whatever strand data it already replicated — revocation is
forward-looking; rotating the read gate still means re-forming the strand (cross-ref
"Closed-Strand Member Key Handling", ~line 95). In the known-gaps list (~lines 182–193),
extend the concurrent-removals bullet to note the SAME cross-node caveat now applies to
the member floor (MinOneMember), and check no other bullet still implies member deletes
are unguarded.

### G. Handoff

Distilled summary → tickets/review/ (this ticket deleted). Flag for the reviewer:
- MemberPeer rows of a revoked member survive; self-signed MemberPeer deletes succeed
  contrary to stale doc comments — out of scope here, owned by
  `strand-memberpeer-revocation-cleanup` (do not fix in this ticket).
- Manager table untouched (its own live-count bootstrap branch left as is).
- `strand-member-registry.ts` needs no changes (writes via consumeInvite/addMemberByManager).
- `bug-strand-manager-authority-antireplay` (seq 3.5) depends on this ticket leaving
  `Member` in the tagged-digest form; no nonce/stamp was added here on purpose.
- New spec was written in run 5 and first executed in run 6 — reviewer should treat its
  pins as a floor, not proof of exhaustiveness.

## Background (from the fix stage — condensed)

Reproduced against a real closed strand: (1) `delete from Strand.Member where Key = ?`
with null context accepted — anyone evicts anyone; (2) bare `delete from Strand.Member`
accepted — total denial of service (Member is the read gate via
`StrandMemberRegistry.isMember`); (3) an evicted invite-member re-inserts itself using its
stale `ConsumedInvite` row; (4) `MemberPeer` deletes also unguarded (separate ticket);
(5) deleting a member leaves its `Manager` row orphaned (now blocked by NotAManager).

Root cause: a Quereus bare `check (...)` defaults to insert|update — `Member` DELETEs
passed through ZERO constraints. The fix adopts `control.qsql` `OwnerKey`'s shape:
`committed.*` pre-transaction authorizer reads, domain/action-tagged signed digests,
floors, and a freshness clause on the invite branch. Design rationale lives as comments
on the `Member` table itself — read `schemas/strand.qsql` first.
<!-- /resume-note -->

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
