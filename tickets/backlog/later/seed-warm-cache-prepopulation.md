----
description: Optionally warm a fresh node's control/Optimystic cache from a seed, so cold-start needs fewer network round-trips
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/types.ts, docs/architecture.md
----

## Background

The original seed design (docs/architecture.md "Control Network Seed") proposed that a seed could carry signed Optimystic transactions to pre-populate a freshly bootstrapped node's control/Optimystic cache, so the new node starts with warm control data instead of fetching everything over the network. That half of the design was never implemented — the `transactions?: SignedTransaction[]` surface was typed, documented, and folded into the seed signature, but `createSeed` never produced it and `applySeed` never consumed it. It was removed wholesale by the implement ticket `remove-seed-transactions-surface` to eliminate dead spec and a latent signing-divergence hazard.

This backlog ticket captures the genuine optimization for future, properly-designed work.

## Why it was deferred (the hard parts)

A real implementation is gated on infrastructure that does not yet exist:

- **No cache-injection API.** `ControlDatabase`/`IRepo` expose only consensus-routed operations (`get`/`pend`/`cancel`/`commit`). The only local-storage primitives are `@optimystic/db-p2p`'s raw `IRawStorage` (`saveTransaction`/`saveMaterializedBlock`) which bypass validation and would corrupt the distributed log, and an internal test-only `CacheSource.transformCache` in `@optimystic/db-core`. A safe, validated cache-warming path must be designed in Optimystic first (likely upstream in `../optimystic`).
- **Transaction shape mismatch.** The real Optimystic `Transaction` is `{ stamp: { peerId, timestamp, schemaHash, engineId, expiration, id }, statements: string[], reads: ReadDependency[], id }` — not the placeholder `{ id, data, signature }`. A future feature needs a concrete, versioned serialization of control-DB transactions (or materialized blocks) plus a per-entry verification contract, not an opaque blob.
- **Trust/verification story.** "Pre-populate rather than blind-trust" only holds if each carried entry is independently verifiable against authority/validation keys the new node already accepts. That verification model must be specified alongside the existing `signerKey`/authority-peer trust check.

## Requirements / expectations (when promoted)

- A seed MAY optionally carry a verifiable representation of recent control-network state (transactions and/or materialized blocks) sufficient to warm the new node's cache.
- Applying it MUST go through a validated path (no raw-storage bypass): each entry verified before it lands in the cache; an invalid entry fails the seed or is skipped without poisoning the cache.
- Whatever fields are added to the seed/message MUST be produced by the creator AND folded into the canonical signed payload AND verified — produce/sign/verify stay in lockstep (the failure mode that motivated the prior removal).
- `docs/architecture.md` updated to match delivered behavior; the deferred forward-reference left by the removal ticket replaced with the real design.
- Cross-platform safe (browser/node/RN) — no Node-only storage assumptions.

## Prerequisite

Needs an Optimystic-side validated cache-injection / state-warming primitive. Coordinate with the `../optimystic` workspace (`db-core`/`db-p2p`) before planning the Sereus side — this is the blocking dependency, not the seed wiring itself.
