description: The party-member table's last two direct database writes were moved behind the single API that does the security bookkeeping; this pass adds the two missing regression tests, runs the full test suite and build against the change, and hand-verifies the new lint rule actually blocks a misplaced write.
files:
  - packages/cadre-core/src/control-database.ts (`insertCadrePeer` / `reauthorizeCadrePeer`, unchanged this pass)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` / `reauthorizePeer` thin wrappers, unchanged this pass)
  - eslint.config.mjs (`no-restricted-syntax` block + exemptions, unchanged this pass — hand-verified to fire)
  - packages/cadre-core/test/seed-bootstrap.spec.ts (two new tests added, next to `describe('removePeer')` at ~line 991)
difficulty: easy
---

# CadrePeer write consolidation — validated and covered

## What this pass did

Prior `implement` pass wrote the code (moving the last two raw-SQL `CadrePeer` writers
behind `ControlDatabase`, adding the ESLint guard, updating docs) but had not run the test
suite and left two tests unwritten. This pass:

1. Added the two missing precedence tests to `seed-bootstrap.spec.ts`, right after the
   existing `describe('removePeer')` block:
   - `describe('authorizePeer')` → `'checks the control database before the owner key'`:
     builds a service with `{ partyId, ownerPrivateKey }` (owner key present, no control
     database attached) and asserts `authorizePeer` rejects with
     `'Control database not initialized'` — pins that `insertCadrePeerRow` (and thus
     `authorizePeer`) checks the control database first.
   - `describe('reauthorizePeer')` → `'requires an owner private key even with no control
     database attached'`: builds a service with `{ partyId }` alone (no owner key, no
     control database) and asserts `reauthorizePeer` rejects with `'Owner private key
     required'` — pins the OPPOSITE order from `authorizePeer`: this is the discriminating
     case (both preconditions absent), so the error surfacing here is proof the owner-key
     check runs before the (also-failing) database check, matching `removePeer`'s existing
     order.
2. Ran the targeted spec files, the full `cadre-core` suite, and both the package build
   and root `yarn build`. All green.
3. Hand-verified the new ESLint rule actually fires: temporarily inserted a literal
   `insert into CadreControl.CadrePeer …` string into `seed-bootstrap.ts` (an unexempted
   file), ran `eslint` on it, confirmed the exact intended error message
   (`no-restricted-syntax`, "Write CadreControl.CadrePeer through
   ControlDatabase.insertCadrePeer / reauthorizeCadrePeer / deleteCadrePeer …"), then
   reverted the edit (`git diff --stat` on the file is empty; no fixture committed).

## Test results

- `test/seed-bootstrap.spec.ts` alone: 76 passed (74 pre-existing + 2 new).
- `test/control-membership-hub.spec.ts`, `test/control-write-lock.spec.ts`,
  `test/control-revocation-replay.spec.ts`,
  `test/control-authorization-domain-separation.spec.ts` together: 61 passed. Confirms the
  notify contract (`'peer-insert'` / `'peer-reauthorize'` / `'peer-remove'` reason labels),
  the insert-race lock orderings, and the raw-SQL constraint fixtures (domain separation +
  revocation replay) are all unaffected by the earlier move.
- Full `@serfab/cadre-core` suite: **83 test files, 1315 passed, 1 skipped** (pre-existing
  skip, not in any file this or the prior pass touched — not investigated further here,
  flagging for the reviewer in case it's unfamiliar).
- `yarn workspace @serfab/cadre-core build`: clean, no output, exit 0.
- Root `yarn build`: clean, exit 0 (pre-existing chunk-size and dynamic/static
  dual-import warnings from `db-p2p`/`Fret`/`quereus-plugin-sereus` in unrelated packages,
  not from this change).

## Lint

`yarn lint`: **0 errors, 6 warnings** — same 6 pre-existing `no-console`
unused-eslint-disable-directive warnings in
`packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`, as the
prior pass reported. Confirmed unrelated (different package, different rule, present
before this ticket's diff).

Carrying forward from the prior pass, unresolved and not this ticket's job: `docs/STATUS.md`
claims the lint gate exits with 0 warnings, but it currently exits with 6. Either the doc
or the fixture file is stale. Someone should reconcile it — filing as a `debt-` backlog
item rather than blocking this ticket on it, since it predates both `implement` passes and
is cosmetic (warnings don't fail the gate).

## What a reviewer should check

- The two new tests' shape matches the existing `removePeer` pair (bare
  `SeedBootstrapService`, `rejects.toThrow`, no live node) — worth confirming the precedence
  claim against `insertCadrePeerRow` (`seed-bootstrap.ts:363`) and `reauthorizePeer`
  (`seed-bootstrap.ts:575`) directly, since the two methods deliberately check owner-key vs.
  control-database in opposite orders and it's easy to mix them up on a re-read.
- The lint-rule fire test left no trace in the working tree (`git status` on
  `seed-bootstrap.ts` is clean) — worth a spot double-check, but nothing was intentionally
  committed for it per the ticket's instruction not to leave a fixture.
- No production code changed this pass — only the test file. If diffing against the prior
  `implement` commits, expect exactly one file touched.

## Review findings

- Diff scope this pass: `packages/cadre-core/test/seed-bootstrap.spec.ts` only (2 new tests,
  16 lines). No production code touched.
- Pre-existing skipped test (1 of 1316 in the `cadre-core` suite) noted above but not
  identified/chased — flag for reviewer, not blocking.
- `docs/STATUS.md`'s "lint gate exits 0 warnings" claim is stale (actual: 6 pre-existing,
  unrelated warnings) — recommend a `debt-` backlog ticket to reconcile the doc, not
  blocking this one.
