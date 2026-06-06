----
description: Add a node-wide service-default seed trust policy seam to CadreNode so the inbound libp2p seed-protocol path (and the temp-service applySeed path) can be configured with a pinned/TOFU trust anchor — the only seam a network-delivered seed can use, since it has no per-call override.
prereq:
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts
----

## Context

`seed-trust-policy-and-authority-identity` made `dbAnchoredTrustPolicy` the secure default: `SeedBootstrapService.applySeed` rejects any seed whose `signerKey` is not anchored in the receiver's `AuthorityKey` table or supplied via a trust-policy override. `SeedBootstrapService` already accepts a service-default `trustPolicy` in its config and `applySeed` already accepts a per-call `options.trustPolicy` override (see `seed-bootstrap.ts:114-167,393-426`).

The gap is **CadreNode forwards no policy into the service**, so:

- `initializeSeedBootstrap(authorityPrivateKey)` (cadre-node.ts:1145) constructs `new SeedBootstrapService({...})` with **no** `trustPolicy` → falls back to `dbAnchoredTrustPolicy()`.
- `enableSeedListener()` (cadre-node.ts:1240, the receive-only drone path) does the same.
- `applySeed()` (cadre-node.ts:1321) constructs a **temp** `SeedBootstrapService` when no service exists — also with no policy.

Because the inbound libp2p `/sereus/seed/1.0.0` protocol handler (`seed-bootstrap.ts:639` → `this.applySeed(seed)` with no options at line 684) **cannot take a per-call override** (the seed arrives over the wire), the *only* way to make a cold-start node accept a network-delivered seed is to configure the **service-level default** policy. This ticket adds that seam through `CadreNode`. The `deliver-seed-cross-network` integration test currently only works by constructing the receiver `SeedBootstrapService` directly (`integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts:379-387`), bypassing `CadreNode` — proof the seam is missing.

This ticket is cadre-core only and is the prereq for the CLI and reference-app wiring tickets.

## Design

Add an optional node-wide default trust policy to `CadreNodeConfig`, parallel to the existing `requireSignedSchemas` behavior knob (NOT nested inside `controlNetwork`, which stays plain file-serializable connection data — partyId/bootstrapNodes/schemaPath):

```ts
// types.ts — CadreNodeConfig
/**
 * Node-wide default trust anchor for INBOUND control-network seeds. Forwarded
 * into every SeedBootstrapService this node constructs (authority, receive-only
 * listener, and the temp service used by applySeed when no service exists), and
 * used as the service-level default the libp2p seed-protocol handler relies on
 * (that path has no per-call override seam). Defaults to dbAnchoredTrustPolicy()
 * inside SeedBootstrapService when unset — a cold-start node then rejects every
 * seed. A per-call `applySeed(seed, { trustPolicy })` override still wins over
 * this default for callers that hold out-of-band material (e.g. a pinned key
 * from a CadreInvite).
 */
seedTrustPolicy?: SeedTrustPolicy;
```

`SeedTrustPolicy` is already defined in `seed-trust-policy.ts` and re-exported from `cadre-core/src/index.ts` (verify `SeedTrustPolicy` the *type* is exported there alongside the policy factories — add it to the export if missing). Import the type into `types.ts` from `./seed-trust-policy.js`.

Thread `this.config.seedTrustPolicy` into **all three** `SeedBootstrapService` construction sites in `cadre-node.ts`:

- `initializeSeedBootstrap` (~1150): add `trustPolicy: this.config.seedTrustPolicy` to the config object.
- `enableSeedListener` (~1251): same.
- `applySeed` temp-service branch (~1327): `new SeedBootstrapService({ partyId: seed.partyId, trustPolicy: this.config.seedTrustPolicy })`.

`SeedBootstrapService` already does `config.trustPolicy ?? dbAnchoredTrustPolicy()` (line 167), so passing `undefined` preserves today's secure default. No change needed in `seed-bootstrap.ts` for the wiring itself; only touch it if `SeedBootstrapConfig.trustPolicy`'s doc-comment needs a pointer back to the CadreNode seam.

