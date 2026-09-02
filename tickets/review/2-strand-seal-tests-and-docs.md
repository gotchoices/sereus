description: Proved the new "seal a strand" behaviour with a full adversarial test suite and brought the two design documents in line, so they no longer claim the last manager can never step down.
files: packages/cadre-core/test/strand-seal.spec.ts, packages/cadre-core/test/strand-approval-replay.spec.ts, docs/strands.md, docs/architecture.md, packages/cadre-core/src/strand-membership-writer.ts, schemas/strand.qsql, packages/cadre-core/test/strand-membership-manager-rotation.spec.ts, packages/cadre-core/test/strand-membership-network-transactor-parity.spec.ts
difficulty: medium
----

# Review: seal test matrix + design-doc alignment

`strand-seal-schema-and-writer` landed the mechanism (schema branches + `sealStrand` /
`isStrandSealed`). This ticket added the adversarial coverage and rewrote the two design
documents that still described a last-manager floor that no longer exists.

**No production code changed.** The diff is one new spec file, one case added to an
existing spec file, and prose in two docs.

## What "sealed" means (the thing under test)

A closed strand's `Strand.Manager` table is its whole admission authority. The last
manager may delete its own row by signing a distinct `'seal'`-tagged approval, valid only
when the post-image manager count is zero. Afterwards nobody can ever be invited,
admitted, or promoted again — which is the privacy guarantee the remaining members are
buying. It is irreversible: `Manager.Authorized`'s founding branch refuses to re-seat a
generation-0 manager once any `Manager` stamp has been retired into `Revocation`.

"Sealed" is derived, not stored, and takes **three** conjuncts: closed, zero managers,
**and** a retired `Manager` stamp. The third one is what separates a sealed strand from
one that is merely not founded yet — bootstrap commits `Header`, `Member` and `Manager`
as three sequential statements, so the middle of that sequence looks identical to a seal
without it.

## What landed

### `packages/cadre-core/test/strand-seal.spec.ts` (new, 15 cases)

Every case boots a real closed strand on the local transactor via `connectToStrand`
(libp2p node + `MemoryRawStorage`), the same path `StrandDatabase` uses. House shape of
`strand-membership-manager-rotation.spec.ts`: 30s timeouts, a comment above each
rejection naming the one constraint that can fire and why the others genuinely pass.

