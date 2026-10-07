description: Let a brand-new node accept its first seed only from someone who can prove they hold the node's one-time claim secret, by adding a claim proof to the seed message and a trust policy that checks it.
architecture: docs/architecture.md#seed-delivery-protocol
files: packages/cadre-core/src/claim-proof.ts (new), packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, packages/cadre-core/test/claim-proof.spec.ts (new), packages/cadre-core/test/seed-trust-policy-claim.spec.ts (new), packages/cadre-core/test/trusted-owner-store.spec.ts, docs/architecture.md
difficulty: hard
----

# Claim proof in the seed message, and the claim-secret trust policy

First of three tickets (then `node-claim-gate-and-helper`, then `node-claim-cli-and-scenario`). This one is the protocol and the policy inside `@serfab/cadre-core`, below `CadreNode`. It changes nothing about how a node is configured or gated; the next ticket does that.

## Why

cadre-host is being reframed (`cadre-host-join-a-cadre`): the host starts a node that belongs to nobody, shows a QR code with the node's addresses and a one-time secret, and the owner's phone scans it and claims the node. The phone cannot be dialed, so the phone dials the node and delivers the seed over the existing `/sereus/seed/1.0.0` protocol. What is missing is trust: a fresh node's `SeedTrustPolicy` refuses every seed unless the signer's key reached it out of band (operator pin, invitation pin, TOFU prompt). The claim secret is that out-of-band channel.

## The proof (settled)

- **Secret.** 32 random bytes, carried as base64url text. The host mints it (`randomBytes(256, 'base64url')` from `@optimystic/quereus-plugin-crypto`) and shows it; both ends decode it. `parseClaimSecret(text)` refuses anything that is not base64url of exactly 32 bytes, naming the problem and never echoing the value (model on `requireEd25519PublicKeyB64` in `ed25519-key.ts`).
- **Seed digest.** `seedDigest(seed)` is `digest([canonicalSeedPayload(seed)], 'sha256', 'base64url')`, the exact digest the seed signature already covers. Today that expression is written twice in `seed-bootstrap.ts` (`createSeed`, `validateSeedSignature`); hoist it into one exported function and use it in both places and in the proof.
- **Proof.** `claimProof(secretBytes, nodePeerId, signerKey, seedDigest)` is the base64url of HMAC-SHA256 keyed by the 32 secret bytes over the UTF-8 bytes of `canonicalJson({ purpose: 'sereus-node-claim', v: 1, nodePeerId, signerKey, seedDigest })`. Binding the node's peer id means the proof cannot be moved to another node; binding `signerKey` means it cannot anchor a different owner; binding the seed digest means it cannot be reattached to a different seed. A passive observer of one delivery learns a proof that is useless anywhere else, and useless on this node once it is claimed.
- **Verification.** `verifyClaimProof(...)` recomputes and compares with a constant-time byte comparison (a plain loop accumulating XOR; no `node:crypto`, this module loads on React Native and in the browser).
- **Library.** HMAC-SHA256 from `@noble/hashes` (`@noble/hashes/hmac.js` and `@noble/hashes/sha2.js`; v2 requires the `.js` suffix). It is already in the tree through libp2p's Noise and is a direct dependency of `@serfab/cadre-rn` at `^2.0.0`; add the same range to `@serfab/cadre-core`. A keyed MAC is the standard "prove you hold a secret without revealing it" primitive; the framed `digest([...])` helper is not specified as one, so it is not used with the secret as a field.
- **Where.** New module `packages/cadre-core/src/claim-proof.ts` exporting `parseClaimSecret`, `seedDigest`, `claimProof`, `verifyClaimProof`. Export them from `index.ts` next to the seed-trust exports.

## Message and result types (`types.ts`)

- `SeedMessage` gains `claimProof?: string`. The protocol id stays `/sereus/seed/1.0.0` and no version field is added: there is no backwards compatibility yet, a receiver without this feature ignores the field and refuses by its anchored policy, and a sender without it gets a definite refusal from an unclaimed node. Record that reasoning in the field's doc comment.
- `SeedAckMessage` gains `code?: SeedRefusalCode` with `type SeedRefusalCode = 'already-claimed' | 'claim-proof-invalid' | 'claim-rate-limited' | 'claim-not-persisted'`. The phone needs to tell "already claimed" from "wrong secret" without parsing prose. `ApplySeedResult` and `SeedTrustDecision` gain the same optional `code`, and the inbound handler copies it into the ack (`handleSeedStream` → `replyAndClose`).
- `ControlNetworkSeed` stays as it is: the proof is not part of the seed, it rides beside it on the wire.

## Trust context (`seed-trust-policy.ts`)

`SeedTrustContext` gains:

