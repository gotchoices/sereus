description: Review removal of the dead seed `transactions[]` cache-prepopulation surface; verify produce/sign/verify stay in lockstep
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts, docs/architecture.md

## What was done

Removed the dead/half-wired seed `transactions[]` surface entirely (the warm-cache prepopulation half of the seed design had no producer, no consumer, and no Optimystic API to support it). The implementation rationale and the decision to remove rather than implement are in the original implement ticket; the deferred feature is parked in `backlog/seed-warm-cache-prepopulation.md`.

After this change the canonical signed representation of a seed is exactly:

```
canonicalSeedPayload(seed) === canonicalJson({ partyId: seed.partyId, peers: seed.peers })
```

which is precisely what the producer (`createSeed`) emits — so produce/sign/verify cannot diverge. Because real seeds never carried `transactions`, the signed digest is byte-identical to before; **existing signed seeds remain valid**.

### Concrete edits

- `packages/cadre-core/src/types.ts`
  - Deleted `transactions?: SignedTransaction[]` (+ doc) from `ControlNetworkSeed` and `SeedMessage`.
  - Deleted the `SignedTransaction` interface (no remaining referents — grep-verified across `packages/`).
- `packages/cadre-core/src/seed-bootstrap.ts`
  - Dropped `SignedTransaction` from the type import.
  - `canonicalSeedPayload`: narrowed param to `Pick<ControlNetworkSeed, 'partyId' | 'peers'>`; body now `canonicalJson({ partyId, peers })`; JSDoc rewritten (kept the key-order-independence rationale, dropped transactions-folding language).
  - Class JSDoc: dropped the "...and optionally transactions" clause.
  - `deliverSeed` `SeedMessage` literal and the protocol-handler reconstructed `ControlNetworkSeed`: dropped `transactions:`.
  - `validateSeedSignature` inline comment: payload is now the fixed `{ partyId, peers }`.
- `docs/architecture.md`
  - `ControlNetworkSeed` example: removed the `transactions?` line; "Signature over { partyId, peers, transactions? }" → "{ partyId, peers }".
  - `SeedMessage` example: removed the `transactions?` line.
  - Validation bullet: signed-bytes expression now `canonicalJson({partyId, peers})`; dropped the "folded in identically" clause.
  - Replaced the "seeds can include `transactions[]`" bullet with a forward reference to backlog `seed-warm-cache-prepopulation`.
- Tests
  - `packages/cadre-core/test/seed-bootstrap.spec.ts`: deleted `should handle seeds with transactions`, `validates a seed that carries transactions ...`, `treats absent and undefined transactions identically`, and `should allow optional transactions`; removed the `transactions?` field from the local `signSeed` helper's param type. The `is independent of peer key insertion order` test retains canonical-signing coverage.
  - `packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts`: dropped `transactions: seed.transactions,` from the manual `seedMessage` literal.

## Validation performed

- `yarn workspace @serfab/cadre-core build` (tsc) — **clean, exit 0**. Proves no dangling `SignedTransaction` / `transactions` references and that nothing real depended on the surface.
- `yarn workspace @serfab/cadre-core test` — **315 passed (25 files)**, including the full `seed-bootstrap` spec.
- `yarn workspace @serfab/integration-tests typecheck` — **clean, exit 0** (covers the edited cross-network integration file).
- Grep: no remaining `SignedTransaction` or seed-`transactions` referents in `packages/` or `docs/`.

## Reviewer focus / use cases to confirm

- **Backward-compat of the signed digest**: confirm the byte-for-byte claim — `canonicalJson({partyId, peers})` is unchanged from the old `canonicalJson({partyId, peers, transactions: undefined})` because `canonicalJson` drops `undefined` keys. A previously-signed seed (signature computed over `{partyId, peers}` with no `transactions`) must still pass `validateSeedSignature`. The retained `validateSeedSignature` / encode-roundtrip / key-order tests cover this; double-check the canonical-json drop-undefined behavior holds.
- **Full removal**: re-grep `SignedTransaction` and `transactions` across the whole repo (not just `packages/`/`docs/`) in case any consumer outside those trees (e.g. `reference-app-*`, `ops/`, schemas) referenced the field. The implement pass grepped `packages/` and `docs/` only.
- **Wire compatibility**: the `SeedMessage` over-the-wire JSON no longer includes `transactions`. A receiver running this build ignores any extra field anyway (it reconstructs only `{partyId, peers, signature, signerKey}`), so a mixed-version sender that still emits `transactions` is harmless — confirm that reasoning.

## Known gaps / deferrals (honest handoff)

- **Cross-network integration test was NOT executed.** `deliver-seed-cross-network.integration.ts` is real-network and long-running; per the ticket it is not agent-runnable under tess. It was only **type-checked** (via `integration-tests typecheck`). A reviewer or CI should run it out-of-band to confirm end-to-end seed delivery still works after the wire-shape change. The edit there was a pure object-literal field removal, so the risk is low, but it is unverified at runtime.
- The deferred warm-cache feature lives in `backlog/seed-warm-cache-prepopulation.md`; this ticket intentionally does not implement it. If the reviewer disagrees with removal-over-implementation, that is a design call to escalate, not an inline fix.
