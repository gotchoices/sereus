description: Proved the new "seal a strand" behaviour with a full adversarial test suite and brought the two design documents in line, so they no longer claim the last manager can never step down.
files: packages/cadre-core/test/strand-seal.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, docs/strands.md, docs/architecture.md, packages/cadre-core/src/strand-membership-writer.ts
difficulty: medium
----

# Complete: seal test matrix + design-doc alignment

`strand-seal-schema-and-writer` landed the mechanism (the `'seal'` branch of
`Manager.Authorized`, plus `sealStrand` / `isStrandSealed`). This ticket added the
adversarial coverage and rewrote the two design documents that still described a
last-manager floor that no longer exists. The review pass below closed the gap the
implement pass left: the docs' *positive* claim about what a sealed strand can still do
was argued in prose and pinned by nothing.

## What "sealed" means

A closed strand's `Strand.Manager` table is its whole admission authority. The last
manager may delete its own row by signing a distinct `'seal'`-tagged approval, valid only
when the post-image manager count is zero. Afterwards nobody can ever be invited,
admitted, or promoted again — the privacy guarantee the remaining members are buying. It
is irreversible: `Manager.Authorized`'s founding branch refuses to re-seat a generation-0
manager once any `Manager` stamp has been retired into `Revocation`.

"Sealed" is derived, not stored, and takes **three** conjuncts: closed, zero managers,
**and** a retired `Manager` stamp. The third separates a sealed strand from one that is
merely not founded yet — bootstrap commits `Header`, `Member` and `Manager` as three
sequential statements, so the middle of that sequence looks identical to a seal without
it.

## What landed

### `packages/cadre-core/test/strand-seal.spec.ts` (new, 16 cases)

Every case boots a real closed strand on the local transactor via `connectToStrand`
(libp2p node + `MemoryRawStorage`), the same path `StrandDatabase` uses. House shape of
`strand-membership-manager-rotation.spec.ts`: 30s timeouts, a comment above each
rejection naming the one constraint that can fire and why the others genuinely pass.

