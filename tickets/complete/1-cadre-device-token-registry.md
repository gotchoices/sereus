description: DeviceToken control-network registry (schema + cadre-core read/write API) letting a server cadre peer resolve a mobile peer's FCM/APNs push token for push-wake delivery
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/device-token.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/device-token.spec.ts, packages/cadre-core/test/device-token-registry.spec.ts, docs/architecture.md, docs/STATUS.md

## What shipped

A `DeviceToken` control-network table modeled byte-for-byte on `CadrePeer`, plus the
cadre-core read/write/resolve API. `DeviceToken(PeerId pk, Platform, Token, UpdatedAt, Sig)`:
authority-gated insert/delete (membership vouch), self-signed monotonic update (rotation /
platform switch), self-`Sig` over `(PeerId|Platform|Token|UpdatedAt)` re-verified at resolve
time against the bound `CadrePeer.PublicKey`.

- `device-token.ts` — `deviceTokenSignedPayload` / `signDeviceTokenRecord` /
  `verifyDeviceTokenSignature` / `isPushPlatform` (mirrors `peer-record.ts`; record carries no
  public key — verified against the bound `CadrePeer.PublicKey`).
- `types.ts` — `PushPlatform`, `DeviceTokenRecord`, `ResolveDeviceTokenOpts`.
- `control-database.ts` — `queryDeviceToken`, `updateSelfDeviceToken`; `DeviceToken` added to
  `ControlTable` / `CONTROL_TABLES`.
- `seed-bootstrap.ts` — `insertSelfDeviceToken` / `deleteDeviceToken`; extracted a shared
  `signPeerAuthorization(peerId)` helper now used by `insertCadrePeerRow` / `removePeer` / both
  new methods (DRY).
- `cadre-node.ts` — `registerDeviceToken(platform, token)` (self-update if row exists, else
  authority-insert, else throws), `resolveDeviceToken(peerId, opts?)` (membership + binding +
  self-sig + freshness, `null` on any failure), `clearDeviceToken()` (authority delete, no-op
  if absent).
- `index.ts` — exports the four `device-token.ts` helpers.
- Docs — `architecture.md` (control-table list + node-responsibilities entry) and `STATUS.md`
  updated to the new reality, including the downstream-boundary callouts.

Intentionally NOT in scope (downstream consumers): the push *sender* (server fan-out) and the
*receiver* (RN registration call).

## Review findings

### Checked
- **Implement diff read first, fresh eyes**, then the handoff. Every touched source + doc file
  read in full.
- **Schema parity & drift** — `control-schema.ts` and `schemas/control.qsql` `DeviceToken`
  blocks are byte-identical (drift guard `control-schema-drift.spec.ts` green). Cross-checked the
  `AuthorizedInsert` / `AuthorizedUpdate` idioms against `CadrePeer`: same digest construction
  (`digest(coalesce(new/old.PeerId), 'sha256', 'utf8')`), same monotonic + immutable-PeerId
  self-branch, same authority re-auth branch. The one deliberate divergence (verify against
  `CadrePeer.PublicKey` via subquery instead of the row's own `PublicKey`) matches the design
  intent (the record carries no key) and is exercised by tests.
- **Crypto model** — signed payload is reconstructable inside the SQL constraint from the row's
  own columns; `'|'` delimiter safety holds (base58btc PeerId, fixed `fcm`/`apns`, base-10 int).
  Sign/verify round-trip, wrong-key, forged-sig, tampered-field, and missing-key rejection all
  covered.
- **API parity** — `registerDeviceToken`/`resolveDeviceToken`/`clearDeviceToken` follow the
  `registerSelf`/`resolvePeerAddrs` write+gate shape exactly (binding check via
  `ed25519PublicKeyB64FromPeerId`, freshness via `isPeerRecordFresh`, `null`/throw conventions).
- **Enumeration completeness** — `DeviceToken` added to both `ControlTable` and `CONTROL_TABLES`;
  swept all `CadrePeer` references for a missed sync/snapshot/clear enumeration — none exists
  (`CONTROL_TABLES` only gates `countRows`; `queryCadrePeers` is membership-specific and needs no
  token analogue).
- **DRY** — the `signPeerAuthorization` extraction is correct and removes duplicated authority-sign
  blocks; `removePeer` behavior preserved.
- **Gates** — `yarn workspace @serfab/cadre-core typecheck` clean; `yarn lint` clean; full suite
  **391 passed / 30 files** (389 pre-existing + 2 added).

### Found & fixed (minor, this pass)
- **Untested behavioral contracts.** Two designed behaviors had no coverage. Added to
  `device-token-registry.spec.ts`:
  - `registerDeviceToken` **throws** (message mentions *authority*) when a non-authority,
    row-less node tries its first self-insert — the handoff's "most important gap" contract was
    asserted only in prose. Added a `bootNonAuthorityNode` helper + test.
  - `resolveDeviceToken` returns **`null` for a member that has a `CadrePeer` row but no
    `DeviceToken` row** — the missing-row gate, distinct from the non-member gate. Added a test.
  Device-token tests now 19/19; full suite 391/391.

### Considered, deliberately left as-is
- **`resolveDeviceToken` JSDoc says "never throwing" but throws on not-started.** This exactly
  mirrors the sibling `resolvePeerAddrs` (throws on not-started, returns the empty value on gate
  failure). "Failure" means a resolution-gate failure, not misuse of an unstarted node. Consistent
  with the established pattern — not changed.
- The six handoff "known gaps" are all genuine **scope boundaries, not defects**, and were each
  confirmed acceptable: (1) a non-authority phone cannot self-insert its first row — by design,
  the row is authority-seeded by the phone→server registration handshake (downstream RN ticket),
  and `registerDeviceToken` throws with a directive message (now tested); (2) `clearDeviceToken`
  likewise authority-gated — same dependency; (3) no pluggable trust policy on resolve — tight
  scope, membership+binding is the gate; (4) default freshness = `Infinity` — correct for a push
  token (valid until rotation), `maxAgeMs` bounds it; (5) `queryDeviceToken` casts `Platform`
  without validating — matches `queryPeerRecord`, low risk (`not null` column, covered by self-sig,
  `resolveDeviceToken` re-validates via `isPushPlatform`); (6) single-node coverage — same harness
  scope as `peer-record-resolution.spec.ts`; cross-package multi-node convergence is assumed to
  behave as `CadrePeer` does.

### Major findings
None. No new `fix/`/`plan/`/`backlog/` ticket warranted — the only downstream work (push sender,
RN registration) is already tracked separately and was correctly excluded from this registry
ticket's scope.