- `localPeerId: string`, the receiver's own peer id (`libp2pNode.peerId.toString()` in `verifyAndMergeSeed`).
- `seedDigest: string`, computed once per seed in `verifyAndMergeSeed` and shared with the signature check.
- `claimProof?: string`, from the message.
- `remotePeerId?: string`, from the inbound handler; absent when `applySeed` is called locally.

`SeedTrustDecision` gains `code?: SeedRefusalCode`. The existing policies are untouched except that they compile against the wider context.

## `claimSecretTrustPolicy` (`seed-trust-policy.ts`)

```ts
claimSecretTrustPolicy(options: {
  secret: Uint8Array;                // parsed, 32 bytes
  trustedOwners: TrustedOwnerStore;  // the node's anchor: durable "claimed" marker
  onClaimed?: (signerKey: string) => void;
  failureLimit?: number;             // default 10
  failureWindowMs?: number;          // default 60_000
  now?: () => number;                // injectable for the rate-limit test
}): SeedTrustPolicy
```

`evaluate(ctx)` decides in this order, and everything up to and including setting the latch runs **synchronously, with no `await` before it**. That is the contract that makes two racing claimants safe, and the code must say so in a comment at the latch:

1. `ctx.knownOwnerKeys.has(ctx.signerKey)` → `{ trusted: true }`. The node was claimed by this owner earlier (possibly in an earlier process); no proof needed. This is also what makes a claimed node restarted with the secret still in its config ignore the secret.
2. `ctx.knownOwnerKeys.size > 0`, or the in-memory latch names another key → refuse, `code: 'already-claimed'`.
3. The latch names `ctx.signerKey` → `{ trusted: true }`. The same owner re-sent while the first delivery's persist is still in flight (dropped response): idempotent success.
4. No `ctx.claimProof` → refuse, `code: 'claim-proof-invalid'`, reason saying this node is unclaimed and accepts only a seed carrying its claim proof.
5. Rate limit tripped (more than `failureLimit` failed proofs inside the last `failureWindowMs`) → refuse, `code: 'claim-rate-limited'`, without verifying.
6. `verifyClaimProof(secret, ctx.localPeerId, ctx.signerKey, ctx.seedDigest, ctx.claimProof)` false → count one failure, refuse, `code: 'claim-proof-invalid'`.
7. Set the latch to `ctx.signerKey`. Then `await trustedOwners.trust(ctx.signerKey, 'claim')`. On success call `onClaimed?.(signerKey)` and return `{ trusted: true }` with **no `anchorAs`**: the policy anchored the key itself and awaited its durability, so `anchorAcceptedSigner` in the service has nothing to do. On a rejected persist: `await trustedOwners.remove(ctx.signerKey)` (best effort, log a failure), clear the latch, refuse with `code: 'claim-not-persisted'`.

Why the policy anchors itself instead of returning `anchorAs: 'claim'`: `SeedBootstrapService.anchorAcceptedSigner` deliberately logs and continues when a persist fails, which is right for a pin that is re-supplied at the next start but wrong for a claim, where a lost anchor would leave the node unclaimed again after a restart with nobody told. The claim must be durable before the ack says accepted. Keeping the latch, the anchor write and the rollback in one object is what lets the refusal be definite.

Why a node-wide rate limit rather than per peer: libp2p peer ids are free to mint, so a per-peer limit is bypassed by reconnecting. With a 256-bit secret, guessing is infeasible either way; the limit bounds CPU and log noise, not security. Say that in the doc comment.

## `TrustedOwnerStore` (`trusted-owner-store.ts`)

- `TrustSource` gains `'claim'`. `KNOWN_SOURCES` must include it, or a persisted claim anchor is discarded on reload under the discard-all policy and the node silently comes back unclaimed. Add one case to the existing persistence round-trip test in `test/trusted-owner-store.spec.ts` that a `'claim'` entry survives reload; this is the test that pays for itself here.
- Add `remove(ownerKey: string): Promise<void>` to the interface and both backends (`MemoryTrustedOwnerStore`; `PersistentTrustedOwnerStore` over `NodeLocalSnapshot.remove`, which already exists with the right contract: in-memory synchronously, then the full snapshot persisted). Update the module's "Keys are additive" paragraph: removal exists now, used by the claim rollback here and by the planned owner-removal work in `owner-anchor-follows-owner-key-changes`.

## `SeedBootstrapService` (`seed-bootstrap.ts`)

