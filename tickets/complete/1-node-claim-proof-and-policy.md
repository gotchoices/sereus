description: Let a brand-new node accept its first seed only from someone who can prove they hold the node's one-time claim secret, by adding a claim proof to the seed message and a trust policy that checks it.
architecture: docs/architecture.md#seed-delivery-protocol
files: packages/cadre-core/src/claim-proof.ts (new), packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, yarn.lock, packages/cadre-core/test/claim-proof.spec.ts (new), packages/cadre-core/test/seed-trust-policy-claim.spec.ts (new), packages/cadre-core/test/trusted-owner-store.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-cli/test/start-pins.spec.ts, docs/architecture.md, docs/api.md
difficulty: hard
----

# Claim proof in the seed message, and the claim-secret trust policy

First of three tickets (then `node-claim-gate-and-helper`, then `node-claim-cli-and-scenario`). Landed in `ticket(implement): node-claim-proof-and-policy`; reviewed here.

## What shipped

- **`claim-proof.ts`** (new, cross-platform: `@noble/hashes`, `uint8arrays`, `canonical-json.ts` only). `parseClaimSecret` refuses anything but base64url of exactly 32 bytes without echoing the value. `claimProof` is base64url of HMAC-SHA256 keyed by the secret over `canonicalJson({ purpose: 'sereus-node-claim', v: 1, nodePeerId, signerKey, seedDigest })`. `verifyClaimProof` recomputes and compares in constant time.
- **`seedDigest(seed)`** lives in `seed-bootstrap.ts` beside `canonicalSeedPayload` (not in `claim-proof.ts` as the plan said) so the two modules do not import each other; `createSeed`, `validateSeedSignature` and the trust context all use it.
- **Types.** `SeedMessage.claimProof?`, `SeedRefusalCode` (`already-claimed` | `claim-proof-invalid` | `claim-rate-limited` | `claim-not-persisted`) carried by `SeedAckMessage`, `ApplySeedResult` and `SeedTrustDecision`; `SeedDeliveryTarget` (multiaddr string or `{ peerId, multiaddrs }`); `SeedTrustContext` gained `localPeerId`, `seedDigest`, `claimProof?`, `remotePeerId?`. `SeedTrustDecision.anchorAs` excludes `'claim'` by type.
- **`claimSecretTrustPolicy`** in `seed-trust-policy.ts`: anchored signer trusted; any other anchored key or a latched other signer refused `already-claimed`; missing or wrong proof `claim-proof-invalid`; a node-wide sliding-window failure count (10 per minute by default, trips when `failureLimit` failures sit in the window) refusing `claim-rate-limited` without verifying; a verified proof latches the signer before the first `await`, anchors it under source `claim`, awaits durability, then calls `onClaimed`. A rejected persist removes the key, clears the latch and refuses `claim-not-persisted`.
- **`TrustedOwnerStore`**: `TrustSource` gained `'claim'` (listed in `KNOWN_SOURCES`, since the discard-all loader would otherwise drop the whole anchor on reload) and `remove(ownerKey)` on both backends.
- **`SeedBootstrapService`**: the inbound frame yields the proof beside the seed, `verifyAndMergeSeed` computes one digest for the signature check and the trust context and copies the refusal code through to the ack. `deliverSeed(target, seed, options?)` accepts the object target (addresses merged into the peer store, dial by peer id) and sends `claimProof` in the message. `CadreNode.deliverSeed` forwards both and returns `SeedAckMessage`.
- **Docs.** `docs/architecture.md` → Seed Delivery Protocol: message listing, a **Claim secret** entry with sub-paragraphs (construction, commit point, after the claim, rate limit), and the anchor paragraph lists `claim` and `remove`. `docs/api.md` shows the widened `deliverSeed` signature.

## Review findings

Read the implement diff first, then every file it touched and `docs/api.md`, which it should have touched. Ran `yarn lint`, `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-cli typecheck` and `yarn workspace @serfab/cadre-core test` after the edits below: all clean, 155 files, 2392 passed, 1 skipped (the pre-existing skip in a spec this ticket never touched). Log at `tickets/.logs/node-claim-proof-and-policy.review.test.log`.

