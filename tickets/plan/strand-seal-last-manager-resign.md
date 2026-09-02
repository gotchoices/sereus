description: Let the last manager of a closed strand resign, which permanently "seals" the strand so every current member can be certain nobody else will ever be admitted.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, docs/strands.md, docs/architecture.md
----
## Motivation

Today `Manager.MinOneManager` (`check on delete (count(Manager) >= 1)`) refuses any delete
that would leave a closed strand with zero managers, on the reasoning that an admin-less
strand can never admit anyone again. That is exactly the property we now *want* to offer:
a strand whose membership is frozen is a **privacy guarantee** to its members — no one
holds the power to add a party who would then see the strand's data. A manager-less
strand is not "bricked"; it is **sealed**.

## Design

### 1. Sealing is a distinct, signed act — not an accidental resignation

Drop `MinOneManager`. Do **not** simply let the existing `resign` branch drop the count to
zero: sealing is irreversible (see §2), so it must be something the sole manager
expressly signs, and a raw writer must not be able to seal with a plain resignation
approval. Split the self-removal branch of `Manager.Authorized` by post-image count:

- `'Strand.Manager','resign',old.MemberKey,old.StampId` — valid only when
  `(select count(1) from Manager) >= 1` after the delete (unchanged semantics).
- `'Strand.Manager','seal',old.MemberKey,old.StampId` — valid only when
  `(select count(1) from Manager) = 0` after the delete. Signed by `old.MemberKey`, the
  departing sole manager. The admin-removal branch (`remove`, signed by *another*
  manager) can never reach zero, so it needs no change.

Both counts are deferred (subquery) and therefore post-image, exactly as `MinOneManager`
was. A `seal` approval on a strand with other managers is rejected (wrong count); a
`resign` approval on the sole manager is rejected (wrong count). Same stamp binding as
every other approval, so a captured `seal` is single-use like the rest.

### 2. A sealed strand can never be re-founded

`Manager.Authorized`'s bootstrap branch (`Generation = 0`, `count(Manager) <= 1`,
`count(Member) <= 1`, member exists) currently cannot fire after founding only *because*
`MinOneManager` keeps the count above zero. Once zero managers is reachable, a sealed
strand whose members dwindle to one would let that survivor re-seat itself as a
generation-0 founder and start admitting — exposing every departed member's historical
contributions to new parties. Close it: add to the bootstrap branch

```sql
and not exists (select 1 from Revocation R where R.TableName = 'Manager')
```

"The founding branch is open only while no manager seat has ever been retired." Founding
happens exactly once per strand. Junk `Revocation` rows (any member may file one) cannot
brick founding: at founding time the only member is the founder.

### 3. A sealed strand admits nobody — including via invitations already issued

Every admission path except one already requires a `Manager` row (`Invite.InviteValid`,
`Member.Authorized` manager-add branch, `Manager.Authorized` promotion branch). The
exception is an **unspent, uncancelled invitation issued before sealing**: it would still
consume. `cancelInvite` needs a manager, so after sealing nobody could kill it. Add to
`ConsumedInvite`, beside `NotCancelled`:

```sql
constraint NotSealed check on insert (exists (select 1 from Manager))
```

Live `Manager`, post-image: at commit at least one manager must still exist. Blocking the
`ConsumedInvite` insert blocks the whole join, for the reason `NotCancelled`'s comment
already states. `sealStrand` need not enumerate and cancel outstanding invites; they die
with the seal.

### 4. What remains possible in a sealed strand

- Members may still **leave** (`leaveStrand`, self-signed) — subject to `MinOneMember`,
  which is unchanged: the strand always keeps at least one member, who holds its data.
- Members may still add/remove their **own** `MemberPeer` rows (self-signed) — same
  party, new device; not an admission.
- Members may still file `Revocation` tombstones (member action) — needed for the two
  above.
- Nobody may: issue/cancel invites, admit, promote, revoke another member, or clear
  another member's peer binding. All of these require a manager.

### 5. Writer API (`strand-membership-writer.ts`)

- `sealStrand(db, { managerKeyPair })` — new. Pre-check in TS that the caller is the
  **sole** manager (clear error otherwise; the schema rejects anyway). Signs the `seal`
  tag, deletes the row, files the tombstone in one transaction. Export from `index.ts`.
- `removeManager` — self path: if the target is the sole manager, throw in TS naming
  `sealStrand` (the schema now rejects `resign` at count zero, so this is a UX guard, not
  the trust boundary). Rewrite its JSDoc "THE LAST MANAGER CANNOT BE REMOVED" block.
- `isStrandSealed(db)` — `count(Manager) = 0`. Also the answer to "how does a member know":
  sealed is derived state, not a `Header` flag (`Header` is insert-only anyway).
- `revokeMember` JSDoc (~line 817) references `MinOneManager`; fix.

### 6. Schema mirror