### Precedence (must hold)

```
applySeed(seed, { trustPolicy })   ← per-call override (highest)
  └─ CadreNode.config.seedTrustPolicy  ← service default (this ticket)
       └─ dbAnchoredTrustPolicy()       ← secure fallback (unchanged)
```

The protocol-handler path (`registerProtocolHandler` → `applySeed(seed)` with no options) resolves to the service default. Do not change the handler to take an override — there is no caller to supply one.

## Edge cases & interactions

- **Both override and default set.** A caller that passes `applySeed(seed, { trustPolicy })` must still win over the configured `seedTrustPolicy` default. Covered by the existing `options?.trustPolicy ?? this.trustPolicy` in `SeedBootstrapService.applySeed` (line 414) — add a test asserting it through `CadreNode`.
- **Three construction sites.** The authority path, the receive-only listener path, AND the temp-service path in `applySeed` must each forward the policy. A reviewer will check all three — a missed site silently reverts that path to db-anchored and the cold-start network case fails only in production. Enumerate all three in tests.
- **Default still secure.** With `seedTrustPolicy` unset, a cold-start node (empty `AuthorityKey` table) must still reject every seed with the db-anchored reason. Assert the no-config path is unchanged.
- **Non-cold node + pinned default.** `pinnedKeyTrustPolicy` unions DB-anchored keys with pinned keys, so configuring a pinned default on an already-enrolled node never *narrows* trust. Sanity-test that a DB-anchored signer still applies when a (different-key) pinned default is configured.
- **enableSeedListener idempotency.** `enableSeedListener` early-returns if a service already exists (cadre-node.ts:1246) — confirm the policy is captured on first construction and a later call does not silently drop/replace it.
- **partyId on temp service.** The temp service is built with `seed.partyId` (attacker-influenced) — that only labels logs; trust is decided solely by `signerKey` vs the anchor set. No change, but note it so the reviewer doesn't flag it.
- **Protocol-handler rejection surfaces as an ack.** When the service default rejects a network-delivered seed, `registerProtocolHandler` already returns `{ accepted: false, reason }` and emits `seed:error`. Confirm the configured-default rejection reason propagates into the `SeedAckMessage.reason` (not swallowed).

## TODO

- Export the `SeedTrustPolicy` type from `cadre-core/src/index.ts` if not already exported; import it into `types.ts`.
- Add `seedTrustPolicy?: SeedTrustPolicy` to `CadreNodeConfig` with the doc-comment above.
- Forward `this.config.seedTrustPolicy` into the `SeedBootstrapService` config at `initializeSeedBootstrap`, `enableSeedListener`, and the temp-service branch of `applySeed`.
- Tests (extend `packages/cadre-core/test/seed-bootstrap.spec.ts` or add a `cadre-node-seed-trust.spec.ts`):
  - Cold node, no `seedTrustPolicy`, `applySeed(coldSeed)` → `{ success: false }` with the db-anchored trust reason (regression guard for the secure default).
  - Cold node, `seedTrustPolicy: pinnedKeyTrustPolicy([signerKey])`, `applySeed(coldSeed)` (no per-call override, exercising the temp-service / configured-default path) → `{ success: true }`.
  - Per-call override beats configured default: configured default rejects, `applySeed(seed, { trustPolicy: pinnedKeyTrustPolicy([signerKey]) })` → success.
  - Listener path: a node brought up via `enableSeedListener` with a configured pinned default applies a cold seed handed to its `getSeedBootstrapService().applySeed(seed)` (the same entry the protocol handler uses), while the same node with no configured policy rejects it.
- `yarn workspace @serfab/cadre-core build` and `yarn workspace @serfab/cadre-core test` (stream with `2>&1 | tee`).
- Run `yarn lint` on touched files.
