----
description: Anyone at all can remove members from a private group — including removing everyone, which locks the group's own owner out. Removal needs to require permission, and a removed person must not be able to walk back in.
files: schemas/strand.qsql (Member table — DONE), packages/quereus-plugin-sereus/src/strand-schema.ts (mirror — DONE), packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts (scaffolding to copy), docs/strands.md
difficulty: hard
----

# Authorize `Strand.Member` removal — schema LANDED, finish writers/tests/docs

<!-- resume-note -->
## Resume note (FOURTH run hit soft budget — schema landed in working tree; rest remains)

Run 4 landed the full new `Member` table in BOTH schema copies
(`schemas/strand.qsql` and the `STRAND_SCHEMA` constant in
`packages/quereus-plugin-sereus/src/strand-schema.ts`), byte-identical (verified by
diffing the extracted bodies). Runs 1-3 were discovery; every design decision was
resolved there and run 4 followed them exactly:

- Bootstrap branch: `old.Key is null and (select count(1) from committed.Member) = 0`.
- Manager add/remove branches: tagged digests `digest('Strand.Member', 'add'|'remove', key)`
  verified against `committed.Manager` rows matching `context.ManagerKey`.
- Invite branch keyed on FRESH InviteKey: `ConsumedInvite CI where CI.MemberKey = new.Key
  and not exists (select 1 from committed.ConsumedInvite CC where CC.InviteKey = CI.InviteKey)`
  — a revoked member's stale committed row no longer re-admits; a fresh invite still does.
- Self-departure branch: `new.Key is null and verify(digest('Strand.Member', 'remove',
  old.Key), context.MemberSignature, old.Key, 'ed25519')` — new `MemberSignature` context
  field, no `context.MemberKey`.
- New floors `MinOneMember` (cross-node NOTE carried over from `MinOneManager`) and
  `NotAManager` (deferred post-image — one txn deleting Manager+Member rows passes).
- `OnlyClosed` widened to `check on insert, update, delete`; `NoUpdate` kept; the
  `-- TODO: handle member revocation constraint` comment deleted.
- Context list is now `(ManagerKey text null, ManagerSignature text null, MemberSignature text null)`.
- Gotcha already fixed once: comments inside `STRAND_SCHEMA` must not contain backticks —
  they terminate the template literal. Keep both copies byte-identical.
- The `committed.*` idiom was spike-proven under the local transactor in run 2 (bootstrap
  insert vs empty committed set accepted; second unsigned insert rejected with the
  constraint name in the error; same-txn wipe-then-seat rejected and rolled back).

**WORKING TREE IS INTERMEDIATE — writer edits must come FIRST.** The schema now declares
`MemberSignature`, but no writer or spec binds it yet, and `addMemberByManager` still signs
the OLD untagged bare-key payload — member admission is broken until section A below
lands. Every existing `Strand.Member` write site binds the full context list by
convention; do not rely on partial binding.

## Remaining work (all decisions final — write code, no investigation)

### A. `packages/cadre-core/src/strand-membership-writer.ts`

