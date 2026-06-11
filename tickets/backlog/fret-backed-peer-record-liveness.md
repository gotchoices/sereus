----
description: Optional FRET-backed liveness layer for peer-address records — store/resolve a peer's signed, freshness-stamped address record at the FRET ring neighbors of its PeerId coordinate, so a peer's current relay/signaling address is discoverable with ring-local freshness and without a control-DB round-trip. Complements the durable CadrePeer-backed resolution from peer-record-resolution-layer.
prereq: peer-record-resolution-layer
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts
difficulty: hard
----

## Problem

`peer-record-resolution-layer` resolves a peer's current signed address from the **`CadrePeer`** table — durable, authority-signed, and replicated, but potentially **stale** relative to a phone whose relay reservation churns, and it can require a control-DB sync/round-trip. FRET already routes toward the ring coordinate responsible for a PeerId (`hashPeerId`, `getNeighbors`, `iterativeLookup`) and can carry application payloads via `RouteAndMaybeActV1` activities, but it stores **no multiaddrs** and exposes **no value put/get** today.

A FRET-backed liveness layer would let a peer **push** its signed `PeerAddressRecord` (defined by `peer-record-resolution-layer`) to the FRET neighbors of its own coordinate, and let a resolver **route** a lookup to those neighbors to fetch the freshest record — without waiting on control-DB convergence. The same signature + freshness + trust checks apply; FRET only changes *where the record is fetched from*, not its trust model.

## Why this is a separate (later) concern

- It requires net-new FRET surface: a record put/get (either a small value-store on `digitree-store`, or a request/response activity over `RouteAndMaybeActV1`) plus a responder handler and replication/expiry at the responsible neighbors. That is meaningfully more than the CadrePeer path and isn't needed for first correctness.
- The CadrePeer-backed resolver already satisfies the core use case (resolve a current signed signaling address from a PeerId). FRET-backed liveness is a **freshness/latency optimization** layered behind the same `resolvePeerAddrs` API (try FRET-fresh first, fall back to CadrePeer-durable).

## Expected behavior (when picked up)

- A peer publishes its signed `PeerAddressRecord` to the FRET neighbors of its PeerId coordinate, with a TTL and refresh-on-change; stale records expire at the holders.
- `resolvePeerAddrs(peerId)` can satisfy from FRET (ring-local, fresh) and fall back to the `CadrePeer` record (durable), preferring the freshest valid signature.
- Trust + freshness gating identical to the CadrePeer path; transport-agnostic (feeds the WebRTC dial path without depending on WebRTC).

## References

- FRET: `Fret/packages/fret/src/ring/hash.ts`, `src/service/fret-service.ts` (`getNeighbors`, `iterativeLookup`), `src/index.ts` (`RouteAndMaybeActV1` activity payloads), `src/store/digitree-store.ts` (`PeerEntry` — no multiaddrs).
- `tickets/implement/peer-record-resolution-layer.md` (the `PeerAddressRecord` shape + CadrePeer-backed resolver this extends).
