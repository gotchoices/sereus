description: Two small gaps remain in the test coverage for single-use push-token approvals — proving a cleared token can be registered again afterwards, and proving a reader ignores a token whose approval was retired.
files:
  - packages/cadre-core/test/control-revocation-replay.spec.ts (live-row RowIsGone test at :921 — add the DeviceToken arm)
  - packages/cadre-core/test/device-token-registry.spec.ts (end-to-end register/resolve/clear via CadreNode)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts (DONE — reference for the DeviceToken raw-SQL helpers)
  - packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts (DONE — crypto-free truth table)
  - packages/cadre-core/src/cadre-node.ts (resolveDeviceToken — the retired-stamp gate under test; do not edit)
  - packages/cadre-core/src/control-database.ts (queryRevokedStamps :503, queryDeviceToken :575)
difficulty: easy
---

# DeviceToken StampId: the last two test gaps

Continuation of `devicetoken-stamp-tests`, which stopped on a token-budget warning. All
schema and TypeScript work landed two tickets ago; two of the four test items landed here.
**Nothing in `src/` should need to change.**

## What landed already (do not redo)

- `packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts` — new crypto-free
  probe schema (bare `Revocation` + a `DeviceToken` carrying only `NotRevoked`,
  `RevocationRecorded`, and the non-crypto half of `AuthorizedUpdate`, named `Immutable`
  there). 10 tests: fresh insert admitted; duplicate live stamp refused; bare delete
  refused; delete whose tombstone names the wrong stamp refused; delete + tombstone in one
  transaction admitted; re-insert on the retired stamp refused; re-insert on a fresh stamp
  admitted; update rotating the stamp refused; update rolling `UpdatedAt` backwards
  refused; rotation keeping the stamp admitted. **Green.**
- `control-authorization-domain-separation.spec.ts` — the three attacks, each pinned by
  constraint name: approval presenting a row other than the one approved
  (`AuthorizedInsert`); approval replayed after the clear (`NotRevoked`), plus the
  fresh-stamp re-register that must still work; owner-signed update refused outright
  (`AuthorizedUpdate`), with a real `CadrePeer` row seated so the rejection is the absent
  owner branch rather than a missing peer row, and the peer's own self-update accepted
  afterwards as the positive control. Reusable helpers now live in that file's `describe`:
  `seatCadrePeer`, `approveDeviceTokenAdd`, `rawInsertDeviceToken`, `rawDeleteDeviceToken`,
  `clearDeviceToken`, `deviceTokenRow`. **Green (9 tests).**

## Validation already run

- Full `@serfab/cadre-core` suite BEFORE these test edits: 61 files, 952 passed, 1 skipped.
  So nothing was broken at HEAD.
- `yarn workspace @serfab/cadre-core test --run test/control-devicetoken-stamp-constraint.spec.ts`
  — 10 passed.
- `yarn workspace @serfab/cadre-core test --run test/control-authorization-domain-separation.spec.ts`
  — 9 passed.
- The full suite has NOT been re-run since those two files changed, and eslint/typecheck
  have not been run over them. Do that first — the changes are test-only and both files
  pass in isolation, so a surprise elsewhere is unlikely but unverified.

Note on the environment: the linked `../quereus` workspace is a live sibling repo and is
sometimes rebuilt by a concurrent process. A run that fails with
`Cannot find module '../../common/types.js'` or `Failed to resolve entry for package
"@quereus/quereus"` across dozens of unrelated spec files is that rebuild landing
mid-run — compare `dist` file mtimes against the run's start time and re-run rather than
chasing it. Also: there is no `yarn lint` script in the root `package.json` despite
AGENTS.md; invoke `npx eslint "packages/cadre-core/test/**/*.ts"` from the repo root, or
the config is not found.

## Remaining work

### `control-revocation-replay.spec.ts:921` — the DeviceToken arm of `RowIsGone`

The live-row test (`Revocation: tombstoning a LIVE row's stamp is refused on every
TableName branch`) walks `OwnerKey` / `CadrePeer` / `ValidationKey` / `Strand`. The
`DeviceToken` branch of that constraint has no coverage. Seating a live `DeviceToken` row
in that fixture needs only an owner-signed whole-row insert (no `CadrePeer` row — the
schema has no foreign key), with `UpdatedAt` / `Sig` null signing as `''`; that file
already imports `signB64` and `expectConstraintFailure`, and needs `deviceTokenAddDigest`
added to its `peer-authorization.js` import. Then
`await expectConstraintFailure(tombstoneStamp('DeviceToken', stamp), 'RowIsGone')`.

### `device-token-registry.spec.ts` — the legitimate flow, end to end

This spec drives everything through the `CadreNode` API, so it needs no SQL.

- **Re-register after a clear.** The one way this change could break a legitimate flow: the
  writer must mint a FRESH stamp on the re-insert, or `NotRevoked` rejects it. The existing
  clear test stops at "resolve is null". Extend the flow to
  `registerDeviceToken` → `clearDeviceToken` → `registerDeviceToken` again → resolve
  returns the NEW token. The SQL-level equivalent is already covered in both specs above,
  but not the shipped writer path (`seed-bootstrap.ts:insertSelfDeviceToken`).
- **Resolve of a live row whose stamp is retired.** This is the convergence race the
  read-side gate in `cadre-node.ts:resolveDeviceToken` exists for: a node that converged on
  a replayed insert before the tombstone arrived holds both rows. **That state cannot be
  built through SQL, by design** — every route is closed. Re-inserting the retired stamp
  trips `NotRevoked`; filing the tombstone while the row lives trips `RowIsGone`; doing
  delete + tombstone + re-insert in ONE transaction trips both, so a rejection could not be
  pinned to either. So simulate it at the reader instead: register a token normally, read
  its `stampId` (`ControlDatabase.queryDeviceToken` returns it), then replace
  `queryRevokedStamps` on that `ControlDatabase` instance with a wrapper that adds the
  stamp to the `'DeviceToken'` set, and assert `node.resolveDeviceToken(peerId)` is null
  while the row is still present. Restore the method afterwards and say in a comment why
  the patch is there rather than a real divergent database.

### Validation

`yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (stream it —
the suite takes ~65s), plus `yarn workspace @serfab/cadre-core typecheck` and eslint over
`packages/cadre-core/test/**/*.ts` from the repo root.

## Trade-off to leave alone

`Revocation` is append-only and grows by one row per explicit token clear (rotation goes
through the self-update path and files nothing). Same bargain `CadrePeer` already makes.
Do **not** add pruning here.
