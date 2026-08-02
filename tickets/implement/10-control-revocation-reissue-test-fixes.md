----
description: Finish the test suite for the revocation re-issue feature: three small known test fixes, then a full validation run and the review handoff — once the storage-engine bug that falsely rejects counter updates is fixed upstream.
prereq: revocation-reissue-same-pk-update-unique-collision
files: packages/cadre-core/test/control-revocation-replay.spec.ts, packages/cadre-core/test/control-stream-authorization.spec.ts (~140-182), packages/cadre-core/test/membership-connection-gater.spec.ts (~100-140), packages/cadre-core/test/control-revocation-reissue.spec.ts, packages/cadre-core/test/cadre-node-authorized-surface.spec.ts, packages/cadre-core/test/control-constraint-helpers.ts
difficulty: medium
----
## State — most of the test work is DONE and in the working tree

Continuation of `control-revocation-reissuable-tombstone-tests` (third run). All edits
below landed this run and pass `yarn typecheck` + `yarn lint` (lint runs from repo root:
`yarn lint packages/cadre-core/test` — the package has no lint script). Do NOT redo them:

- `control-constraint-helpers.ts`: shared signing fixtures lifted from the replay spec
  (`KeyPair`, `freshKeyPair`, `freshStamp`, `signAs`, `signB64`, `revocationMessage`) plus
  new `reissueMessage` (the 'reissue' digest; `String(reissuedAt)` pairs with the schema's
  `cast(... as text)`).
- `control-revocation-replay.spec.ts`: imports the lifted helpers (local copies deleted);
  header names the new constraint set and records the spec split; old "Immutable" test
  replaced by single-rejector probes for `NoDelete` / `ReissueOnly` / `AuthorizedReissue`;
  section comment updated. All probes key on `StampId` alone (composite-PK point-lookup
  hazard).
- `cadre-node-authorized-surface.spec.ts`: `inject()`'s fake `queryCadrePeers` now
  PRE-FILTERS revoked stamps (mirrors the real `ControlDatabase.queryCadrePeers`
  contract); the retired-voucher test asserts the peer is on NEITHER surface
  (`isMember` → false); header documents the inherited filter. This file is GREEN.
- NEW `control-revocation-reissue.spec.ts`: 9 tests — happy-path bump, identity frozen,
  monotonic counter, authorization (wrong digest / non-owner), owner-signed `NoDelete`,
  `FreshTombstone`, `reissueRevocations` batch + rollback, production removal read paths,
  planted-at-retired-stamp read paths (via the `queryRevokedStamps` wrap pattern from
  `device-token-registry.spec.ts` ~294-311).

`yarn test` result this run: 7 failures / 4 files, 1359 passed. Four failures are the
engine defect the prereq ticket covers (counter-only same-PK updates on `Revocation`
falsely die with `UNIQUE constraint failed` — including the reissue spec's happy path and
batch test). The remaining three are the known fixes below.

## TODO — three known test fixes

- `control-revocation-replay.spec.ts`, permanence test, third probe (the unsigned
  counter-only bump expecting `AuthorizedReissue`): it currently runs
  `update ... set ReissuedAt = 1 where StampId = ?` with NO `with context` clause, which
  errors with `context.OwnerKey isn't a column` instead of failing the CHECK. "Unsigned"
  in these suites means a PRESENT context clause with null values — mirror the
  `rawTombstone(null, null, ...)` pattern: add
  `with context OwnerKey = ?, Signature = ?` binding `[null, null, 1, orphan]`.
  (Note: until the prereq engine fix lands, this probe will then hit the false UNIQUE
  error instead — that is the prereq's problem, not a reason to reshape the probe.)

- `control-stream-authorization.spec.ts` (~180) and `membership-connection-gater.spec.ts`
  (~138): both have a test "denies a member whose StampId is retired in Revocation, still
  admitting its live sibling" that now fails (expects deny, gets admit). Their fakes hand
  the node an UNFILTERED member list plus a revoked set, relying on the node-level
  filtering that this feature deliberately removed — the filter now lives in
  `ControlDatabase.queryCadrePeers`. Fix exactly as done in
  `cadre-node-authorized-surface.spec.ts` `inject()`: make the fake `queryCadrePeers`
  pre-filter rows whose `stampId` is in the revoked set (keep `queryRevokedStamps` on the
  fake — it models the DB surface and `resolveDeviceToken` still calls it), and keep/adjust
  the test's intent: the retired member is denied because the membership read never
  surfaces it.

## Validation

From `packages/cadre-core`: `yarn test 2>&1 | tee /tmp/cadre-core.log` (stream, never
silent-redirect), `yarn typecheck`; from repo root: `yarn lint packages/cadre-core`.
Do NOT run the integration suite (belongs to `control-revocation-drain-on-growth`;
several scenarios already failing upstream — see `tickets/.pre-existing-known.md`).

## Handoff

On completion write the review/ ticket for the WHOLE feature (schema + database + read
paths + tests), noting the review stage should treat the original ticket
`control-revocation-reissuable-tombstone` (deleted; see git history at commits
d1aac1c / a0b0f82 / 4d470e1) as the spec, and that the engine defect was found by these
tests and resolved via `revocation-reissue-same-pk-update-unique-collision`.
