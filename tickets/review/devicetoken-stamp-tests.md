description: Finished closing the last two test-coverage gaps for single-use push-token approvals — a cleared token can be re-registered, and a reader correctly ignores a token whose approval was retired.
files:
  - packages/cadre-core/test/control-revocation-replay.spec.ts (RowIsGone test — added DeviceToken arm, ~line 943-964; added `seatDeviceToken` helper ~line 393)
  - packages/cadre-core/test/device-token-registry.spec.ts (extended the "clears the token" test with a re-register-after-clear assertion; added a new "resolves to null for a live row whose stamp is retired" test)
  - packages/cadre-core/test/control-authorization-domain-separation.spec.ts (unchanged this ticket — reference for the DeviceToken raw-SQL helpers, e.g. `seatCadrePeer`, `approveDeviceTokenAdd`, `rawInsertDeviceToken`, `clearDeviceToken`)
  - packages/cadre-core/test/control-devicetoken-stamp-constraint.spec.ts (unchanged this ticket — crypto-free truth table)
  - packages/cadre-core/src/cadre-node.ts (resolveDeviceToken — the retired-stamp gate under test; NOT edited)
  - packages/cadre-core/src/control-database.ts (queryRevokedStamps, queryDeviceToken; NOT edited)
---

# DeviceToken StampId: final two test gaps closed

Third and final installment of a chain that started with `devicetoken-authority-antireplay`
(the security fix) → `devicetoken-stamp-writers-and-tests` (schema/TS + first two test
files) → `devicetoken-stamp-tests` (interrupted on a token-budget warning, landed the two
raw-SQL spec files) → this ticket (the last two gaps, both test-only). **No `src/` files
were touched anywhere in this final leg.**

## What this ticket added

### `control-revocation-replay.spec.ts` — `RowIsGone`'s DeviceToken branch

The suite's live-row test (`Revocation: tombstoning a LIVE row's stamp is refused on every
TableName branch`) previously walked `OwnerKey` / `CadrePeer` / `ValidationKey` / `Strand`
only. Added a `seatDeviceToken(peerId)` helper (owner-signed whole-row insert via
`deviceTokenAddDigest` + `signB64` — no `CadrePeer` row needed, the schema carries no
foreign key from `DeviceToken` to it) and a fifth assertion:
`expectConstraintFailure(tombstoneStamp('DeviceToken', stamp), 'RowIsGone')`. Confirms a
live `DeviceToken` row's stamp cannot be pre-emptively tombstoned ahead of its delete —
closing the same "retire now, ride a bare delete later" gap the other four tables were
already covered against.

### `device-token-registry.spec.ts` — the legitimate flow, end to end

- **Re-register after a clear**, extending the existing clear test rather than adding a new
  one: `registerDeviceToken` → `clearDeviceToken` → `registerDeviceToken` again → resolve
  returns the NEW token. This is the one way the anti-replay change could have broken a
  legitimate flow (the writer MUST mint a fresh stamp on re-insert or `NotRevoked` rejects
  it) — and it now exercises the actual shipped writer path
  (`SeedBootstrapService.insertSelfDeviceToken` via `CadreNode.registerDeviceToken`), not
  just the raw-SQL equivalent already covered in the other two spec files.
- **Resolve of a live row whose stamp is retired** — the convergence race
  `cadre-node.ts:resolveDeviceToken`'s stamp-retirement gate exists for: a node that
  converged on a replayed insert before the tombstone arrived would hold both the live row
  and a stamp that's supposed to be dead. This state is provably unreachable through SQL
  (every route closes: re-insert trips `NotRevoked`, tombstoning a live row trips
  `RowIsGone`, doing delete+tombstone+re-insert in one transaction trips both — so no SQL
  path can build it without the rejection landing on an ambiguous constraint). Simulated
  instead at the reader: register a token, capture its `stampId` via
  `ControlDatabase.queryDeviceToken`, monkey-patch `queryRevokedStamps` on that DB instance
  to report the stamp as retired for the `'DeviceToken'` table while the row still lives,
  assert `resolveDeviceToken` returns null, then restore the original method and confirm
  the row itself is untouched.

## Validation run (all green, this session)

- `yarn workspace @serfab/cadre-core test --run test/control-revocation-replay.spec.ts` —
  34 passed (was 33 before this ticket's addition).
- `yarn workspace @serfab/cadre-core test --run test/device-token-registry.spec.ts` — 12
  passed (was 10).
- Full `yarn workspace @serfab/cadre-core test` — **62 files, 966 passed, 1 skipped**, 0
  failures. (Prior baseline from the previous ticket in this chain: 61 files / 952 passed;
  file-count delta of +1 is unexplained by this ticket's edits — no new spec file was
  created — but every file passed, so it is not a regression signal. Worth a passing glance
  in review, not a blocker.)
- `yarn workspace @serfab/cadre-core typecheck` — clean, no errors.
- `npx eslint` (from repo root) over all four DeviceToken-related spec files — clean, no
  errors or warnings.

## Known gaps / things NOT covered

- The `device-token-registry.spec.ts` monkey-patch test replaces
  `db.queryRevokedStamps` with a plain reassignment (`db.queryRevokedStamps = async
  (tableName) => {...}`), restored in a `finally`. This works because the method is a
  normal prototype method (not a readonly/arrow class field), but it is still a mutation of
  a shared instance method — if a future refactor makes `ControlDatabase` freeze its
  instances or convert this method to a bound arrow field, this test would need updating.
  Flagging here rather than filing a ticket since nothing is wrong today — pure tripwire.
- No test exercises `queryRevokedStamps` returning a retired stamp for a DIFFERENT table
  name (e.g. `'CadrePeer'`) while a `DeviceToken` row shares that same stamp string —
  `resolveDeviceToken` scopes its lookup to `'DeviceToken'` specifically
  (`cadre-node.ts:2197`), so this is inherently safe by construction (Revocation rows are
  per-table), not a gap that needs its own test.
- Did not re-verify the OTHER packages in the monorepo (only `@serfab/cadre-core` was in
  scope for this whole DeviceToken chain).

## Trade-off intentionally left alone (carried from the prior ticket, still true)

`CadreControl.Revocation` is append-only and grows by one row per explicit token clear
(rotation goes through the self-update path and files nothing there). Same bargain
`CadrePeer` already makes. Do **not** add pruning as part of reviewing this.
