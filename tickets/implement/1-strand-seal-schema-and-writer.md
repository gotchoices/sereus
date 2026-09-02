<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-09-02T06:50:09.587Z (agent: claude)
  Log file: C:\projects\sereus\tickets\.logs\1-strand-seal-schema-and-writer.implement.2026-09-02T06-50-09-585Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: Let the last manager of a private strand deliberately step down, permanently freezing who belongs to it, so the remaining members can be sure nobody new will ever be let in.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts
difficulty: hard
----

# Sealing a strand: the schema gates + the writer API

This ticket lands the **mechanism** and keeps the suite green. The wide adversarial
test matrix and the docs are the follow-on ticket `strand-seal-tests-and-docs`.

## What "sealed" means

A closed strand's `Strand.Manager` table is its entire admission authority: issuing an
invitation, adding a member directly, and promoting another manager all require the
writer to prove it already holds a `Manager` row. Today `Manager.MinOneManager`
(`check on delete (count(Manager) >= 1)`) refuses any delete that would empty that
table, on the reasoning that an admin-less strand could never admit anyone again.

That property is the feature. A strand whose membership can never grow is a **privacy
guarantee** to everyone who already contributed to it: nobody holds the power to admit
a party who would then read the strand's whole history. A manager-less strand is not
bricked — it is **sealed**.

Sealed is derived state, not a stored flag: `Header` is insert-only, and "no `Manager`
rows in a closed strand" already says it exactly.

## Design

### 1. Sealing is its own signed act

Drop `MinOneManager`, but do **not** simply let the existing `resign` branch fall to
zero. Sealing is irreversible (§2), so the sole manager must expressly sign *for it*,
and a raw writer must not be able to seal by presenting an ordinary resignation
approval. Split the self-removal branch of `Manager.Authorized` by post-image count:

| Approval | Valid when |
| --- | --- |
| `'Strand.Manager','resign',old.MemberKey,old.StampId` | `(select count(1) from Manager) >= 1` after the delete |
| `'Strand.Manager','seal',old.MemberKey,old.StampId` | `(select count(1) from Manager) = 0` after the delete |

Both are signed by `old.MemberKey` (the departing manager) and bound to the row's
`StampId`, exactly like every other approval — so a captured `seal` is single-use.
Both counts are subqueries, so the whole `Authorized` check defers to commit and the
counts are POST-image — the same mechanism `MinOneManager` and the bootstrap branch
already rely on.

The admin-removal branch (`remove`, signed by a *different* manager) needs no change
and cannot reach zero: it requires `exists (select 1 from Manager A where A.MemberKey
= context.ManagerKey ...)` against the **live** (post-image) table, so at least the
authorizer's own row must survive. Two managers mutually removing each other in one
transaction fails for that reason, not because of the old floor.

### 2. A sealed strand can never be re-founded

`Manager.Authorized`'s bootstrap branch (`Generation = 0`, `count(Manager) <= 1`,
`count(Member) <= 1`, member exists) is unreachable after founding today only *because*
`MinOneManager` keeps the count above zero. Once zero is reachable, a sealed strand
whose members dwindle to one would let that survivor re-seat itself as a generation-0
founder and start admitting — exposing every departed member's contributions to new
parties. Close it by adding to the bootstrap branch:

```sql
and not exists (select 1 from Revocation R where R.TableName = 'Manager')
```

Read it as: *the founding branch is open only while no manager seat has ever been
retired.* Founding happens exactly once per strand, and `bootstrapFounderMembership`
runs `Header` then `Member` then `Manager` on a strand with no `Revocation` rows at all.

Accepted, deliberate: `Revocation.Authorized` lets **any** committed member file a
tombstone, and `RowIsGone` permits a junk stamp naming no real row — so between the
founding `Member` insert and the founding `Manager` insert the founder could, with its
own key, file `Revocation('Manager', <junk>)` and permanently block its own founding.
That needs the founder's private key and is pure self-harm; no other party can reach
that window (there are no other committed members yet).

### 3. A sealed strand admits nobody — including via invitations already issued

