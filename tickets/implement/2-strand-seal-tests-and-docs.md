description: Prove and document the new "seal a strand" behaviour — a full set of tests for the ways it must and must not work, plus updates to the two design documents that still say the last manager can never step down.
prereq: strand-seal-schema-and-writer
files: packages/cadre-core/test/strand-seal.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, packages/cadre-core/test/strand-spec-helpers.ts, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, docs/strands.md, docs/architecture.md, packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql
difficulty: medium
----

# The seal: adversarial test matrix + docs

`strand-seal-schema-and-writer` lands the mechanism and keeps the existing suite green.
This ticket proves it against the boundary states and brings the two design documents in
line. **Read that ticket first** — its Design section is the specification this one tests.

## Recap of the behaviour under test

A closed strand's `Strand.Manager` table is its whole admission authority. The last
manager may now delete its own row by signing a distinct `'seal'`-tagged approval — valid
only when the post-delete manager count is zero — which permanently freezes membership:

- `'Strand.Manager','resign',old.MemberKey,old.StampId` requires post-image
  `count(Manager) >= 1`.
- `'Strand.Manager','seal',old.MemberKey,old.StampId` requires post-image
  `count(Manager) = 0`.
- `Manager.Authorized`'s founding branch additionally requires
  `not exists (select 1 from Revocation R where R.TableName = 'Manager')`, so a sealed
  strand can never be re-founded.
- `ConsumedInvite.NotSealed` (`exists (select 1 from Manager)`, deferred) kills any
  invitation issued before the seal.

On the writer side, `isStrandSealed` reports sealed only when all three hold: the strand
is closed, the `Manager` table is empty, and a `Manager` stamp has been retired. The
third conjunct is what separates a sealed strand from one that is simply not founded
yet, and `sealStrand` uses the same distinction (quiet no-op when already sealed, throw
when not founded).

## New spec file: `packages/cadre-core/test/strand-seal.spec.ts`

Follow the house shape of `strand-membership-manager-rotation.spec.ts`: import
`openStrand`, `tableCount`, `freshKeyPair`, `inTransaction` from
`./strand-spec-helpers.js`, `30_000` per-test timeouts, and a comment above each case
naming the constraint it pins and why that constraint is the only possible rejector.
`fileTombstone` is duplicated per spec file today — reuse the local copy in whichever
file you edit rather than adding a fifth; consolidating them is the separate open ticket
`debt-hoist-strand-tombstone-helpers`, and this ticket should not pre-empt it.

Cases:

- **The sole manager seals.** `sealStrand` succeeds; `count(Manager) === 0`; the
  `Revocation` row for the retired stamp exists; the founder's `Member` row survives.
- **`isStrandSealed`.** `false` before the seal, `true` after; `false` on an **open**
  strand (`openStrand('o')`), which never holds `Manager` rows at all; and `false` on a
  closed strand that is not FOUNDED yet — `Header` inserted, `Manager` not. That last
  case is the reason the predicate is three conjuncts and not two (closed, zero
  managers, **and** a retired `Manager` stamp): founding commits `Header`, `Member` and
  `Manager` as three sequential statements, so mid-bootstrap looks exactly like a seal
  unless the retired stamp is checked. Build the state by inserting a `Header` with
  `Type = 'c'` directly (or by whatever bootstrap seam the helpers already expose)
  rather than by racing `bootstrapFounderMembership`.
- **`sealStrand` on a closed strand that is not founded yet throws** — zero managers with
  no retired `Manager` stamp is "still foundable", not "frozen", so returning quietly
  would report a seal that never happened. Distinct from the already-sealed no-op below;
  pin that the two branches really are distinguished (message mentions "not founded").
- **A founder restart of a SEALED strand is a quiet no-op.** Seal, then call
  `bootstrapFounderMembership` again with the founder's params: it must return without
  throwing and leave `count(Manager) === 0` — `insertFounderManagerIfAbsent` mirrors the
  schema's own `Revocation`-gate rather than driving a rejected insert. Pair it with the
  "founding a fresh closed strand still works" case: together they pin that the gate
  discriminates rather than blanket-skipping.
