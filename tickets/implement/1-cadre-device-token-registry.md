----
description: Add a control-network DeviceToken registry so a server cadre peer can resolve a mobile peer's FCM/APNs push token for push-wake delivery
prereq:
files: packages/cadre-core/src/control-schema.ts, schemas/control.qsql, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/peer-record.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/control-schema-drift.spec.ts, packages/cadre-core/test/peer-record.spec.ts
effort: high
----

A control-network libp2p dial (`pushWake`) cannot reach a phone whose process the OS has suspended. The mobile push-wake path must instead arrive over the platform push channel (FCM/APNs). For a server cadre peer to send that platform push, it needs the phone's **device push token**, resolvable from the phone's `peerId` within the cadre trust boundary.

The natural home is the control network (`CadreControl` schema), which is the only network a hibernating peer keeps connected and is already the cadre's signed, membership-gated registry. This ticket adds a `DeviceToken` table modeled directly on `CadrePeer` (self-published, freshness-stamped, self-signed) plus the cadre-core read/write API. It deliberately does **not** implement the sender (server fan-out) or the receiver (RN registration call) — those are downstream tickets that consume this API.

### Schema

Add to `CadreControl` (mirror EXACTLY in both `packages/cadre-core/src/control-schema.ts` and `schemas/control.qsql` — `control-schema-drift.spec.ts` fails the build on drift):

```sql
-- A mobile cadre peer's platform push token (FCM/APNs), self-published so a server
-- peer can deliver a push-wake to a suspended app. Row is a self-signed record:
-- a resolver re-verifies Sig against the CadrePeer.PublicKey for this PeerId.
table DeviceToken (
    PeerId text primary key,        -- the CadrePeer this token belongs to
    Platform text not null,         -- 'fcm' | 'apns'
    Token text not null,            -- opaque platform device/registration token
    UpdatedAt int null,             -- epoch ms; strictly increases per self-update (replay guard)
    Sig text null,                  -- ed25519 self-sig over (PeerId|Platform|Token|UpdatedAt)
    constraint AuthorizedInsert check on insert, delete (
        -- Authorized by an authority key (membership vouch), like CadrePeer
        exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
    ),
    constraint AuthorizedUpdate check on update (
        -- Peer self-updates its own token, signing with its OWN ed25519 key (behind PeerId).
        -- PeerId immutable, UpdatedAt strictly increasing, Sig verified against the stored
        -- CadrePeer.PublicKey over the signed payload (see deviceTokenSignedPayload).
        (
            new.PeerId = old.PeerId
            and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
            and exists (select 1 from CadrePeer P where P.PeerId = new.PeerId and verify(
                    digest(new.PeerId || '|' || new.Platform || '|' || new.Token || '|' || cast(new.UpdatedAt as text), 'sha256', 'utf8'),
                    new.Sig, P.PublicKey, 'ed25519'))
        )
            or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
    )
) with context (AuthorityKey text null, Signature text);
```

(Confirm the exact `with context` and `verify` encodings against the live `CadrePeer` definition in control-schema.ts:63-92 and copy its conventions verbatim — utf8 input encoding for base58 peer IDs, etc. Adjust the payload-join format if the strand requires a `digest(...)||digest(...)` concatenation like the other tables; the goal is to match the established signing idiom, not invent a new one.)

### cadre-core API

Mirror the peer-record helpers (`peer-record.ts`) and `CadreNode.registerSelf`/`resolvePeerAddrs`:

```ts
type PushPlatform = 'fcm' | 'apns';

interface DeviceTokenRecord {
  peerId: string;
  platform: PushPlatform;
  token: string;
  updatedAt: number;
  sig: string;
}

// In peer-record.ts (or a sibling): canonical signed payload + sign/verify
function deviceTokenSignedPayload(r: Omit<DeviceTokenRecord,'sig'>): string  // `${peerId}|${platform}|${token}|${updatedAt}`

// On CadreNode:
async registerDeviceToken(platform: PushPlatform, token: string): Promise<void>   // self-sign + upsert own row, monotonic UpdatedAt
async resolveDeviceToken(peerId: string): Promise<DeviceTokenRecord | null>       // membership + self-sig + freshness verified, else null
async clearDeviceToken(): Promise<void>                                            // delete own row (logout / token invalidation)
```

