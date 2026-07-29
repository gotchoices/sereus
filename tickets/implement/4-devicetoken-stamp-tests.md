description: Push-token approvals were just made single-use in the database rules and the code that reads and writes them, but the test suite has not yet been extended to prove the three attacks this closes are actually rejected.
files:
  - packages/cadre-core/src/control-schema.ts (DeviceToken block :329-409 — DONE, do not re-edit)
  - schemas/control.qsql (byte-identical twin — DONE, do not re-edit)
  - packages/cadre-core/src/peer-authorization.ts (deviceTokenAddDigest / deviceTokenRemoveDigest — DONE)
  - packages/cadre-core/src/seed-bootstrap.ts (insertSelfDeviceToken / deleteDeviceToken — DONE)
  - packages/cadre-core/src/cadre-node.ts (resolveDeviceToken retired-stamp gate — DONE)
  - packages/cadre-core/test/control-cadrepeer-voucher-constraint.spec.ts (pattern for the new crypto-free spec)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts (DeviceToken case at :299; tombstoneStamp at :99; inTransaction at :78)
  - packages/cadre-core/test/control-revocation-replay.spec.ts (live-row RowIsGone test at :921)
  - packages/cadre-core/test/device-token-registry.spec.ts (end-to-end register/resolve/clear)
difficulty: medium
---

# DeviceToken StampId: the remaining test coverage

Continuation of `devicetoken-stamp-writers-and-tests`, which stopped on a token-budget
warning after finishing the code. **All schema and TypeScript work is done, typechecks,
lints, and the specs it touched pass.** What remains is test coverage only — nothing in
`src/` should need to change.

## What landed already (do not redo)

- `DeviceToken.StampId text not null unique`, `NotRevoked` (insert), `RevocationRecorded`
  (delete); `AuthorizedInsert` binds the whole row, `AuthorizedDelete` binds
  `(old.PeerId, old.StampId)`, `AuthorizedUpdate` keeps only the peer self-update branch
  (owner re-touch removed) and requires `new.StampId = old.StampId`.
- `deviceTokenAddDigest(row)` now takes a whole-row struct
  (`DeviceTokenAuthorizedRow`: peerId, platform, token, updatedAt|null, sig|null, stampId)
  rather than a bare peer id; `deviceTokenRemoveDigest(peerId, stampId)`.
- `'DeviceToken'` added to the `RevocableTable` union.
- `queryDeviceTokenStampId(peerId)`; `queryDeviceToken` now returns `DeviceTokenRow`
  (`DeviceTokenRecord` + `stampId`). `DeviceTokenRecord` was deliberately left alone —
  it is the shape the peer's self-`Sig` covers, and the stamp is not in that signature.
- `insertSelfDeviceToken` mints a fresh stamp per insert; `deleteDeviceToken` reads the
  stamp, early-returns when the row is absent, and commits the delete + the `Revocation`
  tombstone in one transaction (each separately owner-signed), copying `removePeer`.
- `resolveDeviceToken` drops a row whose stamp appears in
  `queryRevokedStamps('DeviceToken')`, with the `NOTE:` recording that the freshness
  ceiling is infinite by design so stamp retirement is the only thing that retires a
  cleared token.

Two tests were updated only as far as keeping them honest: the domain-separation
`DeviceToken` case (new column + new digests + tombstone inside `inTransaction`), and
`control-revocation-replay.spec.ts`'s out-of-set `TableName` example, which now uses
`'FormationInvite'` because `'DeviceToken'` became a valid `RowIsGone` branch.

## Validation already run

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `npx eslint "packages/cadre-core/src/**/*.ts" "packages/cadre-core/test/**/*.ts"` — clean.
  (Note: there is no `yarn lint` script in the root `package.json` despite AGENTS.md;
  invoke eslint directly, from the repo root, or the config is not found.)
- `yarn workspace @serfab/cadre-core test --run test/device-token-registry.spec.ts
  test/control-authorization-domain-separation.spec.ts test/control-revocation-replay.spec.ts
  test/control-schema-drift.spec.ts` — 52 passed.

**The FULL `@serfab/cadre-core` suite was never run for this change.** Run it first; if
something outside those four specs broke, it is more likely mine than pre-existing.

## Remaining work

### New crypto-free constraint spec

`packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts`, built exactly
like `control-cadrepeer-voucher-constraint.spec.ts`: a minimal `Probe` schema carrying
only the non-crypto predicates, with a direct truth table. Needs a bare `Revocation`
table in the probe schema (no constraints of its own) so the tombstone can be filed.
Cover: fresh insert admitted; duplicate `StampId` refused; bare delete refused
(`RevocationRecorded`); delete + tombstone in one transaction admitted; re-insert naming
the retired stamp refused (`NotRevoked`); re-insert with a fresh stamp admitted; update
rotating `StampId` refused; update leaving it alone admitted.

### The three reproduced attacks, in `control-authorization-domain-separation.spec.ts`

Each asserted through `expectConstraintFailure` **by constraint name**. Keep the
single-rejector discipline that file's helper documents — arrange every write so exactly
one constraint can fail.

- **A — the approval no longer authorizes any row but the one it approved.** The owner
  signs an approval for `(peerId, 'fcm', 'tok-good', stamp)`; the write presents
  `(peerId, 'apns', 'tok-evil', stamp)` instead → rejected (`AuthorizedInsert`, the
  digest no longer matches). Do this on a FIRST insert with a fresh stamp, not after a
  delete: post-delete, `NotRevoked` would also be violated and which name Quereus
  reports becomes ambiguous.
- **B — retirement kills the exact row too.** Insert, then delete + tombstone in one
  transaction, then replay the *exact* approved row → rejected (`NotRevoked`).
- **C — there is no owner update branch any more.** An owner-signed update (owner context
  + owner signature, monotonically higher `UpdatedAt`) is rejected outright
  (`AuthorizedUpdate`).

### Optional, cheap: `control-revocation-replay.spec.ts:921`

The live-row `RowIsGone` test walks every guarded table; the `DeviceToken` arm of that
constraint currently has no coverage. Seating a live `DeviceToken` row there needs only
an owner-signed whole-row insert (no `CadrePeer` row — the schema has no FK), with
`UpdatedAt`/`Sig` null signing as `''`.

### `device-token-registry.spec.ts` — the legitimate-flow proof

It drives everything through the `CadreNode` API so it needs no SQL edits, but it is the
only end-to-end check that register → resolve → clear → **re-register** still works. The
re-register-after-clear case is the one way this change could break a legitimate flow
(a fresh stamp must be minted, or `NotRevoked` rejects it) and **it is not covered
today** — the existing clear test stops at "resolve is null". Add it.

Worth adding alongside: a resolve of a row whose stamp is retired but whose row is still
present (the convergence race the read-side gate exists for). Constructing it means
filing the tombstone without the delete, which `RowIsGone` refuses while the row lives —
so either delete-and-reinsert-with-the-same-stamp via raw SQL, or assert the gate at the
`ControlDatabase` level instead of through the node.

### Validation

`yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (stream it),
plus `yarn workspace @serfab/cadre-core typecheck` and eslint from the repo root.

## Trade-off to leave alone

`Revocation` is append-only and grows by one row per explicit token clear (rotation goes
through the self-update path and files nothing). Same bargain `CadrePeer` already makes.
Do **not** add pruning here.