- **A raw `resign`-tagged delete of the sole manager rejects `/Authorized/`.** Sign
  `['Strand.Manager','resign',founderKey,stamp]` by hand, delete + tombstone in one
  transaction. Post-image count is 0, so only the `seal` branch could accept and the tag
  is wrong. (The rotation spec pins the writer-level guard; this pins the schema.)
- **A raw `seal`-tagged delete while a second manager exists rejects `/Authorized/`**,
  and `sealStrand` on that strand throws the writer's count guard naming `removeManager`.
- **`sealStrand` by a non-manager, while a manager exists, throws** and leaves
  `count(Manager)` unchanged.
- **`sealStrand` on an already-sealed strand is a quiet no-op** (restart safety) — no
  throw, count stays 0.
- **Two managers each signing `seal` in ONE raw transaction is accepted.** Both rows'
  post-image count is 0 and each is self-signed: a joint seal by mutual consent.
  `count(Manager) === 0` afterwards. This shape is unreachable through `sealStrand`
  (its count guard) and is deliberately allowed at the schema level.
- **Post-seal admission is dead.** After sealing, each of `addManager`, `admitManager`,
  `addMemberByManager`, `issueInvite`, `cancelInvite` and `revokeMember` rejects. At
  minimum pin `addManager`, `addMemberByManager` and `issueInvite`; the rejector is each
  writer's own `Authorized` (no `Manager` row to verify against), so pin
  `/CHECK constraint failed/` unless the specific constraint name is stable.
- **A pre-seal invitation dies with the seal.** Issue an invitation (no expiry, never
  cancelled) while a manager exists, seal, then `consumeInvite` — rejects `/NotSealed/`,
  and `count(Member)` is unchanged (the whole join rolled back, no orphan `Member` row).
- **Seal + leave in one transaction succeeds** when another member remains: delete the
  sole manager (seal-tagged) and the departing `Member` row plus both tombstones in one
  transaction; afterwards `count(Manager) === 0` and `count(Member) === 1`.
- **Seal + leave by the sole manager who is also the sole member rejects
  `/MinOneMember/`** — the strand always keeps a member holding its data.
- **A sealed strand cannot be re-founded.** Seal, reduce the strand to one member, then
  raw-insert `Manager (MemberKey, Generation, StampId)` at `Generation = 0` with
  `ManagerKey = null, Signature = null` — rejects `/Authorized/`, because the founding
  branch now requires that no `Manager` stamp has ever been retired and the seal filed
  exactly such a tombstone.
- **Founding a fresh closed strand still works.** `openStrand('c')` yields
  `count(Manager) === 1` — an explicit guard that the new `Revocation` condition did not
  close the founding path.

## Replay pin: `packages/cadre-core/test/strand-approval-replay.spec.ts`

Add an `R3b` case beside the existing `R3` resignation replay, matching its structure and
adding a row to the table in the file header comment (`:30`):

**A captured seal cannot seal a re-seated signer (Authorized).** Founder promotes X.
Capture `signStrandApproval(['Strand.Manager','seal', xKey, firstStamp], xPriv)`. Founder
removes X (`remove`); founder re-promotes X (fresh `secondStamp`); founder resigns
(post-image count 1, so `resign` is valid) leaving X as the sole manager. Replay the
captured seal against X's row — rejected `/Authorized/`, because it hashes `firstStamp`.
Positive path: `sealStrand(db, { managerKeyPair: x })` then succeeds.

## Docs

**`docs/strands.md` → "Who May Administer a Closed Strand"** (`:190`):