`resolveDeviceToken` must apply the same gating shape as `resolvePeerAddrs` (cadre-node.ts:579-629): membership presence, PublicKey↔PeerId binding via the `CadrePeer` row, self-signature re-verification, and freshness — returning `null` rather than throwing on any failure. Export the type and helpers from `index.ts`.

### Edge cases & interactions

- **Schema drift**: any edit to `control-schema.ts` must be mirrored byte-for-byte in `schemas/control.qsql`; `control-schema-drift.spec.ts` is the gate — run it.
- **Token before peer record**: a `DeviceToken` whose `PeerId` has no `CadrePeer` row (or no `PublicKey`) cannot be self-sig-verified → `resolveDeviceToken` returns `null`. Self-update path depends on the `CadrePeer.PublicKey` existing.
- **Replay / rollback**: `UpdatedAt` must strictly increase; a stale token (lower `UpdatedAt`) must be rejected by the `AuthorizedUpdate` check, exactly like `CadrePeer`.
- **Token rotation**: FCM/APNs tokens rotate; `registerDeviceToken` called repeatedly must upsert with a strictly increasing `UpdatedAt` and re-sign. Clock-equal updates (same ms) must still increase — reuse whatever monotonic stamping `registerSelf` uses.
- **Platform switch / reinstall**: same `PeerId`, new `Platform`/`Token` is a normal self-update, not a new row.
- **Non-member resolve**: `resolveDeviceToken(peerId)` for a peer not in `CadrePeer` returns `null` (server must not attempt push to a non-cadre peer).
- **Signature encoding parity**: the `verify(...)` in the `AuthorizedUpdate` constraint and `deviceTokenSignedPayload` MUST agree on field order, separators, and digest encoding, or self-updates silently fail — assert round-trip in tests.
- **Closed vs open strands / read control**: device tokens are control-network rows (party-private), not strand data; no strand read-control interaction, but confirm the control DB write path used by `registerSelf` is reused (authority-signed insert, self-signed update).

### Key tests (expected outputs)

- `control-schema-drift.spec.ts` passes with the new table in both copies.
- Sign/verify round-trip: `deviceTokenSignedPayload` + ed25519 sign → schema `verify(...)` accepts; tampered token/updatedAt → rejected.
- `registerDeviceToken('fcm', t1)` then `('fcm', t2)` → row reflects `t2` with higher `UpdatedAt`; replay of `t1`'s record rejected.
- `resolveDeviceToken` for a member with a fresh self-signed token → returns record; for non-member → `null`; for tampered sig → `null`.
- `clearDeviceToken` removes the row; subsequent resolve → `null`.

## TODO

- [ ] Add `DeviceToken` table to `control-schema.ts` and mirror in `schemas/control.qsql`; match `CadrePeer` signing idiom
- [ ] Add `DeviceTokenRecord` / `PushPlatform` types + `deviceTokenSignedPayload` + sign/verify helpers (peer-record.ts pattern)
- [ ] Add `CadreNode.registerDeviceToken` / `resolveDeviceToken` / `clearDeviceToken` (reuse `registerSelf`/`resolvePeerAddrs` write+gate paths)
- [ ] Export new types/helpers from `index.ts`
- [ ] Tests: drift, sign/verify round-trip, monotonic upsert/replay, membership-gated resolve, clear
- [ ] `yarn workspace @serfab/cadre-core test` + `typecheck` green
- [ ] Update `docs/architecture.md` (Control Network table list) and `docs/STATUS.md` to note the `DeviceToken` table
