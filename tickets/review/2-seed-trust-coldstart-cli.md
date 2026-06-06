description: Review the CLI cold-start seed-trust wiring — operator-pinned authority keys (--pin-authority-key flag + CADRE_AUTHORITY_KEYS env) build a pinnedKeyTrustPolicy used as the node's service-default seedTrustPolicy (covering --listen-for-seeds and POST /seed) and as the per-call override for the --seed startup apply.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/start-pins.spec.ts

## What landed

Wires operator-pinned authority keys into the CLI so a cold node (empty `AuthorityKey` table) can be given a trust anchor for cold-start seed application. Builds on `seed-trust-coldstart-cadrenode-seam` (landed/complete): `CadreNode` forwards `config.seedTrustPolicy` into every `SeedBootstrapService` it constructs and honors a per-call `applySeed(seed, { trustPolicy })` override.

### `start.ts`
- New repeatable commander option `--pin-authority-key <b64url>` with a `collectPinKey` collector and default `[]`.
- New **pure, exported** helper `collectPinnedAuthorityKeys(flagKeys, env)`: unions the flag array with comma-split `CADRE_AUTHORITY_KEYS`, trims each entry, drops empties, dedupes via `Set`.
- After `resolveConfig`, **before** `new CadreNode(nodeConfig)`: builds `pinnedKeys` → `seedTrustPolicy = pinnedKeys.length > 0 ? pinnedKeyTrustPolicy(pinnedKeys) : undefined`, sets it on `nodeConfig.seedTrustPolicy`, and logs `✓ Pinned N authority key(s) for cold-start seed trust` when pins exist. Ordering matters: the policy is captured at service-construction time, so it is set before the node (and thus before `enableSeedListener` at the later `--listen-for-seeds` block).
- The `--seed` startup apply now passes the override explicitly: `node.applySeed(seed, seedTrustPolicy ? { trustPolicy: seedTrustPolicy } : undefined)`.
- Imports `pinnedKeyTrustPolicy` and `type SeedTrustPolicy` from `@serfab/cadre-core`.

### `health.ts`
- **Comment-only change** (no behavior change). Updated the `seedToken` doc-comment and the `handleSeedRequest` comment: trust is now anchored by the node's `seedTrustPolicy` (operator pins unioned with DB-known keys), not "future work". Both comments now state a request must clear **both** layers — bearer (delivery) AND trust (content) — and explicitly that bearer success ≠ trust. `POST /seed` keeps calling `node.applySeed(decodedSeed)` and inherits the configured default; **no per-request pin parameter was added** (deliberate: operator-level granularity, a remote caller must not pick its own anchor).

## How to validate

Build / test / lint (all green at handoff):
- `yarn workspace @serfab/cadre-cli build` → exit 0 (tsc silent on success).
- `yarn workspace @serfab/cadre-cli test` → 6 files / 59 tests pass (incl. new `start-pins.spec.ts`).
- `yarn eslint packages/cadre-cli/src/commands/start.ts packages/cadre-cli/src/server/health.ts packages/cadre-cli/test/start-pins.spec.ts` → clean.

### Use cases covered by tests (`start-pins.spec.ts`)
- `collectPinnedAuthorityKeys`: flag-only, env-only, union, dedupe (same key via both → once), whitespace trim, all-whitespace/empty env (`,, ` / `''` / `undefined`) → `[]`, empty entries dropped from a flag array.
- Wiring contract: `pinnedKeyTrustPolicy(collectPinnedAuthorityKeys([SIGNER], undefined)).evaluate(...)` **trusts** the pinned signer key and **rejects** an unknown one (with a non-empty `reason`) against an empty `knownAuthorityKeys` set (cold node).

### Behaviors to verify by inspection / manual run (NOT auto-tested — see gaps)
- Cold node, no pins: `--seed <s>` prints `✗ Failed to apply seed: <db-anchored trust reason>` (intended secure posture), not a generic failure.
- Cold node + correct `--pin-authority-key`: seed applies, `✓ Seed applied: N peers added`.
- `POST /seed` on a cold pinned node: bearer-authenticated request still rejected unless the seed's signer is a pinned/known key.
- Pins + warm node: `pinnedKeyTrustPolicy` unions DB keys with pins, so pinning never narrows trust.

## Known gaps / honest flags (reviewer: treat tests as a floor)

- **No end-to-end test of the `start` action wiring.** The unit tests verify the *helper* and the *policy contract* in isolation; nothing automated asserts that the `start` commander action actually (a) collects `options.pinAuthorityKey` from a parsed `--pin-authority-key`, (b) sets `nodeConfig.seedTrustPolicy`, or (c) threads the override into `node.applySeed`. These three wiring steps are verified by code reading only. A focused test could parse `startCommand` with `.parseAsync([...], { from: 'user' })` against a mock/fake `CadreNode`, but no `CadreNode` seam for injection exists, so it was deferred per the ticket's "(If feasible without a full node)". Worth a reviewer eye on the three wiring lines.
- **`health.ts` change is comments only** — verify the wording doesn't overclaim (e.g. doesn't imply bearer success means trust) and that it matches actual runtime behavior (`applySeed` resolves the configured default).
- **No base64url validation of pins** (intentional, documented inline): a malformed pin simply never matches a real `signerKey` and the seed is rejected with the trust reason — no silent acceptance. Confirm this is the desired posture vs. failing fast on an obviously-malformed pin.
- **Helper lives in `start.ts`**, so the unit test imports the start module (pulling its heavy `@serfab/cadre-core` / db-p2p imports). That is fine today (action isn't invoked on import), but if a future reviewer wants the helper truly decoupled, a sibling `start-util.ts` would be the move.
- **Interaction with `seed-network-path-authn`** (bearer auth for `POST /seed`): independent layers (delivery vs trust). The comments now state both must pass; no code coupling between them — confirm that's the intended separation.
