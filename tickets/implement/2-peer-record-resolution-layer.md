----
description: Resolve a peer's current, signed, trust-checkable relay/signaling multiaddr(s) from only its PeerId, so a NAT-to-NAT WebRTC dial can be negotiated without copy/paste. Builds a self-published, freshness-stamped peer-address record on the existing CadrePeer table, plus a transport-agnostic resolvePeerAddrs(peerId) API on CadreNode.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, schemas/control.qsql, docs/architecture.md
effort: xhigh
----

## Summary

To open a direct WebRTC connection between two NAT'd peers, the dialer needs the listener's **current relay/signaling multiaddr** given only the listener's PeerId. FRET routes toward a PeerId's ring coordinate but is **not an address book** (`PeerEntry` has no `multiaddrs`; FRET exposes no put/get value store — only routing via `RouteAndMaybeActV1`). The substrate that already maps `PeerId → Multiaddr`, is authority-signed, and replicates over the Optimystic control DB is the **`CadrePeer` table**. This ticket turns `CadrePeer` into a proper **signed, freshness-stamped peer-address record** and adds a resolution API on top.

Two halves:

1. **Publish** — a node self-publishes its current dialable/relay addresses into its own `CadrePeer` row, signed by its own control key and stamped with a monotonic freshness timestamp; it re-publishes when its reachable addresses change (relay reservation rotation) and on a TTL heartbeat. This finally implements the `registerSelf` TODO (`cadre-node.ts:377-386`).
2. **Resolve** — `CadreNode.resolvePeerAddrs(peerId)` reads that record, verifies the self-signature, checks freshness against a TTL, applies the trust gate, and returns relay-prefixed signaling multiaddrs for the WebRTC dial path (or any transport).

