description: Wire operator-pinned authority keys into the CLI cold-start seed-apply paths — a repeatable --pin-authority-key flag + CADRE_AUTHORITY_KEYS env build a pinnedKeyTrustPolicy used as the node's service-default seedTrustPolicy (covering --listen-for-seeds and POST /seed) and as the per-call override for the --seed startup apply.
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/start-pins.spec.ts, packages/cadre-cli/README.md, packages/cadre-cli/docker/env.example, packages/cadre-cli/docker/docker-compose.yml, ops/docker/sereus-node/env.example, ops/docker/sereus-node/docker-compose.yml

## What landed

Wires operator-pinned authority keys into the CLI so a cold node (empty `AuthorityKey` table) can be given a trust anchor for cold-start seed application. Builds on `seed-trust-coldstart-cadrenode-seam` (complete): `CadreNode` forwards `config.seedTrustPolicy` into every `SeedBootstrapService` it constructs (including the temp services created in `applySeed`/`dialInvite`) and honors a per-call `applySeed(seed, { trustPolicy })` override.

### `start.ts`
- Repeatable commander option `--pin-authority-key <b64url>` with a `collectPinKey` collector, default `[]`.
- Pure, exported helper `collectPinnedAuthorityKeys(flagKeys, env)`: unions the flag array with comma-split `CADRE_AUTHORITY_KEYS`, trims, drops empties, dedupes via `Set`.
- After `resolveConfig`, **before** `new CadreNode(nodeConfig)`: `seedTrustPolicy = pinnedKeys.length > 0 ? pinnedKeyTrustPolicy(pinnedKeys) : undefined`, set on `nodeConfig.seedTrustPolicy`; logs `✓ Pinned N authority key(s) ...` when pins exist. Ordering is correct — the policy is read at service-construction time, and it is set before the node (hence before the later `enableSeedListener`).
- `--seed` startup apply passes the explicit override: `node.applySeed(seed, seedTrustPolicy ? { trustPolicy: seedTrustPolicy } : undefined)`.

### `health.ts`
- Comment-only change. `POST /seed` keeps calling `node.applySeed(decodedSeed)` and inherits the configured default. Comments now state a request must clear **both** layers — bearer (delivery) and trust (content) — and that bearer success ≠ trust. No per-request pin parameter (deliberate: operator-level granularity; a remote caller must not pick its own anchor). Verified against runtime: `applySeed` with no override resolves `this.config.seedTrustPolicy`, so the comment is accurate, not aspirational.

## Review findings

### Scope checked
Read the implement diff (`a412716`) with fresh eyes, then the live `start.ts`, `health.ts`, the seam it depends on (`seed-trust-policy.ts`, `seed-bootstrap.ts` `applySeed`/constructor, `cadre-node.ts` `applySeed`/`dialInvite` temp-service paths), and the operator-facing docs the change should have touched.

### Aspect-by-aspect

- **Correctness / wiring (3 lines flagged by the implementer).** Verified by inspection and now partly by test:
  - Override resolution: `seed-bootstrap.ts:418` is `options?.trustPolicy ?? this.trustPolicy`, and the service constructor (`:171`) falls back to `dbAnchoredTrustPolicy()` when `config.trustPolicy` is undefined. So no-pins → `undefined` override → `undefined` config policy → secure DB-anchored default. Pins → `pinnedKeyTrustPolicy` everywhere (node default + explicit `--seed` override). Both branches correct.
  - Warm-node union claim holds: `pinnedKeyTrustPolicy.evaluate` checks `knownAuthorityKeys.has(signerKey) || pinnedSet.has(signerKey)`, and `knownAuthorityKeys` is read from `controlDatabase.getAuthorityKeys()` at apply time — pinning never narrows trust.
