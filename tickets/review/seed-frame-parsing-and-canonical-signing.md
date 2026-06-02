description: Review guarded seed/ack frame parsing and canonical seed signing
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/canonical-json.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/update/manifest.ts
----

# Review handoff: seed-frame-parsing-and-canonical-signing

Implemented two hardening changes in `SeedBootstrapService` plus a shared
canonical-JSON serializer. Treat the tests below as a floor — the security
boundary (seed authority validation builds on signature verification) warrants
an adversarial read.

## What changed

### 1. Guarded length-prefixed frame parsing
- New exported pure helper `decodeLengthPrefixedFrame(data, maxLength = MAX_SEED_SIZE)`
  in `seed-bootstrap.ts` (just below `MAX_SEED_SIZE`). It:
  - throws a descriptive error on sub-4-byte buffers (instead of `RangeError`
    from `getUint32`),
  - throws when the declared length exceeds `maxLength`,
  - throws when the declared length exceeds the body bytes actually present
    (instead of an opaque `JSON.parse` SyntaxError on a short slice),
  - passes the full `(buffer, byteOffset, byteLength)` triple to `DataView` so a
    non-zero-offset view is handled correctly,
  - returns a `subarray` view (no copy).
- Wired into both parse sites: the ack read in `deliverSeed` and the seed read in
  the inbound protocol handler. The inbound accumulation cap (`totalLength >
  MAX_SEED_SIZE`) is unchanged and complementary — it bounds bytes read off the
  wire; the helper bounds the declared length used in the slice.

### 2. Canonical seed signing
- New `packages/cadre-core/src/canonical-json.ts` exporting `canonicalJson`
  (ported verbatim from cadre-host's `manifest.ts`: recursive key sort, drop
  `undefined`, no whitespace, arrays preserve order). Exported from
  `cadre-core/src/index.ts`.
- `cadre-host/src/update/manifest.ts` now `import { canonicalJson } from
  '@serfab/cadre-core'` and re-exports it (its local copy deleted). The
  `update/index.ts` and host `index.ts` re-export chains and
  `signManifestForTesting`/`verifyManifest` call sites are unchanged.
- New exported `canonicalSeedPayload(seed)` builds the signed bytes from
  `{ partyId, peers, transactions }` via `canonicalJson`. Both `createSeed`
  (signing) and `validateSeedSignature` (verifying) route through it. The latent
  bug — verifier conditionally folding `transactions` into the digest while the
  creator never did — is fixed: both now sign the same bytes, and a seed carrying
  `transactions` validates.

## Tests
- `seed-bootstrap.spec.ts`: the three hand-rolled signing sites (positive
  `validateSeedSignature`, tampered case, `createSignedSeed` in the authority
  block) now sign via `canonicalSeedPayload`.
- Added: `decodeLengthPrefixedFrame` suite (valid decode, sub-4-byte reject,
  declared>available reject, declared>max reject, non-zero byteOffset), and a
  canonical-signing suite (key-order independence, transactions regression,
  absent==undefined equivalence).
- `cd packages/cadre-core && yarn build` → exit 0; `yarn test` → 150 passed
  (43 in seed-bootstrap).
- `packages/cadre-host` manifest suite → 13 passed (run via
  `yarn vitest run src/update/__tests__/manifest.test.ts`).

## Known gaps / reviewer attention
- **cadre-host `yarn build` (tsc -b) fails pre-existing**, unrelated to this
  ticket: `host-process-orchestrator.ts(455,5)` missing `seedEndpoint` on
  `OrchestratorCreateResult`. Verified reproducible at HEAD with my change
  stashed. Documented in `tickets/.pre-existing-error.md`. Because of this, the
  manifest refactor was validated via the vitest suite only (per-file transpile,
  no project-wide tsc gate) — a reviewer should confirm there are no type-level
  regressions from the cadre-core import once the orchestrator error is resolved.
- `transactions` is still not populated anywhere (see
  `tickets/plan/seed-transactions-cache-prepopulation-unimplemented.md`); the
  transactions-carrying validation is a regression guard for when it lands, not
  live behavior.
- The helper is exported from `seed-bootstrap.ts` for tests; consider whether it
  belongs in the package's public surface (currently not re-exported from
  `index.ts`).
