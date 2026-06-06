----
description: Wire operator-pinned authority keys into the CLI cold-start seed-apply paths — a repeatable --pin-authority-key flag + CADRE_AUTHORITY_KEYS env build a pinnedKeyTrustPolicy used as the node's service-default (covering --listen-for-seeds and POST /seed) and as the per-call override for the --seed startup apply.
prereq: seed-trust-coldstart-cadrenode-seam
files: packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/start-pins.spec.ts
----

## Context

With `seed-trust-coldstart-cadrenode-seam` landed, `CadreNode` forwards `config.seedTrustPolicy` into every `SeedBootstrapService` it builds and honors a per-call `applySeed(seed, { trustPolicy })` override. The CLI cold-start paths still apply seeds with no anchor, so on a cold node (empty `AuthorityKey` table) they reject:

- `start.ts:281` — `node.applySeed(seed)` for the `--seed` / `CADRE_SEED` startup apply.
- `health.ts:354` — `this.node.applySeed(decodedSeed)` for `POST /seed` (bearer-gated; companion ticket `seed-network-path-authn` already authenticates this surface — bearer auth is the *delivery* gate, this ticket adds the *trust* anchor).

## Design

### Operator pinning surface

Give the operator one way to pin authority keys, available through both a flag and an env var (cross-platform; env is the natural fit for the containerized CLI, the flag for ad-hoc runs):

- `--pin-authority-key <b64url>` — repeatable commander option (collect into an array via a collector function, mirroring how repeatable options are done elsewhere).
- `CADRE_AUTHORITY_KEYS` — comma-separated base64url keys.

Union both sources, trim, drop empties, dedupe. Extract this into a small **pure, exported helper** so it is unit-testable without invoking the commander action:

```ts
// start.ts (or a sibling util module)
export function collectPinnedAuthorityKeys(
  flagKeys: string[] | undefined,
  env: string | undefined,
): string[] {
  const fromEnv = (env ?? '').split(',');
  return [...new Set([...(flagKeys ?? []), ...fromEnv].map(k => k.trim()).filter(k => k.length > 0))];
}
```

### Wiring

In the `start` action, after `resolveConfig` and before `new CadreNode(nodeConfig)`:

```ts
const pinnedKeys = collectPinnedAuthorityKeys(options.pinAuthorityKey, process.env.CADRE_AUTHORITY_KEYS);
const seedTrustPolicy = pinnedKeys.length > 0 ? pinnedKeyTrustPolicy(pinnedKeys) : undefined;
```

- Set `nodeConfig.seedTrustPolicy = seedTrustPolicy` (the node-wide service default — covers the `--listen-for-seeds` libp2p path AND the `POST /seed` health path, both of which route through `node.applySeed` against the configured default).
- For the `--seed` startup apply, **also** pass it explicitly as the per-call override for clarity and to cover the case where neither `--authority` nor `--listen-for-seeds` initialized a service (the temp-service path already reads the default, but passing the override is unambiguous and self-documenting):
  `node.applySeed(seed, seedTrustPolicy ? { trustPolicy: seedTrustPolicy } : undefined)`.

Import `pinnedKeyTrustPolicy` (and the `SeedTrustPolicy` type if needed) from `@serfab/cadre-core`.

### Logging

- When pins are configured, log a one-line confirmation at startup: `✓ Pinned N authority key(s) for cold-start seed trust`.
- The existing `--seed` failure branch already prints `✗ Failed to apply seed: ${result.error}` — the db-anchored/pinned trust reason flows through unchanged, so a cold node with no pin gets an actionable message. No change needed beyond confirming the reason text is surfaced.

### health.ts

No code change required — `POST /seed` calls `node.applySeed(decodedSeed)` which now resolves the node's configured `seedTrustPolicy`. Update the `seedToken` doc-comment (health.ts:18-30) and the `handleSeedRequest` comment (health.ts:307-316) to state that seed *trust* is now anchored by the node's `seedTrustPolicy` (operator `CADRE_AUTHORITY_KEYS` / `--pin-authority-key`), replacing the "trust is future work" note. Do not add a per-request pin parameter to the HTTP body — operator-level pinning is the right granularity for this surface and avoids letting a remote caller choose its own anchor.

## Edge cases & interactions

- **No pins on a cold node.** `--seed` and `POST /seed` reject with the db-anchored trust reason. This is the intended secure posture — assert the CLI surfaces the reason rather than a generic failure.
- **Pins + already-enrolled node.** `pinnedKeyTrustPolicy` unions DB keys with pins, so pinning never narrows trust for a warm node.
- **Env + flag union/dedupe.** Same key via both `--pin-authority-key` and `CADRE_AUTHORITY_KEYS` appears once. Empty/whitespace entries (`CADRE_AUTHORITY_KEYS=",, "`) collapse to no pins (→ `undefined` policy, secure default preserved). Cover both in the helper test.
- **Malformed pin key.** A non-base64url or wrong-length string is not validated here — it simply never matches a real `signerKey`, so the seed is rejected with the trust reason. Document this (no silent acceptance); do not add bespoke key validation.
- **`--listen-for-seeds` ordering.** `enableSeedListener` runs at start.ts:271 (after authority init), constructing the service that the protocol handler uses. Confirm `nodeConfig.seedTrustPolicy` is set **before** `new CadreNode(nodeConfig)` so every later service-construction site captures it (it is read at construction time per the seam ticket).
- **`--authority` node receiving a seed.** An authority node is the seed *creator*; it normally won't apply foreign cold-start seeds. If it does (operator delivers one), the same pinned default applies. No special-casing.
- **Interaction with `seed-network-path-authn`.** Bearer auth (delivery gate) and trust policy (content anchor) are independent layers; a request must pass *both*. Ensure the comments do not imply bearer success means trust.

## TODO

- Add the repeatable `--pin-authority-key <b64url>` option (with an array collector) to `startCommand`.
- Implement and export `collectPinnedAuthorityKeys(flagKeys, env)`.
- Build the `pinnedKeyTrustPolicy`, set `nodeConfig.seedTrustPolicy`, pass it as the `--seed` per-call override, and log the pin count.
- Update the `health.ts` doc-comments to reflect that trust is now anchored (no behavior change there).
- Tests (`packages/cadre-cli/test/start-pins.spec.ts`, vitest):
  - `collectPinnedAuthorityKeys`: flag-only, env-only, union, dedupe, empty/whitespace → `[]`.
  - (If feasible without a full node) a focused test that the policy built from pins trusts a given `signerKey` and rejects an unknown one — exercise `pinnedKeyTrustPolicy(keys).evaluate(...)` directly to lock the wiring contract.
- `yarn workspace @serfab/cadre-cli build` and `yarn workspace @serfab/cadre-cli test` (stream with `2>&1 | tee`).
- Run `yarn lint` on touched files.
