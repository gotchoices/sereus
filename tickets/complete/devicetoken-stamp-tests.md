---
description: Closed the last two test-coverage gaps for single-use push-token approvals, and brought the design docs in line with the security change the whole chain landed.
files:
  - packages/cadre-core/test/control-revocation-replay.spec.ts (DeviceToken arm of the live-row tombstone test; `rawInsertDeviceToken` + `seatDeviceToken` helpers)
  - packages/cadre-core/test/device-token-registry.spec.ts (re-register-after-clear assertions; retired-stamp read-gate test)
  - docs/architecture.md (control-table table: `DeviceToken` + `Revocation` rows; the peer-startup walkthrough's resolve-gate list)
  - docs/STATUS.md (device-token registry bullet: single-use approvals + where they are covered)
  - packages/cadre-core/src/cadre-node.ts (resolveDeviceToken — the gate under test; NOT edited)
  - packages/cadre-core/src/control-database.ts (queryRevokedStamps / queryDeviceToken; NOT edited)
  - packages/cadre-core/src/control-schema.ts, schemas/control.qsql (Revocation.RowIsGone DeviceToken branch; NOT edited)
---

# DeviceToken StampId: final test gaps closed, docs caught up

Last leg of the chain `bug-devicetoken-authority-antireplay` → `devicetoken-authority-antireplay`
(schema) → `devicetoken-stamp-writers-and-tests` (TS writers + first specs) →
`devicetoken-stamp-tests` → this ticket. No `src/` file was touched in this leg; the review
pass added test assertions, one test-helper refactor, one tripwire comment, and doc updates.

## What shipped (implement stage)

- **`control-revocation-replay.spec.ts`** — the live-row test
  (`tombstoning a LIVE row's stamp is refused on every TableName branch`) previously walked
  `OwnerKey` / `CadrePeer` / `ValidationKey` / `Strand`. Added a fifth arm for `DeviceToken`:
  seat an owner-signed row, then assert `tombstoneStamp('DeviceToken', stamp)` fails with
  `RowIsGone`. That covers the last branch of the `Revocation.RowIsGone` check
  (`control-schema.ts:564`), so no table can have its stamp retired ahead of its delete.
- **`device-token-registry.spec.ts`** —
  - clear → re-register round trip through the shipped writer path
    (`CadreNode.registerDeviceToken` → `SeedBootstrapService.insertSelfDeviceToken`), proving
    the anti-replay change did not break logout/login;
  - a reader-level simulation of the convergence race the retired-stamp gate in
    `resolveDeviceToken` exists for: patch `queryRevokedStamps` to report the live row's stamp
    as retired, assert the resolve returns null, restore, assert the row is untouched.

## Review findings

**Checked:** the implement diff read cold first; the `Revocation.RowIsGone` /
`DeviceToken.NotRevoked` / `RevocationRecorded` constraints in `control-schema.ts` against the
new assertions; `schemas/control.qsql` vs `control-schema.ts` for the `DeviceToken` block (in
sync — the only textual difference is backtick escaping inside the TS template literal);
`resolveDeviceToken`'s gate order in `cadre-node.ts`; `queryRevokedStamps` for shared/cached
state the test's patch could corrupt; test-helper conventions in the two edited spec files
against their siblings; every `docs/` file mentioning `DeviceToken`, `Revocation`, or
`StampId`; the skipped test in the suite; and the file-count delta the handoff flagged.

**Minor — fixed in this pass:**
- *Vacuous-pass risk in the retired-stamp test.* It asserted `resolveDeviceToken → null`
  after patching, but never asserted the token resolved **before** patching — any unrelated
  gate failing first (platform, self-sig, membership) would have produced the same null and a
  green test. Added the pre-condition assertion.
- *Re-register test asserted the outcome but not the mechanism.* It checked the new token
  resolves; it did not check the re-insert minted a **fresh** stamp, which is the actual
  anti-replay property. Now captures the pre-clear `StampId` and asserts the re-inserted row's
  differs.
- *`seatDeviceToken` broke the file's helper convention.* `control-revocation-replay.spec.ts`
  splits raw SQL (`rawInsert*` / `rawDelete*`) from sign-and-seat wrappers (`seatStrand`,
  `admitPeer`, …); the new helper inlined its `insert` statement. Split out
  `rawInsertDeviceToken` beside its siblings, and the helper now returns `{ stamp, addSig }`
  like the others.
- *Docs were stale for the whole chain, not just this ticket.* None of the four commits from
  `devicetoken-authority-antireplay` onward touched `docs/`. Fixed:
  `docs/architecture.md` — the `Revocation` row listed four guarded tables, not five;
  the `DeviceToken` row said nothing about the whole-row insert approval, the narrower delete
  approval, or the mandatory stamp retirement; the peer-startup walkthrough listed
  `resolveDeviceToken`'s gates without the retired-stamp one. `docs/STATUS.md` — the
  device-token registry section described the pre-fix authorization model and did not mention
  that the owner re-touch (`vouch`) update branch was removed; added a bullet covering the
  single-use approvals and naming the four spec files that cover them.

**Major — no tickets filed, and why.** Nothing found that warrants one. Two candidates were
considered and rejected on the merits:
- *A real two-node test of the resurrection race, rather than a reader-level simulation.* The
  repo can express disconnect-then-reconnect scenarios
  (`packages/integration-tests/src/scenarios/control-write-while-alone-convergence.integration.ts`),
  but the hazardous state needs a node to converge on the clearing **delete** while *not* yet
  holding the **tombstone** written in the same transaction — i.e. partial delivery of one
  atomic transaction, which the transactor does not do. Every reachable ordering is already
  closed by `NotRevoked` / `RowIsGone` (verified against the constraint text), so the gate is
  belt-and-braces and a reader-level simulation is the honest way to cover it. Nothing to file.
- *`control-revocation-replay.spec.ts` is now ~1270 lines.* Pre-existing, uniformly
  structured (helpers, then one `it` per attack), and splitting it would scatter a shared
  fixture across files for no coverage gain. Not this ticket's debt; left alone.

**Tripwires (recorded, not filed):**
- The retired-stamp test reassigns `queryRevokedStamps` on a live `ControlDatabase` instance.
  Fine today (ordinary prototype method, restored in a `finally`, and the method builds a
  fresh `Set` per call so the patch cannot leak into other reads). `NOTE:` comment parked at
  the patch site in `device-token-registry.spec.ts` saying what breaks it — instance freezing
  or converting the method to a bound arrow field — and that the fix would be an injectable
  revoked-stamp reader.

**Handoff claims verified:**
- The unexplained "+1 test file" the handoff flagged is benign: the preceding commit
  (`13ccb25`) added `control-devicetoken-stamp-constraint.spec.ts`, and the 61-file baseline it
  recorded predates its own new file. 61 → 62 is that file, nothing else.
- The suite's 1 skipped test is `key-store.spec.ts:231`, an `it.skipIf(platform === 'win32')`
  POSIX-permissions check. Pre-existing and platform-conditional, not a disabled test.

## Validation (all green, this session, after the review edits)

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn lint` (repo root, full ESLint gate) — clean.
- `yarn workspace @serfab/cadre-core test --run test/device-token-registry.spec.ts test/control-revocation-replay.spec.ts` — 46 passed (12 + 34).
- `yarn workspace @serfab/cadre-core test` — 62 files, 966 passed, 1 skipped, 0 failed.
- No `tickets/.pre-existing-error.md` written; nothing failed.

Out of scope, unchanged: only `@serfab/cadre-core` was validated for this chain, and
`CadreControl.Revocation` stays append-only (one row per explicit token clear) — the same
bargain `CadrePeer` makes, deliberately not revisited.
