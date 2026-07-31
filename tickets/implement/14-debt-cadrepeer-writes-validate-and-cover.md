---
description: The party-member table's last two direct database writes were just moved behind the single API that does the security bookkeeping, and a lint rule now blocks the direct route — but the test suite has not been run since, and two small tests the move needs are still unwritten.
files:
  - packages/cadre-core/src/control-database.ts (new `insertCadrePeer` / `reauthorizeCadrePeer` — already written)
  - packages/cadre-core/src/seed-bootstrap.ts (`insertCadrePeerRow` / `reauthorizePeer` now thin wrappers — already written)
  - eslint.config.mjs (new `no-restricted-syntax` block + exemptions — already written)
  - packages/cadre-core/test/seed-bootstrap.spec.ts (add the two error-precedence tests here, beside the existing `describe('removePeer')` at ~line 991)
  - packages/cadre-core/test/control-membership-hub.spec.ts, packages/cadre-core/test/control-write-lock.spec.ts, packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-authorization-domain-separation.spec.ts (existing coverage that must stay green)
difficulty: easy
---

# Validate the CadrePeer write consolidation, and add the two missing tests

## What already landed (do not redo)

The code half of `debt-cadrepeer-writes-behind-control-database` is written and in the
working tree. `yarn workspace @serfab/cadre-core typecheck` and `yarn lint` both pass.
What is present:

- `ControlDatabase.insertCadrePeer(row, ownerKey, signMessage)` and
  `ControlDatabase.reauthorizeCadrePeer(peerId, updatedAt, ownerKey, signMessage)`, sitting
  just above `deleteCadrePeer`. Both build their digest with `buildAuthorizationMessage`
  (raw bytes, no `peer-authorization.ts` import), wrap `mutateCadrePeer`, and use bare
  `this.db!.exec` inside the lock (never `execWrite` — the lock is not re-entrant).
  `reauthorizeCadrePeer` reads the stamp BEFORE the lock and returns `false` without
  notifying when no row exists. The security-rationale comments moved with the code.
- `SeedBootstrapService.insertCadrePeerRow` and `reauthorizePeer` are now thin delegating
  wrappers. Error precedence is preserved: the insert path checks the control database
  first and the owner key second; the re-touch path checks the owner key first (via
  `requireOwnerPublicKey`, which calls `requireOwnerPrivateKey` first) and the database
  second. `removePeer` is untouched.
- The now-unused `cadrePeerVoucherDigest` import was dropped from `seed-bootstrap.ts` and
  the one remaining doc reference to it reworded.
- `eslint.config.mjs` has a `no-restricted-syntax` block matching literal
  `insert into` / `update` / `delete from` against `CadreControl.CadrePeer`, in both
  plain-string (`Literal`) and template (`TemplateElement`) form, case-insensitive; plus a
  later `files:`-scoped override turning it off for `control-database.ts` and the two
  raw-SQL constraint fixtures. Each exemption is commented with its reason.
- Docs updated: `docs/architecture.md` (the write-serialization paragraph, and the
  write-while-alone bullet naming `reauthorizePeer`), `docs/STATUS.md` (a new bullet under
  "Lint coverage" describing the rule), and the `{@link}` in `peer-authorization.ts`'s
  `verifyCadrePeerVoucher`. `docs/STATUS.md`'s digest description needed no change.

## What is left

### Run the tests

Nothing in `cadre-core`'s suite has been run against these edits. Stream output so the
runner's 10-minute idle timer does not expire (`2>&1 | tee`). At minimum:

- `seed-bootstrap.spec.ts` — the authorize→remove→re-authorize round trip against a real
  control database (~line 1026) and the existing `removePeer` precedence tests (~line 991).
- `control-membership-hub.spec.ts` — pins the notify contract and the verbatim reason
  labels `'peer-insert'` / `'peer-reauthorize'` / `'peer-remove'` (which the moved code
  keeps). Line 134-142 is already the "absent row on re-touch must not notify" case.
- `control-write-lock.spec.ts` (~lines 146-190) — the insert-race orderings, both ways.
- `control-revocation-replay.spec.ts` and
  `control-authorization-domain-separation.spec.ts` — the raw-SQL constraint fixtures, to
  confirm the shared `deleteGuardedRow` path was not perturbed and that a row vouched
  through the relocated raw-bytes digest still verifies.

Then the whole `cadre-core` suite, and `yarn build`.

### Write the two error-precedence tests

`seed-bootstrap.spec.ts` currently covers precedence for `removePeer` only. Add one test
per method, next to that existing `describe('removePeer')`:

- A service built with `{ partyId, ownerPrivateKey }` but no control database, calling
  `authorizePeer` (which reaches `insertCadrePeerRow`), must reject with
  `'Control database not initialized'`; a service built with `{ partyId }` alone and a
  control database attached would reject with `'Owner private key required'` — the
  database check comes first on this path.
- `reauthorizePeer` is the other order: `{ partyId }` with no owner key rejects with
  `'Owner private key required'` even with no control database attached.

Keep them the same shape as the existing `removePeer` pair — a bare `SeedBootstrapService`
and `rejects.toThrow`, no live node.

### Confirm the lint rule actually fires

`yarn lint` currently passes, which proves the rule does not misfire and that the
exemptions cover every existing raw-SQL site. It does NOT prove the rule bites. Paste a
`CadrePeer` insert statement into an unexempted file by hand, confirm `yarn lint` errors
with the intended message, then revert. Do not commit a fixture for it.

## Known state to be aware of

`yarn lint` emits 6 warnings (0 errors) about unused `no-console` eslint-disable
directives in `packages/integration-tests/src/scenarios/zz-scratch-delete-alone.integration.ts`.
Pre-existing, unrelated to this work, and warnings do not fail the gate — but
`docs/STATUS.md` claims the gate exits with 0 warnings, so that file or that claim is
stale. Not this ticket's job to resolve; mention it in the handoff.

## TODO

- Add the two error-precedence tests to `seed-bootstrap.spec.ts`.
- Run the `cadre-core` unit suite and `yarn build`, streaming output with `tee`.
- Verify by hand that the new lint rule errors on a deliberately misplaced `CadrePeer`
  insert, then revert that edit.
- Hand off to `review/`, stating whether the lint rule was seen to fire.
