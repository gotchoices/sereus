----
description: Seed transactions[] cache pre-population is declared and signed but never produced or applied
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, docs/architecture.md
----
The cold-start cache-prepopulation half of the seed design is dead spec. Seeds are typed and documented to carry `transactions?: SignedTransaction[]` to pre-populate a new node's control/Optimystic cache — the stated cold-start solution (docs/architecture.md:294; packages/cadre-core/src/types.ts:447-453,477). The signing path honors this: `validateSeedSignature` conditionally includes `transactions` in the signed payload (packages/cadre-core/src/seed-bootstrap.ts:423-428), and the seed protocol message carries the field through (seed-bootstrap.ts:355,528).

However, the mechanism is only half-wired. `createSeed()` never populates `transactions` — it produces only `{ partyId, peers }`. And `applySeed()` never consumes `seed.transactions`: it only merges multiaddrs into the libp2p peer store and dials authorities (seed-bootstrap.ts:225-228, 256-315, e.g. `peerStore.merge` at line 286 and `dial` at line 305). So in practice the seed mechanism pre-populates only the libp2p peer store, not the control DB / Optimystic cache that the docs and the class comment ("pre-populate the new node's cache with peer information and optionally transactions", seed-bootstrap.ts:78) claim.

This diverges from Sereus's stated cold-start design: the documented purpose of carrying signed transactions on a seed is to let a freshly bootstrapped node start with a warm control/Optimystic cache rather than fetching everything over the network. As delivered, that warm-cache benefit is never realized.

There is also a latent correctness hazard in the asymmetry. Because `validateSeedSignature` includes `transactions` in the canonical signed payload while `createSeed` omits the field entirely, any caller that ever sets `transactions` on a `createSeed`-produced seed would silently change the signed payload and break signature verification. The producing and verifying sides are not kept in lockstep.

Expected resolution: either implement signed-transaction cache pre-population end-to-end — produce `transactions` in `createSeed`, apply them in `applySeed` (writing into the control/Optimystic cache), with a single consistent canonical signing representation across produce/sign/verify — or remove the `transactions` surface entirely (from `types.ts`, the seed protocol message, and `validateSeedSignature`). In either case, update `docs/architecture.md` and the class/method comments so the documentation matches the delivered behavior, and ensure the signing payload cannot diverge from what the producer actually emits.

Key references:
- packages/cadre-core/src/seed-bootstrap.ts — `createSeed` (omits transactions), `applySeed` (peer store / dial only, 225-228 / 256-315), `validateSeedSignature` (signs transactions, 423-428), protocol message handling (355, 528), class comment (78).
- packages/cadre-core/src/types.ts:447-453, 477-478 — seed/message types declaring `transactions?: SignedTransaction[]`.
- docs/architecture.md:294 — documents transactions on seeds as the cold-start cache-prepopulation solution.