- Replace the bullet **"The last manager can never be removed"** (`:223-225`) with a
  **sealing** bullet: what it is (the last manager signs a distinct approval that deletes
  its own seat), why it exists (a strand that can never grow is a privacy guarantee to
  everyone already in it — nobody holds the power to admit a party who would then read
  the strand's history), that it is signed and irreversible (a lone survivor cannot
  re-found the strand later), what remains possible (members may leave, and may register
  or clear their own device records), and that outstanding invitations die with it.
- The bullet at `:242-243` ("Like the floors above, the rule is checked against what one
  node can see") should still read correctly once the last-manager floor is gone — adjust
  its wording if it no longer does.
- The known-gaps bullet at `:292-297` names "the last-manager and last-member floors".
  Drop the last-manager half, and add the seal-propagation caveat in the same plain
  register: a node that has not yet received the seal still shows the manager's seat, so
  that one ex-manager's own key could still admit someone there until the deletion
  reaches it; no other party gains anything, and a cross-node guard is not attempted.
- The last-member bullet (`:283`) opens "A member-count floor mirrors the last-manager
  …" — there is no last-manager floor any more, so that comparison has to be rewritten
  (say what the member floor guarantees on its own terms), and the "the floor above,
  with the same local-count caveat" clause just after it must point at a floor that
  still exists.

**`docs/architecture.md`:**

- The approval-digest table (`:614-625`) gains a row:
  `| Manager self-seal | `'Strand.Manager','seal',old.MemberKey,old.StampId` |`, and the
  existing self-resignation row should say it is valid only while another manager
  remains.
- `:632` lists what `strand-approval-replay.spec.ts` covers — add the seal.
- `:634` cross-references "the `MinOneManager` caveat below" — repoint at the surviving
  caveat.
- `:668` (`removeManager`) — mention `sealStrand` as the sibling path and its distinct
  tag.
- `:670` **Manager-removal hazards** — rewrite the `MinOneManager` sentences and the
  trailing "⚠️ Still open" caveat: there is no min-one-manager floor any more; reaching
  zero requires a `seal`-tagged self-signature, and the still-open item is seal
  propagation rather than concurrent removals converging to zero.
- Add a sentence, where the strand membership writers are listed (`:644-668`), for
  `sealStrand` and `isStrandSealed`. State what "sealed" actually means — closed, no
  managers, and a retired `Manager` stamp — so the doc does not leave a reader thinking
  an empty `Manager` table alone is the definition.

Do not touch `tickets/complete/*` mentions of `MinOneManager` — those are history.

## Edge cases & interactions

- Every case above IS the edge-case list; the risk in this ticket is a test that passes
  for the wrong reason. For each rejection, state in a comment why the named constraint is
  the *only* one that can fire, the way the existing rotation-spec comments do — a case
  where two constraints could reject should pin `/CHECK constraint failed/` rather than a
  name.
- The re-founding case needs the strand actually reduced to one member, or
  `count(Member) <= 1` on the bootstrap branch rejects it and the test proves nothing
  about the new `Revocation` condition.
- The pre-seal-invitation case must assert `count(Member)` is unchanged, not merely that
  the call threw — the point of `NotSealed` is that blocking the `ConsumedInvite` insert
  rolls back the `Member` insert riding with it.
- `strand-seal.spec.ts` boots a real strand per case (~13 cases at 30s timeouts). If the
  file's wall-clock approaches the runner's 10-minute idle window, split the raw-SQL
  schema-gate cases into a second spec file rather than trimming coverage.
- The doc edits must not contradict the schema comments landed by the prereq ticket —
  read them and keep one story.

## TODO

- Write `packages/cadre-core/test/strand-seal.spec.ts` with the cases above.
- Add the `R3b` seal replay case + header-table row to `strand-approval-replay.spec.ts`.
- Rewrite the `docs/strands.md` administration bullet and known-gaps bullets.
- Update `docs/architecture.md`: approval table row, replay coverage line, writer list,
  and the Manager-removal hazards paragraph.
- `yarn lint` and `yarn workspace @serfab/cadre-core test` green, run in the foreground
  with no redirection.