- Add beside `signStrandPayload` (same raw-digest-bytes signing path):

  ```ts
  export type StrandMemberAction = 'add' | 'remove';
  export function signStrandMemberAction(action: StrandMemberAction, memberKey: string, privateKeyB64: string): string {
    const hashBytes = digest(['Strand.Member', action, memberKey], 'sha256', 'bytes') as Uint8Array;
    return sign(hashBytes, privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string;
  }
  ```

  JSDoc: the variadic digest matches the SQL side's `digest('Strand.Member', <action>,
  <key>)` literal tags; TS↔SQL parity is generically pinned by
  `test/digest-variadic-parity.spec.ts` case (d).
- `insertFounderMemberIfAbsent` (~line 146): add `MemberSignature = null` to the context
  list; fix its doc comment — it cites the old `count(1) from Member <= 1` branch, now the
  empty `committed.Member` bootstrap branch.
- `consumeInvite`'s Member insert (~line 396): add `MemberSignature = null`.
- `addMemberByManager` (~line 451): payload → `signStrandMemberAction('add', memberKey,
  managerKeyPair.privateKeyB64)`; add `MemberSignature = null`; update its doc (verifies
  the add-tagged digest against a `committed.Manager` row).
- Add `revokeMember(db, { managerKeyPair, memberKey })` (+ exported params interface):
  signature = `signStrandMemberAction('remove', memberKey, managerKeyPair.privateKeyB64)`;
  `delete from Strand.Member with context ManagerKey = ?, ManagerSignature = ?,
  MemberSignature = null where Key = ?`.
- Add `leaveStrand(db, { memberKeyPair })` (+ params interface): signature =
  `signStrandMemberAction('remove', memberKeyPair.publicKeyB64, memberKeyPair.privateKeyB64)`;
  `delete ... with context ManagerKey = null, ManagerSignature = null, MemberSignature = ?
  where Key = ?`.
- JSDoc both in the module's existing style (`removeManager` is the tone reference).

### B. `packages/cadre-core/src/index.ts` (export block ~lines 105-125)

Add `signStrandMemberAction`, `revokeMember`, `leaveStrand`, `type StrandMemberAction`,
`type RevokeMemberParams`, `type LeaveStrandParams`.

### C. `packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`

Add `MemberSignature = null` to the six raw `Strand.Member` inserts (~lines 134, 170, 196,
219, 257, 302). Refresh the two comments citing the old `count(Member) <= 1` branch
(~168, ~194) → bootstrap = empty pre-transaction (committed) member set. Assertions
survive unchanged: first-member inserts are auto-commit against an empty committed set;
the unauthorized second member (~219) still rejects; open-strand rejections are OnlyClosed.

### D. New spec `packages/cadre-core/test/strand-member-revocation.spec.ts`

Copy scaffolding (`openStrand`, `freshKeyPair`, `tableCount`, `inTransaction`,
`makeSAppConfig`) from `strand-membership-peer-rotation.spec.ts`. Pin constraint names
with `rejects.toThrow(/Name/)` ONLY where exactly one constraint can fire. Tests:

- Unsigned removal (all-null context) of a non-manager member rejected /Authorized/;
  stranger-signed removal (stranger binds itself as ManagerKey) rejected /Authorized/.
- Mass `delete from Strand.Member` (null context) rejected — several constraints can
  fire, pin /CHECK constraint failed/; counts unchanged after.
- Same-transaction wipe-then-seat (delete members + insert attacker in one txn) rejected;
  pre-existing rows survive the rollback.
- `revokeMember` by a manager accepted; removes ONLY the targeted row.
- `leaveStrand` accepted; member C signing removal of member B via MemberSignature
  rejected /Authorized/ (verify pins the signer to old.Key).
- Replay: add-tag signature presented on a delete rejected /Authorized/; remove-tag
  signature presented on an insert rejected /Authorized/ (mirrors the Manager replay test).
- Invite-join → `revokeMember` → self re-insert (null context) rejected /Authorized/
  (stale committed ConsumedInvite no longer qualifies) → `addMemberByManager` re-admits OK.
- Invite-join → revoke → FRESH invite (new invite key, same member key) re-admits OK
  (proves the freshness clause did not break legitimate joins; ConsumedInvite's PK is
  InviteKey so the second consume inserts a new row).
- MinOneMember isolation: raw `insertHeader('c')` (helper like the e2e spec's — do NOT use
  `bootstrapFounderMembership`, it always seats a Manager and any manager makes NotAManager
  fire too) + bootstrap-insert one real-keypair member + NO manager; valid self-departure
  of that sole member rejected /MinOneMember/.
- NotAManager: promote member M via `addManager`; `revokeMember(founder → M)` rejected
  /NotAManager/ (Authorized + MinOneMember both pass, so the pin is clean); succeeds after
  a `removeManager` self-resignation; ALSO the one-txn variant (removeManager +
  revokeMember inside one `inTransaction`) passes — deferred post-image.
- committed.* pin: one txn = `addManager(founder → M2)` + M2-signed `revokeMember(M3)`
  rejected /Authorized/ (M2's Manager row is not committed); whole txn rolls back — M2 not
  a manager, M3 still a member.

### E. Validation

`yarn build`, `yarn lint`, the cadre-core vitest suite AND the quereus-plugin-sereus e2e
suite — stream with `2>&1 | tee /tmp/<name>.log` (10-min idle killer). Existing specs
`strand-founder-bootstrap.spec.ts` and `strand-membership-invite.spec.ts` must pass
UNMODIFIED — they prove founder bootstrap and invite consumption survive the new branches.

### F. `docs/strands.md`

"Who May Administer a Closed Strand" (~line 142): add a member-revocation subsection —
any manager may remove a member via the remove-tagged signature, a member may leave by
self-signature; a removed member cannot re-admit itself (its consumed invite is spent;
re-admission requires a fresh manager action — `addMemberByManager` or a fresh invite);
a manager must resign before losing membership (NotAManager); the strand never drops to
zero members (MinOneMember, local-count caveat). Residual: a revoked member keeps whatever
strand data it already replicated — revocation is forward-looking; rotating the read gate
still means re-forming the strand (cross-ref "Closed-Strand Member Key Handling", ~line 95).
Update the known-gaps list (~lines 182-193) — member revocation is no longer a gap.

### G. Handoff

Distilled summary → tickets/review/ (this ticket deleted). Flag for the reviewer:
- MemberPeer rows of a revoked member survive; self-signed MemberPeer deletes succeed
  contrary to stale doc comments — out of scope here, owned by
  `strand-memberpeer-revocation-cleanup` (do not fix in this ticket).
- Manager table untouched (its own live-count bootstrap branch left as is).
- `strand-member-registry.ts` needs no changes (writes via consumeInvite/addMemberByManager).
- `bug-strand-manager-authority-antireplay` (seq 3.5) depends on this ticket leaving
  `Member` in the tagged-digest form; no nonce/stamp was added here on purpose.
<!-- /resume-note -->

## Background (from the fix stage — condensed)

Reproduced against a real closed strand: (1) `delete from Strand.Member where Key = ?`
with null context accepted — anyone evicts anyone; (2) bare `delete from Strand.Member`
accepted — total denial of service (Member is the read gate via
`StrandMemberRegistry.isMember`); (3) an evicted invite-member re-inserts itself using its
stale `ConsumedInvite` row — any delete gate is pointless without fixing this too;
(4) `MemberPeer` deletes also unguarded (separate ticket); (5) deleting a member leaves
its `Manager` row orphaned.

Root cause: a Quereus bare `check (...)` defaults to insert|update — `Member` DELETEs
passed through ZERO constraints. The fix (now landed in the schema) adopts
`control.qsql` `OwnerKey`'s shape: `committed.*` pre-transaction authorizer reads,
domain/action-tagged signed digests, floors, and a freshness clause on the invite branch.
Design rationale now lives as comments on the `Member` table itself — read
`schemas/strand.qsql` first.

## End
Work ticket as described above.
Do NOT commit — runner handles commits after you complete.