Every admission path except one already requires a live `Manager` row
(`Invite.InviteValid`, `Member.Authorized`'s manager-add branch, `Manager.Authorized`'s
promotion branch). The exception is an **unspent, unexpired, uncancelled invitation
issued before the seal**: it would still consume. `cancelInvite` itself needs a
manager, so after sealing nobody could kill it. Add to `ConsumedInvite`, beside
`NotCancelled`:

```sql
constraint NotSealed check on insert (
    exists (select 1 from Manager)
)
```

Live `Manager`, deferred (subquery) so it is the post-image: at commit at least one
manager must still exist, so sealing and consuming in the *same* transaction is
rejected too. Blocking the `ConsumedInvite` insert blocks the whole join, for exactly
the reason `NotCancelled`'s own comment already states — so no orphan `Member` row
survives, and `sealStrand` needs no enumerate-and-cancel step that could race a
concurrent consume.

### 4. What a sealed strand can still do

- Members may **leave** (`leaveStrand`, self-signed) — still floored by `MinOneMember`,
  which is unchanged: the strand always keeps at least one member holding its data.
- Members may add/remove their **own** `MemberPeer` rows (self-signed) — same party,
  new device; not an admission.
- Members may file `Revocation` tombstones — required by the two above.
- Nobody may issue or cancel invitations, admit a member, promote a manager, revoke
  another member, or clear another member's peer binding. Each of those requires a
  `Manager` row that no longer exists.

## Schema edits

`schemas/strand.qsql` and the `STRAND_SCHEMA` template literal in
`packages/quereus-plugin-sereus/src/strand-schema.ts` MUST stay byte-equivalent (the
body inside `declare schema Strand { ... }`);
`packages/quereus-plugin-sereus/test/strand-schema-drift.spec.ts` enforces it. Make
every edit in both.

**(a) `ConsumedInvite`** — add `NotSealed` after `NotCancelled` (comma-separate), with a
comment stating: sealed strands admit nobody, including holders of invitations issued
before the seal; `cancelInvite` needs a manager so nobody could kill such an invitation
after sealing; the subquery reads the live `Manager` table and defers, so it is the
post-image; blocking this insert blocks the whole join for the reason `NotCancelled`
gives.

**(b) `Manager`** — delete the `MinOneManager` constraint and its comment block. Replace
with a comment block on the table stating: a closed strand loses its last manager only
by **sealing** — a distinct, self-signed act, never an ordinary resignation and never an
admin removal; there is deliberately no min-one-manager floor, because a sealed strand
is frozen rather than bricked and that freeze is the privacy guarantee its remaining
members are buying; sealing is irreversible because the founding branch closes for good
once any manager stamp has been retired. Then, in the house style of the existing
`MinOneMember` / `NotRevoked` notes, a `NOTE:` for the propagation gap listed under
*Edge cases* below.

**(c) `Manager.Authorized` bootstrap branch** — add the `not exists (... Revocation ...
TableName = 'Manager')` condition from §2, and extend that branch's existing comment
with the sentence explaining it (founding happens once; the branch closes forever once a
manager seat is retired) plus the junk-tombstone note from §2.

**(d) `Manager.Authorized` self branch** — add `and (select count(1) from Manager) >= 1`
to the existing `resign` branch, and add the new `seal` branch beneath it with
`and (select count(1) from Manager) = 0` and the `'seal'` action tag. Rewrite the branch
comment: the count is what distinguishes the two, the tag is what makes each a statement
of intent, and the stamp is still what makes each single-use.

**(e) Comment cross-references** — every `MinOneManager` mention in schema comments must
go. Known sites (line numbers are for `schemas/strand.qsql`; mirror in
`strand-schema.ts` at 139 / 385 / 486):

- `:131` `CancelledInvite` NOTE — `NotRevoked / MinOneMember / MinOneManager local-visibility notes`
- `:377` `Manager.MemberExists` NOTE — `MinOneMember / MinOneManager / NotRevoked notes`
- `:478` `Revocation` NOTE — `MinOneMember / MinOneManager local-count notes`

Swap each for the surviving names plus the new seal-propagation note.

## Writer edits (`packages/cadre-core/src/strand-membership-writer.ts`)

