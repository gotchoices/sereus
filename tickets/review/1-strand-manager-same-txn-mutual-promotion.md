----
description: Two strangers could seize control of a private group by vouching for each other in a single step and then evicting the real administrators. That hole is now closed: each administrator record carries a number saying how far it sits from the group's founder, and every appointment must be signed by someone strictly closer. Review the schema change, the writer, and the attack-shape tests.
files: schemas/strand.qsql, packages/quereus-plugin-sereus/src/strand-schema.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/test/strand-membership-peer-rotation.spec.ts, packages/quereus-plugin-sereus/test/e2e/strand-schema.e2e.spec.ts, docs/strands.md, docs/architecture.md, tickets/fix/bug-control-ownerkey-self-authorization.md
----

# Review: generation column closes same-transaction mutual promotion in `Strand.Manager`

## What landed

`Strand.Manager` gained a `Generation integer not null` column and its `Authorized`
constraint was restructured from three branches into four:

- **Bootstrap** (insert): unchanged founding-state gates, plus `new.Generation = 0`.
- **Self-resignation** (delete): unchanged.
- **Promotion** (insert, new shape): the authorizer must be a `Manager` row with
  `A.Generation < new.Generation` (strictly smaller), and the signature now covers
  `new.MemberKey || '|' || new.Generation` — the generation is inside the signed payload.
- **Removal by another manager** (delete, split out): keeps the old bare-key payload
  `digest(old.MemberKey)` and deliberately has **no** generation condition, so a
  later-generation manager can still remove an earlier-generation one.

Why this closes the hole: the deferred CHECK still sees same-transaction sibling rows as
"existing" managers, but among any set of rows inserted in one transaction, the
minimum-generation row cannot find an authorizer of strictly smaller generation among its
siblings — so its authorizer must pre-date the transaction and have genuinely signed.
Mutual pairs, rings of any length, equal generations, and below-zero generations all die
on this. The old `<>` self-promotion guard is subsumed but kept for local clarity.

Writer changes (`strand-membership-writer.ts`):
- `insertFounderManagerIfAbsent` seats the founder at generation 0 (literal in SQL).
- `addManager` reads the authorizer's generation (`db.get` single-key lookup), seats the
  new manager at that value + 1, and signs `` `${newManagerKey}|${generation}` ``. A
  missing authorizer row falls back to generation 1 **without throwing** — the schema is
  deliberately the rejector (three existing specs pin that).
- `removeManager` unchanged in behavior; doc comments on all three refreshed.

Both schema copies edited together; the drift guard
(`quereus-plugin-sereus/test/strand-schema-drift.spec.ts`) passes. The `OPEN HOLE`
comment is gone from both. Raw-SQL `Manager` inserts in the two spec files got the
`Generation` column (0 for bootstrap cases; 1 for the wrong-key signature-binding case,
whose signed payload was updated to the new `key|generation` shape).

## Test coverage added (the reviewer's floor)

New `Manager.Generation ordering` describe in
`cadre-core/test/strand-membership-peer-rotation.spec.ts` (11 tests), all against a real
closed strand DB via `connectToStrand` bootstrap mode:

- mutual pair in one txn (gens 5/3) → rejected, only founder remains
- the full measured takeover — mutual pair **plus** founder eviction in one txn →
  rejected, founder intact (this exact transaction **committed** pre-fix)
- three-key ring → rejected; equal generations → rejected; generations below 0 → rejected
- stranger claiming generation 0 post-bootstrap → rejected `/Authorized/`
- founder promoting at generation 5 (gap, not +1) → accepted; at generation 0 (≤ its own)
  → rejected — pins that the *ordering* is enforced, not successor adjacency
- a founder signature over `key|1` replayed at generation 2 → rejected; same signature at
  generation 1 → accepted — pins the payload binding
- founder→A→B chained promotion → generations 0/1/2 — exercises `addManager`'s lookup
  with a **non-founder** authorizer (no other test does)
- B (gen 2) removes A (gen 1) → accepted — pins "generation is not privilege" on delete

Also: shared `inTransaction` helper extracted (the sole-manager swap test now uses it).
Everything previously pinned stays green: 54 files / 772 tests pass in cadre-core;
lint and repo-wide `yarn typecheck` clean.

## Validation commands run

- `yarn workspace @serfab/cadre-core test` — 772 passed, 1 skipped (pre-existing skip)
- `yarn workspace @serfab/quereus-plugin-sereus test` — 56 passed; **4 failed, all in
  `test/e2e/networked.e2e.spec.ts > connectToStrand (networked e2e)`** — that exact
  file/describe is listed in `tickets/.pre-existing-known.md` (blocked on
  `control-db-convergence-optimystic-p2p`); failures are optimystic table-init
  (`membership-not-admitted:low-confidence-downsize`), not schema. Re-ran
  `strand-schema.e2e.spec.ts` standalone: 6/6 pass.
- `yarn lint`, `yarn typecheck` — clean.
- Note: cadre-core tests consume the plugin's **built dist**, so schema edits need
  `yarn workspace @serfab/quereus-plugin-sereus build` first (done; dist is untracked).

## Honest gaps / judgment calls for the reviewer

- **Networked-mode behavior is unvalidated.** All new tests run in bootstrap mode; the
  networked path is blocked by `control-db-convergence-optimystic-p2p`. Two things to
  re-examine when it clears: (1) `addManager`'s generation lookup is a single-key point
  seek, and networked seeks have missed for existing rows before (see the `NOTE:`
  tripwire at the lookup in `strand-membership-writer.ts`) — a miss is an availability
  failure (spurious rejection), never a security one; (2) the integration scenario
  `strand-membership-closed-strand-e2e.integration.ts` calls `addManager` and should just
  work, but hasn't run.
- **Docs deviation, deliberate:** the ticket said to leave the signature-replay gap
  bullet in `docs/strands.md` "intact", but its old wording ("both sign the same
  payload") became false once the insert payload gained the generation. The bullet was
  amended to describe the narrowed gap (removal replay still possible; add-as-remove
  replay closed) rather than left inaccurate. `bug-strand-manager-authority-antireplay`
  (backlog) remains open.
- **Existing rows have no migration.** No deployed strand data exists yet ("no backwards
  compat yet" per project rules), so a pre-fix `Manager` row without `Generation` is not
  handled anywhere. If any long-lived dev strand persists storage, its Manager writes
  will fail post-upgrade — expected, not handled.
- **Generation values are attacker-chosen integers** (only the ordering is enforced), so
  a manager can seat someone at generation 1,000,000. Harmless under the threat model —
  generation grants no power and never needs to be dense — but a reviewer should confirm
  they agree there is no overflow/exhaustion angle worth a guard (Quereus integers are
  not 32-bit).
- **`bug-control-ownerkey-self-authorization`** (`tickets/fix/`) got a pointer appended:
  probe same-transaction *mutual* authorization there too, and port this generation
  mechanism if it reproduces — the `<>`-style fix alone will not close the mutual variant.