- `readSeedFrame` returns the seed and the `claimProof` separately (the `ControlNetworkSeed` type does not carry it); `handleSeedStream` passes `{ claimProof, remotePeerId }` into `verifyAndMergeSeed`, which fills the new context fields.
- `verifyAndMergeSeed` computes `seedDigest(seed)` once and passes it to both `validateSeedSignature` (refactor it to take the digest) and the trust context.
- The refusal path copies `decision.code` into `ApplySeedResult.code`, and the handler copies it into the ack.
- `deliverSeed(target, seed, options?: { claimProof?: string })`, where `target` is a multiaddr string as today **or** `{ peerId: string; multiaddrs: string[] }`. For the object form, merge the addresses into the peer store (`mergeSeedPeers` already does exactly this for a `SeedPeer` list) and `dialProtocol(peerIdFromString(peerId), SEED_PROTOCOL, { signal })`, so an existing connection is reused and libp2p tries every address under the one existing delivery deadline. The claim proof is set on the outgoing `SeedMessage` in `sendSeed`. `CadreNode.deliverSeed` forwards both.
- The service's doc comment on `anchorAcceptedSigner` ("Failure to PERSIST does not fail the seed") stays true for pins and TOFU; add one sentence pointing at the claim policy as the case that anchors itself for the opposite reason.

## Docs (`docs/architecture.md` → Seed Delivery Protocol)

- Message types: add `claimProof` to the `SeedMessage` listing and `code` to the ack.
- Trust sources list: add a **Claim secret** entry between "Pinned out-of-band" and "TOFU": what the proof binds, that the node anchors the signer under source `claim` and that anchor is the durable "claimed" marker, that a claimed node ignores a later proof, and that one failure is `already-claimed` versus `claim-proof-invalid`. One paragraph on the construction (the HMAC and its three bound fields) so a reader can reimplement the phone side.
- Node-local trusted-owner anchor paragraph: add `claim` to the list of out-of-band provenances, and note that the anchor can now remove a key.

## Edge cases & interactions

- **Two claimants race** (both hold the secret): the latch is set synchronously before the first `await`, so the second `evaluate` sees it and gets `already-claimed`. Test: two concurrent `evaluate` calls with valid proofs for different signer keys; exactly one trusted, the other `already-claimed`, the anchor holds one key.
- **Wrong secret**: `claim-proof-invalid`, nothing anchored. Test, in the same spec: after `failureLimit` wrong proofs inside the window a correct proof is refused `claim-rate-limited`; after the window (injected `now`) it is accepted.
- **Same owner re-sends after a dropped response**: step 1 (already anchored) or step 3 (persist in flight) answers trusted, not `already-claimed`. Test: evaluate twice with the same signer key; both trusted; `trust` was called once.
- **Persist fails**: the key is removed from the in-memory anchor, the latch clears, the caller gets `claim-not-persisted` and can retry. A claimant refused `already-claimed` during that in-flight window was refused wrongly and simply retries; acceptable, name it in the policy comment. By inspection.
- **Crash between the anchor persist and the peer-store merge**: the anchor write is the commit point, so after a restart the node is claimed and the owner's next seed is accepted on the anchored path. Nothing merged from a phone-signed seed is needed to recover: a phone lists no addresses, and the phone keeps dialing the node (`addDrone` retains the addresses). By inspection.
- **Proof with no secret configured** (a node using `anchoredTrustPolicy` or a pinned policy): the field is ignored; those policies never read it. By inspection.
- **Persisted anchor with source `claim` read by the discard-all loader**: covered by `KNOWN_SOURCES` and the round-trip test above.
- **Proof binding**: one test in `test/claim-proof.spec.ts` that a proof verifies, and fails when any one of node peer id, signer key or seed digest changes. One test, three mutations.
- **Seed size cap, `seedReadTimeoutMs`, `maxConcurrentSeeds`, the ack-before-owner-dials ordering**: unchanged; the proof is a short string inside the same frame.
- **TOFU note in `handleSeedStream`** (a human prompt inside the sender's deadline): the claim policy awaits a disk write, not a human; it fits inside `seedDeliverTimeoutMs` by a wide margin.
- **Cross-platform**: `claim-proof.ts` imports only `@noble/hashes`, `uint8arrays` and `canonical-json.ts`; nothing Node-only.

## TODO

- `claim-proof.ts` with `parseClaimSecret`, `seedDigest`, `claimProof`, `verifyClaimProof`; `@noble/hashes` dependency; exports.
- `TrustSource 'claim'`, `KNOWN_SOURCES`, `TrustedOwnerStore.remove` on both backends; doc comment update; round-trip test case.
- `SeedTrustContext` / `SeedTrustDecision` / `SeedMessage` / `SeedAckMessage` / `ApplySeedResult` fields; `SeedRefusalCode`.
- `claimSecretTrustPolicy` with latch, rate limit, self-anchoring and rollback.
- `SeedBootstrapService`: proof through the frame and the context, digest hoisted, `code` into the ack, `deliverSeed` object target and `claimProof` option.
- Tests: `test/claim-proof.spec.ts` (binding), `test/seed-trust-policy-claim.spec.ts` (race, wrong secret and rate limit, idempotent re-send), the store round-trip case.
- docs/architecture.md → Seed Delivery Protocol as above.
- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-core test`, and `yarn lint` from the root.
