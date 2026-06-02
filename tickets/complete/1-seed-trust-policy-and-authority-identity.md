----
description: Replaced the self-asserting seed trust gate with an external trust anchor (SeedTrustPolicy) and sourced authority identity from the AuthorityKey table
files: packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/control-database.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-core/test/invite-address-push.spec.ts, packages/integration-tests/src/scenarios/enrollment-e2e.integration.ts, packages/integration-tests/src/scenarios/deliver-seed-cross-network.integration.ts, docs/architecture.md
----

## Summary

The self-asserting seed trust gate is gone. Previously `applySeed` trusted a seed's
signer iff the seed's *own* peer list named that key as an authority
(`seed.peers.some(p => p.isAuthority && p.publicKey === seed.signerKey)`) — both inputs
attacker-controllable, so a forged self-consistent seed passed. Trust now rests on an
anchor that does **not** come from the seed body:

- **`SeedTrustPolicy`** (`seed-trust-policy.ts`) — `evaluate(ctx)` over a context whose
  `knownAuthorityKeys` come from the *receiver's* `CadreControl.AuthorityKey` table, never
  the seed. Factories: `dbAnchoredTrustPolicy()` (secure default — cold-start rejects),
  `pinnedKeyTrustPolicy(pinned)` (out-of-band keys, e.g. `CadreInvite.authorityKeys`),
  `tofuTrustPolicy(confirm)` (opt-in interactive).
- **`applySeed`** verifies the signature, sources `knownAuthorityKeys` from the receiver's
  DB, evaluates the configured/overriding policy, and rejects with the policy reason. A
  per-call `{ trustPolicy }` override (threaded through `CadreNode.applySeed`) lets an
  enrollment caller pin invite keys without reconfiguring the service.
- **`queryPeers`** derives authority identity from the `AuthorityKey` table:
  `ed25519PublicKeyB64FromPeerId(peerId)` (an Ed25519 PeerId embeds its public key) ∩
  `AuthorityKey`, so any authority node is markable, not just self. Non-Ed25519/unparsable
  ids → `null` → non-authority (no throw).
- Supporting: `ControlDatabase.getAuthorityKeys()`, `CadreInvite.authorityKeys?`, and the
  rewritten `docs/architecture.md` seed-validation section.

## Review findings

### Scope checked

Re-read the implement diff (commit `49209c5`) with fresh eyes before the handoff, then
audited: the keying-representation consistency across all three consumers, the security
gate logic, `queryPeers` derivation, exports, docs, every `applySeed` caller in the repo,
and test coverage (happy/edge/error/regression/interaction). Ran `yarn build` + `yarn test`
in `cadre-core` (green) and `yarn typecheck` in `integration-tests` (green).

### Verified sound (no change needed)

- **Keying consistency — the crux of the whole change.** Confirmed the seed-signing key,
  the libp2p transport identity, and the stored `AuthorityKey.Key` are one Ed25519
  keypair in every real path: `cadre-cli start.ts` and `reference-app-web` both do
  `authorityKeyFromLibp2p(privateKey)` → `ensureAuthorityKey(publicKeyB64)` and
  `initializeSeedBootstrap(privateKeyB64)`, and `authority-key.ts` guarantees
  `getPublicKey(privateKeyB64) === publicKeyB64`. So `seed.signerKey`,
  `ed25519PublicKeyB64FromPeerId(self)`, and the stored authority key are all the same
  base64url string — DB-anchored accept, multi-authority `queryPeers`, and the self-peer
  `publicKey` field all line up. No regression versus the old `peerId === self` marking
  for single-authority cadres; an improvement for multi-authority.
- **Signature still gates trust.** `validateSeedSignature` verifies over `seed.signerKey`,
  so the policy can't be fed an attacker-substituted signer key.
- **Error handling / type safety.** `ed25519PublicKeyB64FromPeerId` swallows parse errors
  to `null` (correct here — a malformed peer must not fail seed creation); no `any` leaks
  in `src/`; the policy interface is honest about sync-or-async.

### Findings & disposition

- **(minor — fixed inline) Test gap: the security gate was only ever exercised against a
  mocked `getAuthorityKeys`.** Every trust-policy/`queryPeers` unit test injects the DB via
  `(service as any)`, so the actual `select Key from CadreControl.AuthorityKey` SQL feeding
  the default policy was never proven end-to-end. Added a real-DB round-trip test
  (`seed-bootstrap.spec.ts` → "applySeed — DB-anchored trust against a real control DB"):
  boots a real `CadreNode`, inserts an authority key, asserts `getAuthorityKeys()` returns
  it, then confirms an anchored signer is accepted and an unanchored signer rejected by the
  default policy with **no override**. Passes (suite now 226/226).
- **(minor — fixed inline) Stale doc comment.** `docs/architecture.md` still described
  `SeedPeer.publicKey` as "present on authority peers for signerKey verification" — that
  verification mechanism was deleted. Reworded to "derived from the AuthorityKey table, not
  used to gate the seed's own signerKey".
- **(minor — fixed inline, ticket augmented) Overlooked cold-start surface: the inbound
  libp2p protocol handler.** The handoff enumerated the deferred caller-side `applySeed`
  sites but missed `registerProtocolHandler` → `this.applySeed(seed)`
  (`seed-bootstrap.ts:~638`). That path can't take a per-call override (the seed arrives
  over the wire), so it depends on the *service-level* default policy — yet `CadreNode`
  constructs its `SeedBootstrapService` (cadre-node.ts:~696/~770) without forwarding any
  `trustPolicy`, and `initializeSeedBootstrap` takes no policy argument. So a cold-start
  node receiving a seed via `deliverSeed` is currently unconfigurable through `CadreNode`
  and always rejects. (The `deliver-seed-cross-network` integration test only works because
  it builds the receiver service directly, bypassing `CadreNode`.) Augmented the existing
  follow-up `plan/wire-pinned-trust-into-coldstart-seed-callers` to cover this path, the
  `CadreNode`-config seam to thread a service-default policy, and a matching use case.
- **(major — already filed by implementer) Cold-start caller wiring.** CLI `--seed`/
  `CADRE_SEED`, `POST /seed`, and reference-app/host enrollment still call `applySeed(seed)`
  with no anchor, so genuinely cold nodes reject — the intended secure default, but raw-seed
  onboarding is non-functional until callers pin. Tracked by
  `plan/wire-pinned-trust-into-coldstart-seed-callers` (now expanded per above).
- **(out of scope — pre-existing backlog) `seed-accepted-authority-persistence`.** Accepted
  cold-start signer keys aren't persisted into the local `AuthorityKey` table, and
  `seed.transactions[]` is still ignored by `applySeed`. Untouched, correctly.

### Empty categories

- **No correctness/security defects found** in the shipped `cadre-core` logic — the trust
  anchor is sourced strictly from receiver state, the signature still gates, and the
  representation is consistent across all consumers (verified above), so the documented
  regression (forged self-asserting seed) is genuinely closed.
- **No new lint/type issues** — `cadre-core` has no lint script (build is `tsc`, which is
  clean); `integration-tests` typecheck is clean.

### Not executed here

The real-network `integration-tests` package (`enrollment-e2e`,
`deliver-seed-cross-network`) was updated but not run (real-network, not agent-runnable
within idle limits); it typechecks. A reviewer/CI should run it against a real network to
confirm the pinned-policy wiring end-to-end.
