description: Guarded seed/ack frame parsing and canonical seed signing (reviewed)
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/canonical-json.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-host/src/update/manifest.ts, docs/architecture.md
----

# Completed: seed-frame-parsing-and-canonical-signing

Two hardening changes landed in `SeedBootstrapService` plus a shared
canonical-JSON serializer, then an adversarial review pass.

## What shipped

1. **Guarded length-prefixed frame parsing** — `decodeLengthPrefixedFrame(data,
   maxLength = MAX_SEED_SIZE)` in `seed-bootstrap.ts`, wired into both production
   parse sites (ack read in `deliverSeed`, seed read in the inbound handler). It
   rejects sub-4-byte buffers, declared-length > maxLength, and declared-length >
   bytes-present, passes the full `(buffer, byteOffset, byteLength)` triple to
   `DataView`, and returns a no-copy `subarray` view.

2. **Canonical seed signing** — `canonical-json.ts` exporting `canonicalJson`
   (ported verbatim from cadre-host's `manifest.ts`; the host now imports +
   re-exports it from `@serfab/cadre-core`). New `canonicalSeedPayload(seed)`
   routes both `createSeed` (signing) and `validateSeedSignature` (verifying)
   through one builder. This fixes the latent creator/verifier mismatch where the
   verifier conditionally folded `transactions` into the digest while the creator
   never did — both now sign identical bytes, independent of key order and
   optional-field presence.

## Review findings

### Checked
- **Implement diff, fresh eyes** (`git show d2e416b`): source + tests, before
  reading the handoff. canonicalJson confirmed byte-identical to the deleted host
  copy (diff + 13 passing manifest tests prove no manifest-signing regression).
- **Parse-site completeness**: grepped `getUint32`/`.slice(4`/`setUint32` across
  `packages/`. Both *production* parse sites are migrated to the helper. The only
  remaining hand-rolled copies live in
  `integration-tests/.../deliver-seed-cross-network.integration.ts` — pre-existing
  test-harness code that intentionally simulates the wire protocol.
- **Canonical-signing correctness**: key-order independence, `transactions`
  regression guard, and absent==undefined equivalence verified; the existing
  tampered/invalid-signature negatives still reject.
- **Type-level regression** (the implementer's flagged reviewer task): the
  pre-existing cadre-host build break (`OrchestratorCreateResult.seedEndpoint`)
  was already resolved by the triage commit `3fc801f`. With that fixed,
  `cadre-host` `yarn build:server` (tsc -b) now exits 0 *with* the new cadre-core
  `canonicalJson` import — no type regression from the refactor.
- **Validation / build / test**: cadre-core `yarn build` exit 0; `yarn test`
  **152 passed** (45 in seed-bootstrap); cadre-host manifest suite **13 passed**.
  No `lint` script or project-level ESLint config exists for either touched
  package — `tsc` is the static gate and is green for both.
- **Docs**: read `docs/architecture.md` seed-protocol section; the Validation
  bullets described signing only abstractly and did not capture the
  canonical-serialization contract that makes the fix work.

### Found & fixed inline (minor)
- **Test gaps** in the `decodeLengthPrefixedFrame` suite: added a zero-declared-
  length boundary case (empty-body view) and a trailing-bytes case (parser uses
  exactly the declared slice, never reads past it — so wire garbage cannot leak
  into the decoded body). +2 tests (150 → 152).
- **Stale docs**: added a `docs/architecture.md` Validation bullet documenting
  that `signature` is ed25519 over
  `digest(canonicalJson({partyId, peers, transactions}), 'sha256')`, shared with
  the host manifest-signing path and order/presence-independent.

### Observations — deliberately not actioned
- **DRY**: the integration-test harness re-implements length-prefix parsing
  instead of importing the helper. Pre-existing, test-only, and the helper is not
  on the package's public surface (exported from `seed-bootstrap.ts` for tests,
  not `index.ts`) — keeping public surface minimal is the right call. Not a defect
  introduced here; not worth a ticket.
- **Seed trust-anchoring**: a node applying a seed received over the open
  `/sereus/seed/1.0.0` protocol trusts a self-consistent authority list (an
  attacker can sign a seed listing their own key as authority). This is the
  established bootstrap model (trust derives from the out-of-band delivery
  channel) and already carries a TODO at `architecture.md` — out of scope for
  this hardening ticket.
- **`transactions` never populated**: the transactions-carrying validation is a
  regression guard, not live behavior. Tracked in
  `tickets/plan/seed-transactions-cache-prepopulation-unimplemented.md`.

### Major findings
None. No new fix/plan/backlog tickets filed.