- **Type safety.** `seedTrustPolicy: SeedTrustPolicy | undefined` is explicit; `CadreNodeConfig.seedTrustPolicy?` is optional. Helper signature is defensively `string[] | undefined`. No `any`. Action `options` is untyped, but that matches the existing commander style across this file (pre-existing, not introduced here).
- **DRY / modularity.** Helper is small, single-purpose, pure, exported. Collector mirrors the established repeatable-option idiom. No duplication introduced.
- **Resource cleanup / perf / error handling.** No new resources. `--seed` decode/apply stays inside its existing try/catch; a malformed pin is non-fatal by design (never matches a real `signerKey`, rejected with the trust reason).
- **Edge cases.** Helper covers flag-only, env-only, union, dedupe, whitespace trim, all-whitespace/empty/undefined env → `[]`, empty flag entries dropped. Policy contract covers trusts-pinned / rejects-unknown-with-reason on a cold node. Added coverage for the registered option (below).

### Found & fixed inline (minor)

- **Test floor raised.** Added `--pin-authority-key option wiring` describe to `start-pins.spec.ts`: asserts the registered commander option exists with an empty-array default and that its real collector accumulates repeated occurrences (`parseArg('b', parseArg('a', [])) === ['a','b']`). This exercises the actual registered option object, closing the flag-collection half of the wiring gap with real code rather than a stand-in. Tests: 59 → 61 pass.
- **Documentation was stale** (the implement pass added the surface but updated no operator docs). Fixed so docs reflect the new reality:
  - `packages/cadre-cli/README.md` — added a `CADRE_AUTHORITY_KEYS` row to the Environment Variables table, noting it is the *trust* anchor independent of the `CADRE_SEED_TOKEN` *delivery* gate and that a cold node rejects seeds without it.
  - `packages/cadre-cli/docker/env.example` and `ops/docker/sereus-node/env.example` — documented `CADRE_AUTHORITY_KEYS` in the Seed section.
  - `packages/cadre-cli/docker/docker-compose.yml` and `ops/docker/sereus-node/docker-compose.yml` — **functional doc fix**: both forwarded `CADRE_SEED_TOKEN` into the container but not `CADRE_AUTHORITY_KEYS`, so a Docker-deployed cold node could never receive its trust anchor even with the var set in `.env`. Added the `CADRE_AUTHORITY_KEYS=${CADRE_AUTHORITY_KEYS:-}` passthrough to both (the two templates are a known duplicate pair — backlog `consolidate-duplicate-cadre-node-docker-templates` — kept in sync here).
  - `docs/architecture.md` already says "pinned by operator config" at the design level — accurate, left unchanged.

### Considered, not actioned (with reasons)

- **No end-to-end test of the `start` *action* body** (the `nodeConfig.seedTrustPolicy = ...` assignment and the `applySeed` override threading). Not filed as a ticket: the remaining un-covered code is two trivial assignments verified by reading; the flag collector and the policy/helper logic (the parts with real behavior) are now unit-tested. A full action test needs a `CadreNode` injection seam in the start action — a refactor disproportionate to two assignment lines. Left as a documented acceptable deferral, not a gap requiring follow-up work.
- **No base64url validation of pins** — intentional and documented inline: a malformed pin simply never matches a real `signerKey`; the seed is rejected with the trust reason (no silent acceptance). Confirmed this is the desired posture; failing fast on a malformed pin would add a bespoke validator for no security gain.
- **Inline `import('uint8arrays')` at `health.ts:353`** (a runtime dynamic import, against the repo's human-review lint guideline) is **pre-existing** and outside this ticket's diff — not touched, not in scope. Flagging for awareness only.
- **Empty findings categories:** no security regression (trust posture is strictly tightened, never widened), no perf concern, no resource leak, no error-handling hole introduced by this change.

## Validation (all green post-review)

- `yarn workspace @serfab/cadre-cli build` → exit 0.
- `yarn workspace @serfab/cadre-cli test` → 6 files / **61** tests pass (incl. the two new option-wiring tests).
- `yarn eslint` on `start.ts`, `health.ts`, `start-pins.spec.ts` → clean.
