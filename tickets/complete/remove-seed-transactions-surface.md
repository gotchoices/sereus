description: Removed the dead seed `transactions[]` cache-prepopulation surface; produce/sign/verify confirmed in lockstep
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/canonical-json.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts, docs/architecture.md

## What was done

Removed the dead/half-wired seed `transactions[]` surface (warm-cache prepopulation half of the seed design — no producer, no consumer, no Optimystic API to support it). Deleted the `SignedTransaction` interface and the `transactions?` field from `ControlNetworkSeed` and `SeedMessage`; narrowed `canonicalSeedPayload` to `{ partyId, peers }`; updated docs and tests. The deferred feature is parked in `backlog/seed-warm-cache-prepopulation.md`.

After this change the canonical signed representation is exactly `canonicalJson({ partyId, peers })` — precisely what `createSeed` emits — so produce/sign/verify cannot diverge.

## Review findings

### Verified correct (no action needed)

- **Full removal across the *whole* repo** (not just `packages/`/`docs/` as the implement pass checked). Re-grepped `SignedTransaction` and `transactions` repo-wide including `reference-app-*`, `ops/`, `schemas/`, root. **No source referents remain** for `SignedTransaction`; the only hits are this ticket's own history and an unrelated archived-ticket mention. All surviving `transactions` hits are unrelated (Quereus/Optimystic DB transactions, the web diagnostics `'transactions'` cache-source label, README prose). Surface is fully gone.
- **Produce/sign/verify lockstep.** Confirmed `createSeed` (`seed-bootstrap.ts:351`) builds `seedData = { partyId, peers }` and signs via `canonicalSeedPayload`; `validateSeedSignature` reconstructs through the same builder. Both now route through `{ partyId, peers }` — no path can sign over fields the producer doesn't emit. `createSeed` returns `{ ...seedData, signature, signerKey }` — no dangling reference left behind.
- **Byte-identical backward-compat claim holds.** Read `canonical-json.ts:26`: `Object.keys(obj).filter((k) => obj[k] !== undefined)` — `undefined` keys are dropped. So old `canonicalJson({partyId, peers, transactions: undefined})` (what real `createSeed` seeds always produced, since `createSeed` never set `transactions`) is byte-identical to new `canonicalJson({partyId, peers})`. Previously-signed seeds remain valid. Both wire directions hold: an old receiver reconstructs `transactions: undefined` from a new sender's payload → drops it → same digest.
- **Wire compatibility.** The protocol handler (`seed-bootstrap.ts:677`) reconstructs only `{partyId, peers, signature, signerKey}` from the inbound message and ignores any extra field, so a mixed-version sender that still emits `transactions` is harmless. Confirmed.
- **Docs reconciled.** Read the edited regions of `architecture.md` (`ControlNetworkSeed` example, `SeedMessage` example, validation bullet, the replaced warm-cache bullet). All reflect the new `{ partyId, peers }` reality and forward-reference the backlog ticket. No stray seed-`transactions` prose remains.
- **Backlog ticket exists.** `tickets/backlog/seed-warm-cache-prepopulation.md` is present.

### Tests

- **`yarn workspace @serfab/cadre-core test` — 315 passed (25 files).** The retained `is independent of peer key insertion order` test preserves canonical-signing coverage; encode/decode round-trip and `validateSeedSignature` happy/negative paths remain green. The deleted tests only exercised the removed field, so no coverage was lost for any surviving behavior. No new test was warranted — there is no new behavior, only a removed surface, and the existing canonical-signing/round-trip/key-order tests already pin the byte-stability that backs the backward-compat claim.

### Lint

- **`eslint` on all four changed files — 0 errors, 36 warnings.** Every warning is pre-existing and unrelated to this diff (unused `verify`/`Multiaddr`/`AddDroneOptions`/`AddPhoneOptions` imports and `any` in test helpers). Confirmed `verify` was already unused at `HEAD~1` (only the import line matched before this change), so the deletions introduced none of them. These warnings are covered by the existing `build-health-lint-warning-cleanup` backlog ticket — out of scope here.

### Major findings → new tickets

- None. The change is a clean, surgical removal with provable byte-stability; nothing warranted a follow-up fix/plan ticket beyond the already-parked `seed-warm-cache-prepopulation` backlog item.

### Known gap carried forward (not a defect)

- **Cross-network integration test not executed at runtime.** `deliver-seed-cross-network.integration.ts` is real-network/long-running and not agent-runnable under tess; it was only type-checked. The edit there is a pure object-literal field removal (low risk), but end-to-end seed delivery after the wire-shape change remains unverified at runtime — a reviewer or CI should run it out-of-band. This is an unavoidable environment limitation, not an implementation deficiency.
