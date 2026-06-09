description: Review the control-network DeviceToken registry (schema + cadre-core read/write API) that lets a server cadre peer resolve a mobile peer's FCM/APNs push token for push-wake delivery
prereq:
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/device-token.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/device-token.spec.ts, packages/cadre-core/test/device-token-registry.spec.ts, docs/architecture.md, docs/STATUS.md

## What was built

A `DeviceToken` control-network table modeled byte-for-byte on `CadrePeer`, plus the cadre-core read/write API. It deliberately does **not** implement the push *sender* (server fan-out) or the *receiver* (RN registration call) — those are downstream consumers.

### Schema (`control-schema.ts` + `schemas/control.qsql`, mirrored — drift guard passes)
`DeviceToken(PeerId pk, Platform, Token, UpdatedAt, Sig)` placed right after `CadrePeer`:
- `AuthorizedInsert check on insert, delete` — authority signature over `digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8')` (identical idiom to `CadrePeer.AuthorizedInsert`, so `peerAuthorizationDigest` is reused for the signature).
- `AuthorizedUpdate check on update` — self-branch: `PeerId` immutable, `UpdatedAt` strictly increasing, and `Sig` verified against the **`CadrePeer.PublicKey`** for this PeerId over `digest(new.PeerId || '|' || new.Platform || '|' || new.Token || '|' || cast(new.UpdatedAt as text), 'sha256', 'utf8')`; OR an authority re-auth branch. `Platform`/`Token` may change on self-update (rotation / platform switch / reinstall).

### cadre-core API
- `device-token.ts` (new sibling of `peer-record.ts`): `deviceTokenSignedPayload(record)` (base64url sha256 of `${peerId}|${platform}|${token}|${updatedAt}`), `signDeviceTokenRecord`, `verifyDeviceTokenSignature(record, publicKeyB64)`, `isPushPlatform`. Unlike `PeerAddressRecord`, the record carries **no** public key — it is verified against the bound `CadrePeer.PublicKey`.
- `types.ts`: `PushPlatform`, `DeviceTokenRecord`, `ResolveDeviceTokenOpts`.
- `control-database.ts`: `queryDeviceToken`, `updateSelfDeviceToken` (self-signed; mirrors `queryPeerRecord`/`updateSelfPeerRecord`); `DeviceToken` added to `ControlTable`.
- `seed-bootstrap.ts`: `insertSelfDeviceToken` (authority-signed insert carrying the peer's self-sig) and `deleteDeviceToken` (authority-signed delete). Factored a shared `signPeerAuthorization(peerId)` helper now used by `insertCadrePeerRow` / `removePeer` / both new methods.
- `cadre-node.ts`: `registerDeviceToken(platform, token)` (self-update if row exists, else authority-insert if the node holds an authority service, else throws), `resolveDeviceToken(peerId, opts?)` (membership + `PublicKey↔PeerId` binding + self-sig + freshness, `null` on any failure), `clearDeviceToken()` (authority-signed delete, no-op if absent).
- `index.ts`: exports the four `device-token.ts` helpers (types flow via `export * from './types.js'`).

## How to validate

- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **389 passed / 30 files** (was 389 before; the 2 new files add coverage, and the seed-bootstrap guard-ordering regression introduced mid-implementation is fixed and green).
- Root lint on all touched files — clean.
- Drift guard (`control-schema-drift.spec.ts`) passes → both schema copies are byte-identical.

### Tests added
- `test/device-token.spec.ts` — unit: payload determinism/field-sensitivity, sign/verify round-trip, wrong-key / forged-sig / tampered-field / missing-key rejection, `isPushPlatform`.
- `test/device-token-registry.spec.ts` — real control DB (mirrors `peer-record-resolution.spec.ts`): authority-insert→resolve; rotation with strictly-increasing `UpdatedAt` + replay rejection; same-ms monotonic bump; **non-authority drone self-update with its own key** (exercises the self-branch with a key ≠ authority key); forged-update rejection; forged-stored-Sig resolves to `null`; non-member → `null`; explicit `maxAgeMs:0` staleness → `null`; clear → `null`.

### Suggested manual use case
On a self-authority node: `await node.registerSelf()` (seeds `CadrePeer.PublicKey`), then `await node.registerDeviceToken('fcm', '<token>')`, then `await node.resolveDeviceToken(node.peerId.toString())` returns the record; `await node.clearDeviceToken()` → resolve returns `null`.

## Known gaps / reviewer attention (treat as a floor, not a finish line)

1. **A non-authority phone cannot self-insert its first `DeviceToken` row.** This is the most important gap. The ticket explicitly modeled the table on `CadrePeer`, whose insert is authority-gated — so a phone (not its own authority, no pre-existing row) hits the `registerDeviceToken` throw. The realistic flow is that the phone→server registration handshake (the downstream "RN registration" ticket) has the server authority-insert the row, after which the phone self-refreshes via the self-update branch. **This is a genuine design dependency, not a bug to fix inside this ticket** — but the reviewer should confirm the chosen contract (throw with a directive message) is acceptable, or decide whether the schema should grow a self-sign insert branch instead. The phone-side path is intentionally untested here (cadre-core owns only the write primitive).
2. **`clearDeviceToken` likewise requires the authority service** (delete is authority-gated). A phone logout must route the clear through its authority. Same dependency as (1).
3. **No pluggable trust policy on resolve.** `resolvePeerAddrs` accepts an injectable `PeerResolveTrustPolicy`; `resolveDeviceToken` does not — membership = `CadrePeer` row presence + binding is the only gate. Deliberately scoped tight; flag if a stricter gate is wanted before a server pushes.
4. **Default freshness = no ceiling (`Infinity`).** Unlike a relay reservation, a push token is valid until it rotates, so a long-suspended phone must stay resolvable. `ResolveDeviceTokenOpts.maxAgeMs` lets a caller bound staleness. Confirm this default matches the push-wake intent.
5. **`queryDeviceToken` casts `Platform` to `PushPlatform` without validating** (matching `queryPeerRecord`'s `Type` cast). `resolveDeviceToken` validates via `isPushPlatform`, but a direct `queryDeviceToken` consumer could observe an out-of-range platform typed as `PushPlatform`. Low risk (the column is `not null` and the self-sig covers it), but noted.
6. **Coverage is single-node real-control-DB only** (same harness scope as `peer-record-resolution.spec.ts`). No cross-package / multi-node sync test for device tokens; convergence across replicated control DBs is assumed to behave as `CadrePeer` does.
