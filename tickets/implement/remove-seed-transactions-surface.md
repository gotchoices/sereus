----
description: Remove the dead/half-wired seed `transactions[]` cache-prepopulation surface; keep produce/sign/verify in lockstep
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts, docs/architecture.md
----

## Decision

Remove the `transactions?: SignedTransaction[]` surface from the seed mechanism entirely, rather than implementing signed-transaction cache pre-population.

**Why removal (not implementation):** The warm-cache half of the seed design is dead spec, and implementing it is not viable as a small follow-on:

- There is **no Optimystic API** to inject/apply a pre-signed transaction into the local block cache without a full network-consensus round-trip. The only primitives that touch local storage are `saveTransaction`/`saveMaterializedBlock` in `@optimystic/db-p2p`'s raw `IRawStorage` (bypass consensus, would corrupt the distributed log) and an internal test-only `CacheSource.transformCache` in `@optimystic/db-core`. None is exposed through `ControlDatabase` or `IRepo` (which offers only `get`/`pend`/`cancel`/`commit`).
- The seed's `SignedTransaction { id, data, signature }` shape does not correspond to a real Optimystic `Transaction` (`{ stamp: { peerId, timestamp, schemaHash, engineId, expiration, id }, statements: string[], reads: ReadDependency[], id }`). There is no producer anywhere that serializes control-DB transactions into the seed shape and no consumer that applies them — the field has never carried data in production.
- Honoring the spec would require new cross-package Optimystic infrastructure (a validated cache-injection path + a transaction serialization/verification contract). That is a feature, not a bug-fix, and is parked in `backlog/seed-warm-cache-prepopulation.md`.

Removal also eliminates the latent correctness hazard called out in the source ticket: `validateSeedSignature`/`canonicalSeedPayload` fold `transactions` into the canonical signed bytes while `createSeed` never emits the field, so any caller that ever set `transactions` on a `createSeed`-produced seed would silently change the signed payload. After removal the canonical signing representation is exactly `{ partyId, peers }` — what the producer actually emits — so produce/sign/verify cannot diverge.

## Resulting canonical signing representation

```
canonicalSeedPayload(seed) === canonicalJson({ partyId: seed.partyId, peers: seed.peers })
```

`ControlNetworkSeed` and `SeedMessage` both lose their `transactions?` field; the `SignedTransaction` interface is deleted (it has no other referents). The signed digest is unchanged for any real seed (which never carried `transactions`), so existing signed seeds remain valid.

## References

- `packages/cadre-core/src/seed-bootstrap.ts` — `canonicalSeedPayload` (69-83), class comment (116-122), `createSeed` (253-293, already omits transactions — no behavior change), `deliverSeed` SeedMessage build (395-401), protocol-handler seed build (563-569), `validateSeedSignature` JSDoc (461-468), `SignedTransaction` in the type import (25).
- `packages/cadre-core/src/types.ts` — `ControlNetworkSeed.transactions` (449-450), `SignedTransaction` interface (461-468), `SeedMessage.transactions` (479-480).
- `docs/architecture.md` — `ControlNetworkSeed` example (138-140, 142), `SeedMessage` example (280-282), validation bullet (293), "seeds can include transactions[]" bullet (297).
- Tests referencing the surface: `packages/cadre-core/test/seed-bootstrap.spec.ts` (84-100, 185, 227-245, 358-370) and `packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts:235`.

## TODO

### Phase 1 — types

- In `packages/cadre-core/src/types.ts`, delete the `transactions?: SignedTransaction[]` member from `ControlNetworkSeed` (incl. its doc comment) and from `SeedMessage` (incl. its doc comment).
- Delete the `SignedTransaction` interface (461-468). Confirm via grep it has no remaining referents in `packages/`.

### Phase 2 — seed-bootstrap.ts

- Remove `SignedTransaction` from the type import block (line 25).
- `canonicalSeedPayload`: narrow the param type to `Pick<ControlNetworkSeed, 'partyId' | 'peers'>` and change the body to `canonicalJson({ partyId: seed.partyId, peers: seed.peers })`. Rewrite the JSDoc to drop the transactions-folding language — keep the key-order-independence rationale (canonicalJson sorts keys / drops `undefined`).
- Update the class JSDoc (116-122): "pre-populate the new node's cache with peer information and optionally transactions" → "...with peer information." (drop the transactions clause).
- `deliverSeed`: drop `transactions: seed.transactions,` from the `SeedMessage` literal (line 398).
- Protocol handler: drop `transactions: message.transactions,` from the reconstructed `ControlNetworkSeed` (line 566).
- `validateSeedSignature` JSDoc / inline comment (461-468): drop the "optional-field presence" clause; the payload is now fixed `{ partyId, peers }`.

### Phase 3 — docs/architecture.md

- Remove the `transactions?: SignedTransaction[]` line + comment from the `ControlNetworkSeed` example (138-140), and change "Signature over { partyId, peers, transactions? }" (142) to "Signature over { partyId, peers }".
- Remove the `transactions?: SignedTransaction[];` line from the `SeedMessage` example (280-282).
- Validation bullet (293): change the signed-bytes expression to `digest(canonicalJson({partyId, peers}), 'sha256')` and drop the "`transactions` is folded in identically" clause (keep the shared-`canonicalSeedPayload` / key-order rationale).
- Remove the "For additional security, seeds can include `transactions[]` with signed Optimystic entries" bullet (297). Replace with a one-line forward reference noting warm-cache prepopulation is deferred (see backlog `seed-warm-cache-prepopulation`).
- Grep `docs/architecture.md` for `transaction` and `cold-start` to catch any stray mention in surrounding seed prose and reconcile it.

### Phase 4 — tests

- `packages/cadre-core/test/seed-bootstrap.spec.ts`:
  - Delete `should handle seeds with transactions` (84-100).
  - In the `canonical seed signing` describe: remove the `transactions?` field from the `signSeed` helper's param type (185); delete `validates a seed that carries transactions ...` (227-237) and `treats absent and undefined transactions identically` (239-245). The existing `is independent of peer key insertion order` test (199-225) retains canonical-signing coverage.
  - Delete `should allow optional transactions` (358-370).
- `packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts`: drop `transactions: seed.transactions,` from the manual `seedMessage` literal (235).

### Phase 5 — validate

- `yarn workspace @serfab/cadre-core build` (tsc type-check — must be clean; confirms no dangling `SignedTransaction`/`transactions` references).
- `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core-test.log` (stream output; the `seed-bootstrap` spec must pass).
- Do NOT run the cross-network integration test under tess (real-network, long-running) — a type-check of the edited integration file via the build is sufficient here; note the deferral in the review handoff.

## Key tests / expected outputs

- Type-check passes with `SignedTransaction` deleted and no `transactions` referents remaining (proves the surface is fully gone and nothing real depended on it).
- `canonicalSeedPayload({ partyId, peers })` produces identical bytes regardless of peer-field insertion order (retained `is independent of peer key insertion order` test still green).
- A seed produced by `createSeed()` round-trips through `encodeSeed`/`decodeSeed` and validates via `validateSeedSignature` (existing encode/validate tests still green).
