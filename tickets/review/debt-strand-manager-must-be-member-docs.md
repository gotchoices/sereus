description: Docs and stale comments now match the shipped rule that a group's admin must also be one of its members; ready for a review pass.
files: docs/strands.md (208-213, 239-244), docs/architecture.md (580, 612-613), packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts (253-259), packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts (330-334, checked/unchanged)
----

# Complete: docs + out-of-package call sites for `Manager.MemberExists`

Paperwork-only ticket. Source (`Manager.MemberExists`, `Member.NotAManager`,
`admitManager`) and its own package's tests landed in the two prior tickets in this chain
(`debt-strand-manager-must-be-member`, `debt-strand-manager-must-be-member-tests`). This
ticket touched only docs, two other packages' test comments, and validation.

## What changed

**`docs/strands.md`**:
- 208-213 — replaced the "being a manager does not require being a member" paragraph
  (which stated the OLD, now-false rule) with the enforced rule, and mentioned that
  admit-then-promote in one step is supported.
- 239-244 — the "a manager must resign before losing membership" bullet under *Removing
  Members* now pairs the delete-side half with the insert-side half, so the invariant
  reads as total (both directions) rather than one-directional.
- 197-200 (founding-manager bootstrap-order bullet) — read and checked: it only claims
  "seating the manager first is rejected" without attributing a mechanism, so it stays
  true regardless of which constraint does the rejecting now. Left unchanged.

**`docs/architecture.md`**:
- 612 (`addManager` bullet) — deleted the parenthetical claiming "the `Manager` table has
  no `MemberExists` constraint"; replaced with the enforced rule.
- 613 (new) — added a sibling `admitManager` bullet, same register/depth as its
  neighbours: one transaction, no new authority (composes two already-existing signed
  actions), promoting manager must pre-date the transaction so calls can't chain.
- 580 (anti-replay paragraph) — corrected the "a manager holding no `Member` row can add
  members and promote managers but cannot revoke…" claim. That state is unreachable now.
  Kept the still-true underlying fact (filing a tombstone is a member action) and stated
  the consequence directly: `Manager.MemberExists` guarantees every manager can use those
  powers.

Repo-wide grep for `debt-strand-manager-must-be-member` under `docs/` now returns zero
hits — all three prior sites (architecture.md:580, architecture.md:612, strands.md:214)
are resolved.

**`packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts`** (253-259): the
shared header comment on the `OnlyClosed` test claimed the Manager insert "would otherwise
satisfy its bootstrap branch" — true before this rule existed, false now. The insert 'm1'
never becomes a Member (rejected earlier in the same block by `OnlyClosed`), so the Manager
insert now fails for two independent reasons: `OnlyClosed` **and** `Manager.MemberExists`.
Comment rewritten to say so; the Member insert's own bootstrap-branch claim is unaffected
and kept.

**`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts`**
(324, 330-334) — checked, not changed:
- Line 324 promotes `joinerMember`, who is already a `Strand.Member` (seated earlier in
  the scenario via `consumeInvite`, line ~257) — unaffected by the new rule, no comment to
  fix.
- Lines 330-334: `addManager(founderDb, { byManagerKeyPair: freshKeyPair(), newManagerKey:
  freshKeyPair().publicKeyB64 })` — both the signer and the target are fresh, never-seen
  keys. Still rejects, and now for the same reason as before *plus* a new one
  (`Manager.MemberExists`, since the target isn't a member either) — but the comment ("A
  non-manager cannot add a manager.") only asserts the signer-side reason and never claimed
  exclusivity, so it stays accurate as written. No edit made.
- This file is a real-network integration scenario — per the ticket, **not** run (not
  agent-runnable inside the 10-minute idle timeout). It was already noted elsewhere in
  `docs/architecture.md` (end-to-end coverage section) that this scenario currently fails
  at strand bring-up on the separately-tracked, blocked `control-db-convergence-optimystic-p2p`
  issue — unrelated to this change, not re-verified here.

## Validation

| command | result |
| --- | --- |
| `yarn typecheck` (repo-wide, `yarn workspaces foreach -A run typecheck`) | exit 0, clean, ~15s |
| `yarn lint` (repo-wide, `eslint .`) | exit 0, clean |
| `yarn workspace @serfab/quereus-plugin-sereus test` | 7 files, 68 passed, 1 todo, ~33s — includes the corrected `strand-schema.e2e.spec.ts` |

No pre-existing failures surfaced; nothing skipped or loosened.

## Known gaps for the reviewer

- The integration-tests scenario source was edited-for-review only (found nothing to
  change) but never executed — take the "checked, not changed" call above as a starting
  point, not a verified fact; if reviewing, re-derive the two-reasons claim for lines
  330-334 independently rather than trusting this handoff, the same way the prior
  ticket's review re-derived constraint-branch claims from the schema directly.
  `../quereus`'s workspace `dist` has previously gone stale mid-session (noted in the
  prior ticket's review) and blocked the stale-build guard; not hit this run, but worth
  knowing if `yarn workspace @serfab/cadre-core` commands are added to the review's
  validation.
- Prose in `docs/strands.md` and `docs/architecture.md` was written to match the
  surrounding register (plain language in `strands.md`, implementation-level detail in
  `architecture.md`) — worth a read-through for tone consistency, not just factual
  correctness.