**Checked.**

- Decision order of the policy against the plan's seven steps, including the latch being set before the first `await` (every branch above it is synchronous: set lookups, a clock read, the HMAC). The race, idempotent re-send, rollback and rate-limit tests exercise each branch; I re-read the rollback path for the two-state case (anchor plus latch) and the window where a competing claimant is wrongly told `already-claimed` during a rollback, which the comment at the site already names as accepted.
- Persist-failure semantics on `PersistentTrustedOwnerStore`: `trust` reflects in memory synchronously and `remove` rides `NodeLocalSnapshot.remove`, which already existed with the same sync-then-persist contract, so a failed claim leaves no key on disk and the in-memory anchor is cleared. A persist that reported failure after the bytes actually landed brings the node back claimed by the same signer, who is trusted on retry at step 1; harmless.
- Proof binding and verification: `nodePeerId` comes from the receiver's own libp2p handle, never the message; a non-base64url proof is invalid, not an exception; the comparison length check short-circuits on a public length only. The `@noble/hashes` v2 subpath imports with `.js` are correct and the dependency range matches `cadre-rn`. The `yarn.lock` entry `@noble/hashes@npm:^2.0.0` (2.2.0, beside libp2p's 2.0.1) predates this ticket; the only lock change is the workspace dependency line.
- Wire path: frame read, context fill, code copied into the ack, and the object target's merge-then-dial, all covered by the new `seed-bootstrap.spec.ts` case. The merge runs before `withDeadline` because it is a local peer-store write. A string target is unchanged, so `cadre-host`, `integration-tests` and the README example still compile and read correctly.
- Rate limit: the failure list is bounded by `failureLimit` entries (once the limit is reached nothing is pushed), missing-proof and `already-claimed` refusals are not counted (no CPU spent), and the limit trips at `failureLimit` failures as the implementer chose and the plan's test wording required.
- Compatibility of the widened `SeedTrustContext`: the three hand-built contexts in `seed-bootstrap.spec.ts` and `cadre-cli/test/start-pins.spec.ts` are the only ones outside cadre-core's source; no other package implements `TrustedOwnerStore` or builds a trust context.
- Tests: none cut. The two tests the handoff flagged as beyond the plan (`parseClaimSecret` refusals, the no-proof and already-claimed pair) pin the parser's three refusal branches with its non-echo guarantee and the two security defaults of the policy, and neither restates the implementation or verifies a mock. None added: every defect-shaped question I asked was already covered by a test or settled by reading.

**Found and fixed inline (minor).**

- `docs/api.md` still listed `deliverSeed(targetMultiaddr: string, seed)`; now shows the `SeedDeliveryTarget` form and the `claimProof` option.
- The **Claim secret** entry in `docs/architecture.md` was one paragraph describing a mechanism with four parts, against the project rule of one claim per list item. Split into a one-sentence item plus labelled sub-paragraphs, the pattern the neighbouring anchor bullet already uses. No content changed.
- `ClaimSecretTrustPolicyOptions.trustedOwners` now states that it must be the same store the service snapshots into `knownOwnerKeys`, since steps 1 and 2 read that snapshot. A constraint for the next ticket's wiring that the code otherwise left implicit.

**Major.** None. No finding named a site that must change or a class-level invariant worth a ticket.

**Tripwires.** None new. The two conditional concerns I weighed already carry their explanation at the site: the empty `localPeerId` fallback for test doubles (`verifyAndMergeSeed`; a real node always has a peer id, and a proof bound to one can only fail against the empty string) and the rollback window (`rollbackClaim` doc comment). Neither needs a `NOTE:` beyond what is there.

**Considered and declined.** Moving `seedDigest` into `claim-proof.ts` as the plan said: it would create an import cycle with `seed-bootstrap.ts` and break the module's cross-platform import list. The implementer's placement stands. Refusing an empty `localPeerId` in the policy: it cannot widen what a proof accepts (the sender still needs the secret), so the stricter check would only guard test doubles.

**Left for the next tickets by design.** No `CadreNode`-level wiring, gating or integration coverage; `node-claim-gate-and-helper` and `node-claim-cli-and-scenario` own those.