**`sealStrand(db, { managerKeyPair })`** — new export, modelled on `removeManager`:

- Read `strandTableCount(db, 'Manager')`.
  - `0` — already sealed; log and return quietly (restart-safe, matching
    `bootstrapFounderMembership` and `removeManager`'s absent-row no-op).
  - `> 1` — throw, naming `removeManager` as the operation the caller actually wants.
- `managerRow(db, managerKeyPair.publicKeyB64)` — absent while a manager exists — throw
  (the caller is not the manager).
- Sign `['Strand.Manager', 'seal', publicKeyB64, stampId]` with `signStrandApproval`.
- One `inStrandTransaction`: the `delete from Strand.Manager ... with context ManagerKey
  = ?, Signature = ?` plus `insertRevocation(db, 'Manager', stampId, managerKeyPair)`.

The TS count/identity checks are **UX guards, not the trust boundary** — the schema
rejects a mis-tagged or mis-counted approval regardless. Say so in the JSDoc.

**`isStrandSealed(db)`** — new export. Sealed means *a closed strand with no managers*.
An **open** strand has no `Manager` rows at all (`Manager.OnlyClosed`), so a bare
`count(Manager) = 0` would wrongly report every open strand as sealed. Add a private
`strandIsClosed(db)` that reads the singleton `Header.Type` with the same `db.eval` scan
idiom as `strandTableCount` / `managerRow`, and return `closed && count(Manager) === 0`.

**`removeManager`** — when the signer IS the target and `strandTableCount(db, 'Manager')`
is 1, throw naming `sealStrand`. Reading the count inside a caller-joined transaction is
correct: an add-then-resign hand-off composed in one transaction sees 2 and passes; the
already-rejected delete-then-add swap sees 1 and is refused here as well as by the
schema. Rewrite the `THE LAST MANAGER CANNOT BE REMOVED` JSDoc block (~:1385), the
cross-node `MinOneManager` caveat (~:1400), and the `@throws` line (~:1407) for sealing.

**`revokeMember`** JSDoc (~:818) references `MinOneManager`; fix.

**`packages/cadre-core/src/index.ts`** (~:180-220) — export `sealStrand`, `isStrandSealed`,
and `type SealStrandParams` alongside `removeManager`; update the block comment above the
export list to mention sealing.

## Keeping the existing suite green

Two tests pin `/MinOneManager/` and will fail the moment the constraint is gone. Flip
them here, minimally — the full matrix is the follow-on ticket.

- `packages/cadre-core/test/strand-membership-manager-rotation.spec.ts:480` "rejects the
  SOLE manager resigning (min-one-manager floor)" — retitle for sealing and assert:
  `removeManager` (self, sole) throws the new TS guard; a raw `resign`-tagged delete of
  the sole manager rejects `/Authorized/`; `sealStrand` then succeeds and leaves
  `count(Manager) === 0` with the `Member` row intact. Update the section comment above
  it (`:471-478`) and the incidental `MinOneManager` mentions at `:501`, `:520`, `:601`.
- `packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts:62`
  "rejects the sole manager resigning (Manager.MinOneManager…)" — replace with a seal
  case in the same single node boot: `sealStrand` on the sole manager is **accepted**
  (`count(Manager) === 0`), and a following `addManager` is rejected by the deferred
  `Manager.Authorized`. That keeps the file's stated purpose — one accepted flow plus one
  deferred-CHECK rejection, both proven above the transactor — and its `MinOneManager`
  mentions in the file header (`:12`) and at `:47` need updating too.

"rejects a stranger removing the last manager" (`:495`) stays **green unchanged**: a
stranger's `remove`-tagged delete matches no branch (the remove branch finds no live
authorizer in the empty post-image; both self branches need `old.MemberKey =
context.ManagerKey`). Only its comment mentioning `MinOneManager` needs a touch.

## Edge cases & interactions

- Sole manager signs `resign` — rejected (post-image count is 0, not >= 1). Sole manager
  signs `seal` — accepted; `Manager` empty, tombstone filed.