This is distinct from `bootstrap-dht-discovery-and-strand-cohort-wiring` (which seeds a strand's *cohort* bootstrap list): that connects you to a cohort; this resolves *an arbitrary member's current signaling address*. They share the `CadrePeer` substrate and the address-publish path — keep them coherent.

## Current state (verified)

- `schemas/control.qsql:44-58` — `CadrePeer(PeerId pk, Multiaddr text)`. `AuthorizedInsert`/delete require an authority signature over `digest(PeerId,'sha256','utf8')`. `AuthorizedUpdate` is *meant* to let a peer change its own `Multiaddr` via `verify(digest(new.PeerId)||digest(new.Multiaddr), context.Signature, new.PeerId, 'ed25519')`.
  - **Defect to fix:** `new.PeerId` is a base58btc libp2p peer-id multihash, but `quereus-plugin-crypto`'s `verify` does `toBytes(publicKey, keyEncoding='base64url')` then `ed25519.verify(...)` (`optimystic/packages/quereus-plugin-crypto/src/crypto.ts:235-254`). Base64url-decoding a base58 peer-id yields garbage, so **no self-update signature can ever verify against `new.PeerId`** as written. The self-publish path is currently non-functional.
- `cadre-node.ts:358-387` — `registerSelf()` logs "requires authorization - skipping for now" and writes nothing. `scheduleSelfRegistration()` calls it once, 1s after start.
- `cadre-node.ts:816-824` — `getRelayAddress()` returns the first `/p2p-circuit/` multiaddr (the signaling address to publish).
- `cadre-node.ts:673-686` — `listMembers()` / `isMember()` read all `CadrePeer` rows via `controlDatabase.queryCadrePeers()` (`control-database.ts:336-341`). No per-peer resolve query, no freshness, no signature/trust check.
- `seed-bootstrap.ts:173-209` — `authorizePeer()` (authority) inserts `CadrePeer` with `Multiaddr` as a comma-joined string. Multiaddrs are otherwise only learned post-connection via libp2p `identify`.
- FRET: `Fret/packages/fret/src` exposes routing (`getNeighbors`, `iterativeLookup`, `RouteAndMaybeActV1` activity payloads) but **no value store** — there is nothing to `put`/`get` a record keyed by coordinate. A FRET-backed record store is deferred (see `tickets/backlog/fret-backed-peer-record-liveness.md`).

## Record shape

A peer-address record is a small signed object. Store it on the `CadrePeer` row (see schema below) and reuse the same shape in seeds and over the wire.

```ts
// packages/cadre-core/src/types.ts
export interface PeerAddressRecord {
  peerId: string;       // libp2p peer ID (base58btc) — the row key
  publicKey: string;    // ed25519 public key (base64url) whose libp2p identity IS peerId
  addrs: string[];      // current dialable multiaddrs, signaling (/p2p-circuit) first
  updatedAt: number;    // epoch ms — freshness; strictly increasing per peer
  sig: string;          // ed25519(canonical(peerId,publicKey,addrs,updatedAt)) by publicKey, base64url
}
```

`publicKey` is the ed25519 key extracted from the peer's own libp2p identity (`peerIdFromString(id).publicKey` for ed25519 peer ids). Storing it explicitly — rather than asking the SQL constraint to decode the peer-id — is the recommended fix for the verify defect above and keeps ed25519 identity decoupled from the transport peer-id, consistent with `seed-signerkey-trust-policy-self-asserting`. The authority that first inserts the row vouches the `publicKey ↔ peerId` binding (verifiable in code: the ed25519 key must hash to the peer-id); the self-update constraint then forbids changing `PeerId`/`PublicKey` and only accepts a signed `Multiaddr`/`UpdatedAt` bump.

Canonicalization must be deterministic and cross-platform (sorted keys, no whitespace) — reuse the existing `canonicalSeedPayload` approach in `seed-bootstrap.ts` so the same record verifies identically in browser, node, and RN.

## Schema change (`CadreControl.CadrePeer`)

Recommended (no backwards-compat concern per AGENTS.md):

```sql
table CadrePeer (
    PeerId text primary key,
    PublicKey text,                 -- ed25519 (base64url); libp2p identity == PeerId
    Multiaddr text,                 -- comma-joined current addrs (signaling first)
    UpdatedAt int,                  -- epoch ms; monotonic per peer (replay/rollback guard)
    constraint AuthorizedInsert check on insert, delete ( ... authority sig, as today ... ),
    constraint AuthorizedUpdate check on update (
        -- Peer self-updates its own addrs+freshness, signing with its OWN ed25519 key.
        -- PeerId/PublicKey are immutable on self-update; UpdatedAt must strictly increase.
        ( new.PeerId = old.PeerId
          and new.PublicKey = old.PublicKey
          and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
          and verify(
                digest(new.PeerId,'sha256','utf8')
                  || digest(new.Multiaddr,'sha256','utf8')
                  || digest(cast(new.UpdatedAt as text),'sha256','utf8'),
                context.Signature, new.PublicKey, 'ed25519') )
        -- or an authority re-authorizes (rotation / correction)
        or exists (select 1 from AuthorityKey A
                     where A.Key = context.AuthorityKey
                       and verify(digest(new.PeerId,'sha256','utf8'), context.Signature, A.Key, 'ed25519'))
    )
) with context (AuthorityKey text null, Signature text);
```

Decide during implement whether the digest concatenation above is the cleanest signed payload or whether to sign a single canonical JSON blob and store it in one column; the constraint must verify exactly what the publish path signs. Keep `AuthorizedInsert` semantics as today (authority vouches membership + the `publicKey↔peerId` binding, checked in `authorizePeer` code before insert).

## APIs

On `CadreNode`:

```ts
// Resolve current signed addrs for a peer from its PeerId. Transport-agnostic.
async resolvePeerAddrs(peerId: string, opts?: ResolveOpts): Promise<Multiaddr[]>;

interface ResolveOpts {
  maxAgeMs?: number;     // freshness ceiling; default e.g. 15 min — stale records filtered out
  signalingOnly?: boolean; // return only /p2p-circuit signaling addrs (the WebRTC dial input)
}
```

Resolution algorithm:
1. Query the single `CadrePeer` row for `peerId` (new `control-database.ts` method, e.g. `queryPeerRecord(peerId)`).
2. Reconstruct the `PeerAddressRecord`; verify the self-signature against `PublicKey`, and that `PublicKey`'s libp2p identity equals `peerId` (reject mismatch).
3. **Freshness:** reject if `now - updatedAt > maxAgeMs`. A resolver must never hand back a dead relay reservation indefinitely.
4. **Trust gate:** reject if the record's backing membership isn't trust-anchored per policy. Make the gate **pluggable** (a `trustPolicy?` hook / injected predicate) so it composes with whatever `seed-signerkey-trust-policy-self-asserting` lands — do not hard-depend on that ticket, but leave the seam. Default gate: peer must be a current `CadrePeer` member (authority-vouched).
5. Order addrs signaling-first; map to `Multiaddr`; honor `signalingOnly`.

Publish path (implements `registerSelf`):
- Build the record from `getMultiaddrs()` (prefer `getRelayAddress()` for the signaling addr), sign with the node's libp2p private key (or the derived ed25519 key matching `PublicKey`), and `update ... with context Signature = ?` the node's own `CadrePeer` row. First-time rows are inserted by an authority via `authorizePeer` (already exists); a node that is its own authority can insert itself.
- **Refresh triggers:** (a) libp2p `self:peer:update` / relay reservation change events; (b) a TTL heartbeat (e.g. re-publish at maxAgeMs/2). Each republish strictly increases `UpdatedAt`.

The resolution layer must not import or depend on WebRTC — it returns multiaddrs that the WebRTC dial path (and any other transport) consumes.

## Expected behavior

- Given only a target member's PeerId and an existing control connection, a node resolves one or more current, signed, trust-checkable multiaddrs (including a `/p2p-circuit` signaling address) without manual copy/paste of a relayed dial string (the current STATUS.md workaround).
- Records refresh when reachable addresses change and are filtered out once stale.
- A resolved address whose signing key/membership isn't trusted is rejected before dialing.

## References

- `schemas/control.qsql:44-58`; `packages/cadre-core/src/control-database.ts:62,334-341`
- `packages/cadre-core/src/cadre-node.ts:358-387` (registerSelf TODO), `673-686` (listMembers), `816-824` (getRelayAddress)
- `packages/cadre-core/src/seed-bootstrap.ts:173-209` (authorizePeer), `461-519` (canonical payload + queryPeers)
- `optimystic/packages/quereus-plugin-crypto/src/crypto.ts:235-254` (verify; the base64url key-decode defect)
- `docs/architecture.md:64-67,149-166,555-581` (publish multiaddrs to CadrePeer; NAT-to-NAT relay seed); `docs/STATUS.md:45-64` (copy/paste workaround)
- Related: `tickets/plan/bootstrap-dht-discovery-and-strand-cohort-wiring.md`, `tickets/plan/seed-signerkey-trust-policy-self-asserting.md`, `tickets/backlog/fret-backed-peer-record-liveness.md`, `tickets/backlog/4-relay-bootstrap-infrastructure.md`.

## TODO

### Phase 1 — schema + record type
- Extend `CadreControl.CadrePeer` with `PublicKey` and `UpdatedAt`; rewrite `AuthorizedUpdate` to verify self-signed addr+freshness updates against `PublicKey` with monotonic `UpdatedAt` (immutable `PeerId`/`PublicKey`), keeping the authority-override branch. Mirror into the embedded schema string in `control-database.ts:62`.
- Add `PeerAddressRecord` to `types.ts`; add a canonical-payload + sign + verify helper (reuse/extend `canonicalSeedPayload`). Ensure determinism cross-platform.

### Phase 2 — publish path
- Implement `registerSelf()`: build record from current multiaddrs (relay/signaling first), sign with the node's ed25519 control key, write its own `CadrePeer` row (insert-if-authority, else update existing authorized row). Verify `publicKey↔peerId` binding in `authorizePeer` before insert.
- Add refresh: re-publish on relay-reservation/address change and on a `maxAgeMs/2` heartbeat, each bumping `UpdatedAt`.

### Phase 3 — resolution API
- `control-database.ts`: add `queryPeerRecord(peerId): Promise<PeerAddressRecord | null>`.
- `cadre-node.ts`: add `resolvePeerAddrs(peerId, opts)` doing verify → freshness → pluggable trust gate → signaling-first `Multiaddr[]`. Expose a `trustPolicy` seam (default: current-member check) for `seed-signerkey-trust-policy` to wire later.

### Phase 4 — docs + tests + validation
- Update `docs/architecture.md` (the "Reports its multiaddr back to CadrePeer" bullet + seed `SeedPeer`/`PeerAddressRecord` relationship) and tick the relevant `docs/STATUS.md` discovery item.
- Build + typecheck + run `@serfab/cadre-core` tests; stream output with `tee`.

### Key tests (TDD)
- **Publish:** after start, the node's own `CadrePeer` row carries its current `/p2p-circuit` addr, a `PublicKey` whose identity equals its PeerId, monotonic `UpdatedAt`, and a self-signature that `verify`s. A simulated relay-reservation change triggers a republish with a new addr and strictly greater `UpdatedAt`.
- **Monotonic / replay:** an update whose `UpdatedAt <= old.UpdatedAt` is rejected by the constraint; a record signed by a different key than `PublicKey` is rejected.
- **Resolve happy path:** `resolvePeerAddrs(peerB)` returns peerB's signaling multiaddr (signaling-first; `signalingOnly` returns only `/p2p-circuit`).
- **Freshness:** a record older than `maxAgeMs` is filtered → empty result (never a dead reservation).
- **Tamper / non-member:** a row with a bad `sig`, a `publicKey` not matching `peerId`, or a non-`CadrePeer` peer resolves to empty/rejected.
- **Trust gate:** with a restrictive injected `trustPolicy`, an otherwise-valid record is rejected before any dial.
- **Cross-platform canonicalization:** a record signed in node verifies under the browser/RN canonicalizer (sorted-key determinism).