`schemas/strand.qsql` and the `STRAND_SCHEMA` constant in
`packages/quereus-plugin-sereus/src/strand-schema.ts` must stay byte-equivalent (header
comment of the .qsql). Every `MinOneManager` mention in comments (the
`NotRevoked / MinOneMember / MinOneManager local-visibility` cross-references on
`CancelledInvite`, `Manager.MemberExists`, `Revocation`) needs the name swapped for the
new count gates or dropped.

## Edge cases & interactions

- Sole manager signs `resign` → rejected (count 0 ≠ ≥1). Sole manager signs `seal` →
  accepted, `Manager` empty, tombstone filed.
- Non-sole manager signs `seal` → rejected (count ≥1 ≠ 0).
- Another manager signs `remove` on the second-to-last manager → still accepted; count
  can't reach zero via `remove`.
- Seal + leave in **one transaction** (sole manager wants out entirely): `NotAManager`
  reads the post-image, so delete Manager + delete Member together passes — provided
  `MinOneMember` holds (another member remains). Sole-manager-and-sole-member cannot
  leave: `MinOneMember`. Pin both.
- After sealing: `addManager`, `addMemberByManager`, `issueInvite`, `cancelInvite`,
  `revokeMember`, `removeMemberPeer` (manager path) all rejected — each by its existing
  `Authorized` (no manager row to verify against). Pin at least `addManager`,
  `addMemberByManager`, and `issueInvite`.
- After sealing: `consumeInvite` on an invite **issued before** the seal, still unexpired
  and uncancelled → rejected by `ConsumedInvite.NotSealed`. Whole join rolls back (no
  orphan `Member` row). Pin.
- After sealing, members dwindle to one; survivor attempts `insert into Manager
  (Generation 0)` with null context → rejected by the new `Revocation` gate on the
  bootstrap branch. Pin.
- Founding a fresh strand still works: Header → Member → Manager order, no `Revocation`
  rows exist yet. Existing bootstrap tests must stay green.
- Replay: a captured `seal` approval replayed against a re-founded strand — cannot happen
  (§2), but a captured `seal` replayed on the same strand collides on `NotRevoked`
  anyway. One replay pin in `strand-approval-replay.spec.ts` for symmetry with the other
  tags.
- Network-transactor parity: `strand-membership-network-transactor-parity.spec.ts`
  currently pins "sole manager resigning → rejected /MinOneManager/". Flip to: `resign`
  rejected by `Authorized`; `seal` accepted; enforced above the transactor like the rest.
- **Cross-node (same class as today's local-visibility notes; not solved here):** a node
  that has not yet converged on the seal still shows the manager row, and the
  ex-manager's *own* key could still admit there until the delete propagates. Only that
  key — no stranger gains anything. State it in the schema comment and `docs/strands.md`
  known gaps, in the house style of the existing `MinOneMember` caveat.
- `MinOneMember` keeps its existing comment's reference to a "founding Manager only
  seatable beside an existing Member" — still true; leave it.

## Docs

- `docs/strands.md` → "Who May Administer a Closed Strand": replace **"The last manager can
  never be removed"** with a **sealing** bullet (what it is, why it is a privacy
  guarantee, that it is signed and irreversible, what remains possible, and that
  outstanding invitations die with it). Known-gaps bullet: drop the last-manager floor
  from the local-count caveat, add the seal-propagation caveat.
- `docs/architecture.md` ~lines 634 and 670: the `MinOneManager` sentences and the "⚠️
  Still open" caveat; rewrite for the seal.
- `tickets/complete/*` mentions are history; leave them.

## Decisions taken (revisit here, not in the implementer's head)

- **Distinct `seal` tag vs. plain resignation reaching zero.** Chose the tag: one extra
  branch buys a signed statement of intent and keeps a raw writer from sealing by
  accident. Tradeoff: one more approval tag to document in the architecture table.
- **Permanent seal (no re-founding) vs. survivor may re-found.** Chose permanent: the
  guarantee is to *every* member who contributed, including those who later leave.
- **`NotSealed` on `ConsumedInvite` vs. requiring `sealStrand` to cancel outstanding
  invites first.** Chose the schema gate: it holds regardless of which writer seals, and
  needs no enumeration step that could race a concurrent consume.

## TODO

- Schema: drop `MinOneManager`; split self branch into `resign` (count ≥ 1) and `seal`
  (count = 0); add `Revocation` gate to the bootstrap branch; add
  `ConsumedInvite.NotSealed`; update every cross-referencing comment. Mirror byte-for-byte
  into `strand-schema.ts`.
- Writer: `sealStrand`, `isStrandSealed`, `removeManager` sole-manager guard + JSDoc,
  `revokeMember` JSDoc; export from `index.ts`.
- Tests: flip the two `/MinOneManager/` pins; add the cases in *Edge cases & interactions*.
- Docs: `strands.md`, `architecture.md` (approval-tag table gains `seal`).
- `yarn lint` + `yarn workspace @serfab/cadre-core test` +
  `yarn workspace @serfab/quereus-plugin-sereus test` green.