- A non-sole manager signs `seal` — rejected (count >= 1, not 0).
- Another manager signs `remove` on the second-to-last manager — still accepted; the
  count cannot reach zero through that branch.
- **Two managers each signing `seal` in ONE transaction** — accepted at the schema level
  (each row's post-image count is 0 and each is self-signed): a joint seal by mutual
  consent, which is fine. `sealStrand`'s TS count guard means the writer never produces
  it; only a raw composed transaction can.
- **Seal + leave in one transaction** (the sole manager wants out entirely):
  `Member.NotAManager` reads the post-image, so deleting `Manager` and `Member` together
  passes — provided `MinOneMember` holds (another member remains). A strand whose sole
  manager is also its sole member cannot do this: `MinOneMember` rejects.
- After sealing, every manager-gated writer is rejected by its own `Authorized` (there is
  no `Manager` row to verify against): `addManager`, `admitManager`, `addMemberByManager`,
  `issueInvite`, `cancelInvite`, `revokeMember`, and `removeMemberPeer`'s manager path.
- After sealing, `consumeInvite` on an invitation issued **before** the seal, still
  unexpired and uncancelled — rejected by `ConsumedInvite.NotSealed`; the whole join rolls
  back, leaving no orphan `Member` row.
- After sealing, members dwindle to one; the survivor raw-inserts `Manager` at
  `Generation = 0` with null context — rejected by the new `Revocation` gate on the
  bootstrap branch.
- Founding a fresh closed strand still works: `Header`, then `Member`, then `Manager`,
  with no `Revocation` rows in existence. Every existing bootstrap test must stay green.
- `isStrandSealed` on an **open** strand returns `false`, not `true`.
- **Cross-node (the same class as today's local-visibility notes; not solved here):** a
  node that has not yet converged on the seal still shows the manager row, so the
  ex-manager's *own* key could still admit there until the delete propagates. Only that
  one key — no stranger gains anything. State it in the schema comment; the docs half is
  the follow-on ticket.
- `MinOneMember`'s comment refers to the founding `Manager` being seatable only beside an
  existing `Member` — still true; leave it.

## Decisions taken (revisit here, not mid-implementation)

- **A distinct `seal` tag rather than letting a plain resignation fall to zero.** One
  extra branch buys a signed statement of intent and keeps a raw writer from sealing by
  accident. Cost: one more approval tag to carry in the architecture doc's table.
- **A permanent seal (no re-founding) rather than letting a lone survivor re-found.** The
  guarantee is owed to *every* member who contributed, including those who later left.
- **`NotSealed` on `ConsumedInvite` rather than making `sealStrand` cancel outstanding
  invitations first.** The schema gate holds regardless of which writer seals, and needs
  no enumeration step that could race a concurrent consume.
- **`isStrandSealed` reads `Header.Type` as well as the manager count.** Without it every
  open strand would report as sealed, since open strands never hold `Manager` rows.

## TODO

- Schema `schemas/strand.qsql`: add `ConsumedInvite.NotSealed`; drop
  `Manager.MinOneManager` and rewrite its comment for sealing; add the `Revocation` gate
  to the bootstrap branch; add the post-image count gate to the `resign` branch; add the
  `seal` branch; sweep every `MinOneManager` comment cross-reference.
- Mirror the identical body into `STRAND_SCHEMA` in
  `packages/quereus-plugin-sereus/src/strand-schema.ts`; confirm that package's
  `strand-schema-drift.spec.ts` passes.
- Writer: `strandIsClosed` helper, `isStrandSealed`, `SealStrandParams`, `sealStrand`;
  `removeManager` sole-manager guard + JSDoc rewrite; `revokeMember` JSDoc fix.
- `packages/cadre-core/src/index.ts`: export the two new functions plus the params type.
- Flip the two `/MinOneManager/` pins and sweep the incidental comment mentions in
  `strand-membership-manager-rotation.spec.ts` and
  `strand-membership-network-transactor-parity.spec.ts`.
- `yarn lint`, `yarn workspace @serfab/cadre-core test`,
  `yarn workspace @serfab/quereus-plugin-sereus test` — all green, run in the foreground
  with no redirection.
