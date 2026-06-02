----
description: Review — replaced self-asserting seed trust gate with an external trust anchor (SeedTrustPolicy) and sourced authority identity from the AuthorityKey table
files: packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/invite-address-push.spec.ts, packages/integration-tests/src/scenarios/enrollment-e2e.integration.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts, docs/architecture.md
----

## What was implemented

The self-asserting seed trust gate is gone. Previously `applySeed` trusted a seed's signer iff the seed's *own* peer list named that key as an authority (`seed.peers.some(p => p.isAuthority && p.publicKey === seed.signerKey)`) — both inputs attacker-controllable, so a forged self-consistent seed passed. Trust now rests on an anchor that does **not** come from the seed body.

### New `SeedTrustPolicy` abstraction — `packages/cadre-core/src/seed-trust-policy.ts`

- Interfaces: `SeedTrustContext { partyId, signerKey, knownAuthorityKeys: ReadonlySet<string> }`, `SeedTrustDecision { trusted, reason? }`, `SeedTrustPolicy { evaluate(ctx) }` (sync or async).
- Factories:
  - `dbAnchoredTrustPolicy()` — **default**; `trusted = knownAuthorityKeys.has(signerKey)`. Cold-start node (empty set) rejects.
  - `pinnedKeyTrustPolicy(pinned)` — trusts `knownAuthorityKeys ∪ pinned` (pinned = `invite.authorityKeys` or operator config).
  - `tofuTrustPolicy(confirm)` — trusts DB keys; on unknown key invokes `confirm` exactly once; opt-in.
- All exported from `index.ts`.

### `applySeed` rewrite — `seed-bootstrap.ts`

1. Signature check (unchanged) → reject `'Invalid seed signature'`.
2. `knownAuthorityKeys = controlDatabase ? await getAuthorityKeys() : new Set()` — sourced from the receiver's DB, never the seed.
3. `policy = options?.trustPolicy ?? this.trustPolicy` (service default = `dbAnchoredTrustPolicy()`); evaluate; reject with `decision.reason` if untrusted.
4. The `seed.peers.some(...)` self-assertion is deleted.

`applySeed(seed, options?: { trustPolicy? })` accepts a **per-call override** so an enrollment caller can pin keys from an invite without reconfiguring the service. `SeedBootstrapConfig.trustPolicy` sets the service default. Threaded through `CadreNode.applySeed` (both the live-service and temp-service paths).

### `queryPeers` rewrite — authority identity from `AuthorityKey`, not `peerId`

`isAuthority`/`publicKey` are now derived: an Ed25519 libp2p PeerId embeds its public key, so `ed25519PublicKeyB64FromPeerId(peerId)` (new exported helper, uses `peerIdFromString(id).publicKey.raw` → base64url) is intersected with the `AuthorityKey` set. Any authority node is correctly markable (not just self). Non-Ed25519 / unparsable ids → `null` → treated as non-authority (no throw). **Verified** the derivation: a peerId's derived key round-trips and matches the libp2p public-key bytes (test `derives the same ed25519 key from a PeerId...`), consistent with `authority-key.ts:15-30`.

### Supporting changes

- `ControlDatabase.getAuthorityKeys(): Promise<Set<string>>` — single helper consumed by both `applySeed` and `queryPeers`.
- `CadreInvite.authorityKeys?: string[]` (`types.ts`) populated by `createInvite` from the issuer's `AuthorityKey` table (omitted when empty). This is the out-of-band channel for cold-start pinning.
- `docs/architecture.md` seed-validation section rewritten: DB-anchored / pinned-via-invite / opt-in TOFU, secure cold-start-rejects default, authority identity from `AuthorityKey` not `peerId`. The stale `TODO: enforce a trust policy` line is removed.

## How to validate

- Build + test: `cd packages/cadre-core && yarn build && yarn test` — **green locally: 17 files / 225 tests pass** (seed-bootstrap.spec.ts = 55).
- Typechecks pass for `integration-tests`, `cadre-cli`, `cadre-host` (`yarn typecheck` in each).

### Key test cases (in `packages/cadre-core/test/seed-bootstrap.spec.ts`)

- **Forged self-asserting seed rejected** — attacker signs a seed naming its own key as authority; empty DB + default policy → `success:false`, reason matches `/trust policy/i`. (The regression the old code failed.)
- **DB-anchored accept** — signer in the (mocked) `AuthorityKey` set → accepted.
- **Pinned-key accept/reject** — empty DB, `pinnedKeyTrustPolicy([authorityKey])` accepts; a different signer is rejected.
- **TOFU** — `confirm=false` rejects, `confirm=true` accepts, `confirm` called exactly once with the unknown key; not consulted when key is already DB-anchored.
- **Signature still required** — valid anchor + corrupted signature → `'Invalid seed signature'`.
- **queryPeers multi-authority** — two distinct Ed25519 peers both in `AuthorityKey` both come back `isAuthority:true` with `publicKey` set, though only one could match a local peerId.
- **queryPeers non-authority / non-Ed25519** — key absent → `isAuthority:false`, no `publicKey`; unparsable peerId handled without throwing.
- **Invite carries keys** — `createInvite` output includes `authorityKeys` matching the table; omitted when empty.

## Known gaps / honesty for the reviewer

- **Cold-start seed callers are NOT yet wired to pin keys.** `cadre-cli --seed`/`CADRE_SEED` (`start.ts:~257`), `POST /seed` (`health.ts:~309`), and the reference-app/host enrollment all still call `applySeed(seed)` with no override — so a genuinely cold node now **rejects** these seeds. This is the intended secure default, but it makes raw-seed onboarding non-functional for cold nodes until the callers supply an anchor. Follow-up filed: **`plan/wire-pinned-trust-into-coldstart-seed-callers`** (resolves the operator-pinning surface + invite-driven pinning + optional host TOFU).
- **Integration tests were updated but NOT executed here** (real-network, separate `integration-tests` package, not agent-runnable within idle limits). `enrollment-e2e.integration.ts` positive cold-start cases now pass `pinnedKeyTrustPolicy([authority.authorityPublicKey])`; the stale "no authority peer matching signer" negative test was rewritten to assert the cold-start-no-anchor rejection (and that pinning then accepts). `deliver-seed-cross-network.integration.ts` e2e receiver now constructs its service with a pinned policy for the sender's key. **A reviewer/CI should run these against a real network** to confirm the wiring.
- **Out of scope (pre-existing backlog `seed-accepted-authority-persistence`):** accepted cold-start signer keys are not persisted into the local `AuthorityKey` table (so each cold-start seed still needs the pin), and `seed.transactions[]` is still ignored by `applySeed`.
- The trust-policy unit tests inject `controlDatabase`/`libp2pNode` via `(service as any)` mocks (matching the file's existing style); they exercise `applySeed`/`queryPeers` logic but not a live Quereus control DB. The `authorizePeer/removePeer` round-trip test does use a real DB; consider whether a real-DB `getAuthorityKeys` round-trip is worth adding.