- `sealStrand` — the sole manager seals (table empties, the retired stamp's `Revocation`
  row asserted present, the founder's `Member` row survives); throws `/not founded/` on a
  closed-but-unfounded strand; quiet no-op when already sealed; throws when the caller is
  not the manager; throws `/removeManager/` while a second manager exists, paired in the
  same case with a hand-rolled `'seal'`-tagged delete of one of two managers rejecting
  `/Authorized/`; a founder restart of a sealed strand is a quiet no-op, paired with a
  fresh closed strand still founding — the pair is what proves the `Revocation` gate
  discriminates rather than blanket-skipping the founding insert.
- `isStrandSealed` — false before / true after; false on an **open** strand; false on a
  closed strand not founded yet.
- Schema seal branch, raw SQL — two managers each self-signing `'seal'` in ONE
  transaction is **accepted** (a joint seal by mutual consent, unreachable through
  `sealStrand`); a sealed strand cannot be re-founded (`/Authorized/`), with the strand
  genuinely at one member so the new `Revocation` conjunct is the only unsatisfied one.
- A sealed strand — every admission path rejects (`addManager`, `admitManager`,
  `addMemberByManager`, `issueInvite`, `cancelInvite`, `revokeMember`); a pre-seal
  invitation dies with the seal (`/NotSealed/`, with `Member` and `ConsumedInvite` counts
  both asserted unchanged); seal + leave in one transaction succeeds when another member
  remains; seal + leave by the sole manager who is also the sole member rejects
  `/MinOneMember/` and rolls the seal back with it. **Added in review:** the positive
  arm — a member still registers and clears its OWN `MemberPeer` rows and still leaves
  after the seal, while the *manager* arm of `removeMemberPeer` is refused `/Authorized/`
  forever.

### `packages/cadre-core/test/strand-approval-replay.spec.ts` (+1 case)

`R3b: a captured seal cannot seal a re-seated signer (Authorized)` — founder promotes X,
X's `'seal'` approval over its first stamp is captured, X is removed and re-promoted under
a fresh stamp, the founder resigns (valid — X survives) leaving X the sole manager. The
replay is rejected `/Authorized/` because the digest hashes the *first* stamp; the
positive path (`sealStrand` by X) then succeeds. The header table gained an `R3b` row and
a paragraph stating honestly that R3b — unlike R1–R6 — was never reproducible as a working
attack, because the `'seal'` branch shipped with the stamp binding already in place.

### Docs

- `docs/strands.md` — the "last manager can never be removed" bullet is now a **sealing**
  bullet (what it is, why it exists, that it is signed and irreversible, what remains
  possible, and that outstanding invitations die with it). The manager-is-also-a-member
  paragraph's "Like the floors above" now points at the sealing rule. The last-member
  bullet states its guarantee on its own terms and notes it still binds on a sealed
  strand. The known-gaps bullet dropped its last-manager half and gained a
  seal-propagation caveat.
- `docs/architecture.md` — the approval-digest table gained a `Manager self-seal` row and
  the self-resignation row now says it is valid only while another manager remains; the
  replay-coverage line lists sealing; `removeManager` names `sealStrand` as its sibling;
  new bullets describe `sealStrand` and `isStrandSealed` (the latter spelling out all
  three conjuncts); the **Manager-removal hazards** paragraph no longer claims a
  min-one-manager floor and its "⚠️ Still open" is now seal propagation.

Only `docs/architecture.md`'s hazards paragraph still contains the string
`MinOneManager`, and it is the sentence saying the constraint **was removed**.

## Review findings

Read the implement diff (`b7d8a79`) before the handoff summary. Re-derived every pin in
the new spec against `schemas/strand.qsql` and `strand-membership-writer.ts` rather than
taking the comments' word for it.

**Verified, no change needed**

- **The deliberate deviation from the ticket text is correct.** The implementer skipped
  the requested "raw `'resign'`-tagged delete of the SOLE manager" case, arguing
  `strand-membership-manager-rotation.spec.ts` → *rejects the SOLE manager resigning*
  already covers it at both levels. Read that case (`:482-518`): it does exactly that —
  writer refusal naming `sealStrand`, then the raw resign-tagged delete + tombstone
  rejecting `/Authorized/`, then a successful `sealStrand`. Duplicating it would have
  bought nothing.
- **The `/Authorized/` pins where two constraints share the name.** Checked each
  rejection that rides a `Strand.Revocation` insert: the tombstone filer is a committed
  `Member` in every one, so `Revocation.Authorized` genuinely passes and the pinned
  constraint is the only rejector. `admitManager` post-seal is correctly weakened to
  `/CHECK constraint failed/` — `Member.Authorized` and `Manager.Authorized` can each
  fire there.
- **The joint-seal ACCEPT is the right thing to pin.** Two managers each self-signing
  `'seal'` in one transaction is mutual consent, and neither can seal the *other* out
  (the branch requires `old.MemberKey = context.ManagerKey`). No schema change wanted —
  but see the tripwire below.
- **`ConsumedInvite.NotSealed` really is the sole rejector** in the pre-seal-invitation
  case: deferred checks see the post-image, so the `ConsumedInvite` row is present for
  `Member.Authorized`'s invite branch even though its own check fails.
- **No CLI or host surface is missing.** `packages/cadre-cli` and `packages/cadre-host`
  call none of the manager writers (`grep` over both `src` trees), so sealing having no
  command is not a gap this ticket opened.
- **No stale prose elsewhere.** Grepped `MinOneManager` and every "last manager / sole
  manager / never be removed" phrasing across `docs/`, `schemas/` and `packages/*/src`.
  `docs/testing.md` carries no strand spec inventory to update.

**Minor — fixed in this pass**

- **The docs' "what remains possible" claim was pinned by nothing.** All three copies
  (`docs/strands.md`, the `sealStrand` bullet in `docs/architecture.md`, the writer
  JSDoc) assert that after a seal members may still leave and still manage their own
  device records — true by construction, but a tests-and-docs ticket should not leave its
  own positive claim to a reader's re-derivation. Added a case to `describe('a sealed
  strand')` pinning it, and pinning the consequence nobody had stated: the *manager* arm
  of `removeMemberPeer` reads `committed.Manager`, so a device record orphaned by an
  earlier revocation can never be cleared once the strand is sealed. Documented that
  clause in both `docs/strands.md` and `docs/architecture.md`.
- **`docs/architecture.md` mis-described the seal mechanism.** It listed `cancelInvite`
  under "every path that **grows the membership**" (cancelling shrinks nothing) and
  implied `consumeInvite` is blocked by needing a `Manager` row directly, when it is
  blocked by the separate `ConsumedInvite.NotSealed` constraint. Reworded to "every path
  that touches admission" and named `NotSealed` explicitly.
- **`hasRevocation` in the new spec typed its table name as `string`** while its sibling
  `fileTombstone` two functions below uses the `'Member' | 'Manager' | 'MemberPeer'`
  union. Tightened to match (AGENTS.md: not type lazy).

**Tripwire — recorded, not ticketed**

- A seal approval is a bearer token for its row incarnation like every other self-signed
  approval here, but the `'seal'` branch's post-image count of 0 is satisfied for *every*
  row deleted in the same transaction — so one manager holding another's unspent seal
  approval could freeze the strand irreversibly without its current consent. Unreachable
  today: `sealStrand` mints a seal signature only while its caller is the sole manager
  and spends it immediately, so a second manager never has one to combine. Parked as a
  `NOTE:` on `sealStrand`'s JSDoc in `packages/cadre-core/src/strand-membership-writer.ts`
  — the site that would change if seal-approval minting were ever split from spending
  (offline signing, a two-phase seal, a queued approval).

**Major — none.** Nothing in the diff needed a new ticket. The one duplication finding
resolved into an existing ticket rather than a new one:

- **`fileTombstone` is now in a fifth spec file**, and `managerStamp` and `seatMember`
  are each in a second. `debt-hoist-strand-tombstone-helpers` (backlog) already owns this
  theme, so the instance was appended there rather than filed fresh: its count table,
  `files:` list, `description:` and expected end state now cover `strand-seal.spec.ts`,
  `managerStamp` and `seatMember`. Counted with
  `grep -rn "async function fileTombstone\|function memberPeerStamp\|async function managerStamp\|async function seatMember" packages/cadre-core/test`.

**Accepted tradeoffs left alone.** The schema's founding branch carries a `NOTE:` that a
founder can self-harm by filing a junk `Revocation('Manager', …)` between its own `Member`
and `Manager` inserts and permanently block its own founding. That decision is recorded at
the site with its rationale and its revisit condition has not tripped, so it was not
re-filed.

## Known gaps (unchanged, by design)

- **Single-node only.** Nothing exercises seal propagation across nodes — the documented
  caveat that a node which has not yet received the seal still shows the manager's seat,
  so that one ex-manager's own key could still admit there. Same convergence class as the
  existing `MinOneMember` / `NotRevoked` notes; no test exists for any of them.
- **Network-transactor coverage of the seal lives elsewhere.**
  `strand-membership-network-transactor-parity.spec.ts` already runs *accepts the sole
  manager sealing, then rejects re-admission* on the network transactor;
  `strand-seal.spec.ts` is local-transactor only and does not repeat it.
- **Irreversibility is pinned at one shape.** The re-founding case covers a lone survivor
  re-inserting a generation-0 row with a null context. Other re-founding shapes (a signed
  insert, a non-zero generation) are refused by branches the rotation spec already covers,
  but are not re-pinned against the sealed state specifically.

## Validation

Run in the foreground, no redirection:

- `yarn lint` — clean (exit 0).
- `yarn typecheck` — clean, including the vitest/test-file type-check coverage guards.
- `yarn workspace @serfab/cadre-core test` — **106 files, 1700 passed / 1 skipped**
  (1699 before the review's added case). The single skip is pre-existing and unrelated;
  no `tickets/.pre-existing-error.md` was written because nothing failed.
- `yarn workspace @serfab/quereus-plugin-sereus test --run test/strand-schema-drift.spec.ts`
  — 15 passed. Neither `schemas/strand.qsql` nor `strand-schema.ts` was touched by the
  implement or review pass, so the guard is confirmed unaffected rather than assumed.

The three touched spec files together run in ~11.5s, so no split was needed.