- `sealStrand` — the sole manager seals (table empties, the retired stamp's `Revocation`
  row is asserted present, the founder's `Member` row survives); throws `/not founded/`
  on a closed-but-unfounded strand; quiet no-op when already sealed; throws when the
  caller is not the manager; throws `/removeManager/` while a second manager exists, and
  in the same case a hand-rolled `'seal'`-tagged delete of one of two managers is
  rejected `/Authorized/` (post-image count 1, so the `seal` branch cannot accept);
  a founder restart of a sealed strand is a quiet no-op, paired in the same case with a
  fresh closed strand still founding — the pair is what proves the `Revocation` gate
  discriminates rather than blanket-skipping the founding insert.
- `isStrandSealed` — false before / true after; false on an **open** strand; false on a
  closed strand that is not founded yet.
- Schema seal branch, raw SQL — two managers each self-signing `'seal'` in ONE
  transaction is **accepted** (a joint seal by mutual consent; unreachable through
  `sealStrand`, deliberately allowed by the schema); a sealed strand cannot be re-founded
  (`/Authorized/`), with the strand genuinely at one member so `count(Member) <= 1`
  passes and the new `Revocation` conjunct is the only unsatisfied one.
- A sealed strand — every admission path rejects (`addManager`, `admitManager`,
  `addMemberByManager`, `issueInvite`, `cancelInvite`, `revokeMember`); a pre-seal
  invitation dies with the seal (`/NotSealed/`, with `count(Member)` and
  `count(ConsumedInvite)` both asserted unchanged, since the point is that blocking the
  `ConsumedInvite` insert rolls back the `Member` insert riding with it); seal + leave in
  one transaction succeeds when another member remains; seal + leave by the sole manager
  who is also the sole member rejects `/MinOneMember/` and rolls the seal back with it.

### `packages/cadre-core/test/strand-approval-replay.spec.ts` (+1 case)

`R3b: a captured seal cannot seal a re-seated signer (Authorized)` — founder promotes X,
X's `'seal'` approval over its first stamp is captured, X is removed and re-promoted
under a fresh stamp, the founder resigns (valid — X survives) leaving X the sole manager.
The replay is rejected `/Authorized/` because the digest hashes the *first* stamp; the
positive path (`sealStrand` by X) then succeeds. Header table gained an `R3b` row, and a
short paragraph states honestly that R3b — unlike R1–R6 — was never reproducible as a
working attack, because the `'seal'` branch shipped with the stamp binding already in
place.

### Docs

- `docs/strands.md` — the "last manager can never be removed" bullet is now a **sealing**
  bullet (what it is, why it exists, that it is signed and irreversible, what remains
  possible, and that outstanding invitations die with it). The manager-is-also-a-member
  paragraph's "Like the floors above" now points at the sealing rule. The last-member
  bullet no longer mirrors a floor that does not exist — it states the guarantee on its
  own terms and notes it still binds on a sealed strand. The known-gaps bullet dropped
  its last-manager half and gained a seal-propagation caveat in the same plain register.
- `docs/architecture.md` — approval-digest table gained a `Manager self-seal` row and the
  self-resignation row now says it is valid only while another manager remains; the
  replay-coverage line lists sealing; the `MinOneManager` cross-reference at the
  anti-replay paragraph repoints at the seal-propagation caveat; `removeManager` names
  `sealStrand` as its sibling and the distinct tag; two new bullets describe `sealStrand`
  and `isStrandSealed` — the latter spelling out all three conjuncts so no reader
  concludes an empty `Manager` table alone is the definition; the **Manager-removal
  hazards** paragraph no longer claims a min-one-manager floor, and its "⚠️ Still open"
  is now seal propagation rather than concurrent removals converging to zero.

Only `docs/architecture.md:674` still contains the string `MinOneManager`, and it is the
sentence saying the constraint **was removed**. `tickets/complete/*` was left untouched.

## Validation

Run in the foreground, no redirection:

- `yarn lint` — clean (exit 0).
- `yarn workspace @serfab/cadre-core test` — **106 files, 1699 passed / 1 skipped**
  (was 105 / 1683 before this ticket; +15 seal cases, +1 replay case). The single skip is
  pre-existing and unrelated. No `tickets/.pre-existing-error.md` written — nothing
  failed.

Wall clock is a non-issue: the two touched spec files together run in ~11s
(`--run test/strand-seal.spec.ts test/strand-approval-replay.spec.ts`), so the ticket's
contingency about splitting the raw-SQL cases into a second file was not needed.

`schemas/strand.qsql` and `packages/quereus-plugin-sereus/src/strand-schema.ts` were not
touched, so the drift guard in `@serfab/quereus-plugin-sereus` is unaffected; that
package's suite was not re-run.

## Where to look hardest

- **Deviation from the ticket text, deliberate.** The ticket asked for a case pinning
  that a raw `'resign'`-tagged delete of the SOLE manager rejects `/Authorized/`, on the
  premise that the rotation spec pinned only the writer-level guard. That premise is
  stale: `strand-membership-manager-rotation.spec.ts` → *rejects the SOLE manager
  resigning* already does both in one case (the writer refusal naming `sealStrand`, then
  the raw resign-tagged delete + tombstone rejecting `/Authorized/`, then a successful
  `sealStrand`). Rather than boot a second strand for an identical claim, the new spec's
  header comment says explicitly what is **not** re-pinned here and where it lives. If
  you disagree, the duplicate is ~20 lines and cheap — but check the rotation case first.
- **Pins that name `Authorized` where two constraints share the name.** Several
  rejections pin `/Authorized/` while a `Strand.Revocation` row rides the same
  transaction, and `Revocation` has its own `Authorized`. Each such case has a comment
  arguing the tombstone leg genuinely passes (the signer is a committed `Member`). The
  claim is inherited from the sibling specs' established discipline, not re-derived from
  the engine's message format — worth an adversarial read. `admitManager` post-seal is
  the one case pinned only as `/CHECK constraint failed/`, because `Member.Authorized`
  and `Manager.Authorized` can each fire and the winner is evaluation order.
- **The joint-seal case asserts an ACCEPT, not a rejection.** Two managers each signing
  `'seal'` in one transaction empties the table. That is deliberate at the schema level
  and unreachable through `sealStrand`, but it is the one place where the test encodes a
  permission rather than a refusal — if the intended rule is "only ever one manager may
  seal", this test is pinning the wrong thing and the schema, not the test, needs the
  change.

## Known gaps (not addressed here, by design)

- **Single-node only.** Nothing here exercises seal propagation across nodes — the
  documented caveat that a node which has not yet received the seal still shows the
  manager's seat, so that one ex-manager's own key could still admit there. Same
  convergence class as the existing `MinOneMember` / `NotRevoked` notes; no test exists
  for any of them.
- **Network-transactor coverage of the seal is not in this file.**
  `strand-membership-network-transactor-parity.spec.ts` (landed by the prereq ticket)
  already runs *accepts the sole manager sealing, then rejects re-admission* on the
  network transactor; `strand-seal.spec.ts` is local-transactor only and does not repeat
  it.
- **`fileTombstone` is now duplicated in a fourth spec file.** Left as-is on purpose —
  consolidating the copies is the separate open ticket `debt-hoist-strand-tombstone-helpers`,
  and pre-empting it here would put the refactor in a test-coverage diff.
- **The docs claim irreversibility in prose; the tests pin it at one shape.** The
  re-founding case covers a lone survivor re-inserting a generation-0 row with a null
  context. Other re-founding shapes (a signed insert, a non-zero generation) are refused
  by branches the rotation spec already covers, but not re-pinned against the sealed
  state specifically.
