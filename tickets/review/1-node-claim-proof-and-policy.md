description: Let a brand-new node accept its first seed only from someone who can prove they hold the node's one-time claim secret, by adding a claim proof to the seed message and a trust policy that checks it.
architecture: docs/architecture.md#seed-delivery-protocol
files: packages/cadre-core/src/claim-proof.ts (new), packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/package.json, yarn.lock, packages/cadre-core/test/claim-proof.spec.ts (new), packages/cadre-core/test/seed-trust-policy-claim.spec.ts (new), packages/cadre-core/test/trusted-owner-store.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, packages/cadre-cli/test/start-pins.spec.ts, docs/architecture.md
difficulty: hard
----

# Claim proof in the seed message, and the claim-secret trust policy — review handoff

First of three tickets (then `node-claim-gate-and-helper`, then `node-claim-cli-and-scenario`). This landed the protocol and the policy inside `@serfab/cadre-core`, below `CadreNode`. Nothing about how a node is configured or gated changed; `CadreNode` only gained the widened `deliverSeed` signature. The next ticket wires the policy into `CadreNode` and adds `claimNode`.

## What landed

**`claim-proof.ts` (new).** `parseClaimSecret(text)` decodes base64url and refuses anything that is not exactly 32 bytes, naming the problem and never echoing the value. `claimProof(secret, nodePeerId, signerKey, seedDigest)` is base64url of HMAC-SHA256 (from `@noble/hashes`, now a direct `^2.0.0` dependency of cadre-core, the same range `@serfab/cadre-rn` carries) keyed by the secret over the UTF-8 bytes of `canonicalJson({ purpose: 'sereus-node-claim', v: 1, nodePeerId, signerKey, seedDigest })`. `verifyClaimProof(...)` recomputes and compares with a plain XOR-accumulating loop. The module imports only `@noble/hashes`, `uint8arrays`, `canonical-json.ts` and `debug`.

**`seedDigest(seed)`** is exported from `seed-bootstrap.ts`, beside `canonicalSeedPayload`, and used by `createSeed`, `validateSeedSignature` and the trust context. The ticket placed it in `claim-proof.ts`, but that would have made `claim-proof.ts` import `seed-bootstrap.ts` while `seed-bootstrap.ts` imports `claim-proof.ts` (a module cycle), and would contradict the ticket's own cross-platform import list for the module. The function is exported from `index.ts` in the seed-bootstrap block, with the claim-proof exports right below pointing at it.

**Types.** `SeedMessage.claimProof?`, `SeedRefusalCode`, `SeedAckMessage.code?`, `ApplySeedResult.code?`, `SeedTrustDecision.code?`, and `SeedDeliveryTarget` (a multiaddr string or `{ peerId, multiaddrs }`). `SeedTrustContext` gained `localPeerId`, `seedDigest`, `claimProof?`, `remotePeerId?`. `SeedTrustDecision.anchorAs` is now `Exclude<TrustSource, 'genesis' | 'claim'>`: a policy cannot ask the service to anchor a claim through the log-and-continue path, by type.

**`claimSecretTrustPolicy`** in `seed-trust-policy.ts`, with the seven-step decision order from the ticket, the latch set before the first `await` (comment at the site), a node-wide sliding-window failure count, self-anchoring under source `claim` with an awaited persist, and rollback (`remove` plus latch clear) on a rejected persist. One reading of the ticket resolved: the limit trips when `failureLimit` failures sit inside the window (the test in the ticket says "after `failureLimit` wrong proofs a correct proof is refused"), not at `failureLimit + 1`. `onClaimed` is called after the persist succeeds and is guarded: a throwing callback is logged and the claim stands.

**`TrustedOwnerStore`.** `TrustSource` gained `'claim'`, `KNOWN_SOURCES` lists it (with a comment on why the discard-all loader makes that mandatory), and `remove(ownerKey)` exists on the interface and both backends. The module doc's additive paragraph now names the two removers.

**`SeedBootstrapService`.** `readSeedFrame` returns `{ seed, claimProof }`; `handleSeedStream` passes `{ claimProof, remotePeerId }` into `verifyAndMergeSeed`, which computes the digest once, fills the new context fields, and copies `decision.code` into the result; the handler copies it into the ack. `validateSeedSignature(seed, digestB64 = seedDigest(seed))` keeps its one-argument public form (integration scenarios call it) and takes the digest when the caller has it. `deliverSeed(target, seed, options?)` accepts the object target: `resolveDeliveryTarget` merges the addresses through `mergeSeedPeers` and returns the parsed peer id for `dialProtocol`, so the dial reuses an existing connection and tries every address under the one deadline. The merge runs before `withDeadline` starts, since it is a local peer-store write. `localPeerId` is `this.libp2pNode.peerId?.toString() ?? ''`, optional-chained like `dialSeedOwners` because unit-test doubles omit `peerId`; a proof bound to a real peer id can only fail against the empty string.

**`CadreNode.deliverSeed`** forwards the target and options and now returns `SeedAckMessage` (structurally the old `{ accepted, reason? }` plus `code?`).

**Docs.** `docs/architecture.md` → Seed Delivery Protocol: `claimProof` and `code` in the message listing with the no-version reasoning, a **Claim secret** entry between Pinned and TOFU giving the construction, the three bindings, the self-anchoring rationale, `already-claimed` versus `claim-proof-invalid`, the race latch and the rate limit; the node-local anchor paragraph lists `claim` and the new `remove`.

## Tests

- `test/claim-proof.spec.ts` → "verifies for the node, signer and seed it was built over, and for no other": one proof verifies, and fails when any one of the three bound fields changes.
- `test/claim-proof.spec.ts` → "parseClaimSecret accepts 32 base64url bytes and names, without echoing, what it refuses": trims and accepts a valid secret; refuses a 16-byte value with a message that does not contain the value; refuses non-base64url and blank input. Not in the ticket's list; added because the parser is the boundary both ends depend on and has three refusal branches.
- `test/seed-trust-policy-claim.spec.ts` → race: two concurrent `evaluate` calls with valid proofs for different signers; exactly one `trusted`, the other `already-claimed`, the anchor holds one key.
- `test/seed-trust-policy-claim.spec.ts` → wrong secret and rate limit: three wrong proofs are `claim-proof-invalid` and anchor nothing; a correct proof is then `claim-rate-limited`; after the injected clock passes the window it is accepted.
- `test/seed-trust-policy-claim.spec.ts` → idempotent re-send: the same signer evaluated while the first persist is in flight (latch) and again after it landed (anchor) is trusted each time; `trust` and `onClaimed` were each called once.
- `test/seed-trust-policy-claim.spec.ts` → persist failure (ticket said "by inspection"; added because the rollback is the one branch that touches two states): `claim-not-persisted`, nothing anchored, `onClaimed` not called, and a different owner can claim afterwards, which proves the latch cleared.
- `test/seed-trust-policy-claim.spec.ts` → an unclaimed node refuses a seed with no proof as `claim-proof-invalid`; a claimed node refuses another owner's valid proof as `already-claimed`. Two short tests, not in the ticket's list; the second is the "secret is spent once claimed" property.
- `test/trusted-owner-store.spec.ts` → "a key anchored by a claim survives reload": the `KNOWN_SOURCES` case the ticket asked for. Also a contract-suite case for `remove()` on both backends (synchronous visibility, absent key a no-op).
- `test/seed-bootstrap.spec.ts` → "claims an unclaimed node over the wire": sender `deliverSeed` with the object target and a claim proof, receiver running `claimSecretTrustPolicy` with a real peer id, over the existing duplex-pair harness. A proof minted for another node comes back `accepted: false, code: 'claim-proof-invalid'` with nothing anchored; the right proof is accepted and the anchor holds the signer; the sender merged the addresses and dialed by peer id both times. Not in the ticket's list; it is the only test that exercises the frame, the context fill and the ack code together.
- Existing tests touched only to compile: two hand-built store doubles in `seed-bootstrap.spec.ts` gained `remove`; three hand-built trust contexts (`seed-bootstrap.spec.ts`, `cadre-cli/test/start-pins.spec.ts`) gained `localPeerId` and `seedDigest`.

## Validation

- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn workspace @serfab/cadre-cli typecheck`: clean.
- `yarn workspace @serfab/cadre-core build`, then `yarn workspace @serfab/cadre-host typecheck` and `yarn workspace @serfab/integration-tests typecheck` against the new dist: clean (integration scenarios call `deliverSeed` with a string target, still valid).
- `yarn lint` from the root: clean.
- `yarn workspace @serfab/cadre-core test`: 155 files, 2392 passed, 1 skipped. The skip is pre-existing in a spec this ticket did not touch. Log at `tickets/.logs/node-claim-proof-and-policy.test.log`.
- `yarn install` was run to record the new dependency; the only `yarn.lock` change is the one line under the cadre-core workspace entry.

## For the reviewer

- **Tests beyond the ticket's list** are marked above. Cut any that do not meet the bar.
- **`seedDigest` location** differs from the ticket (see above). If the reviewer prefers it in `claim-proof.ts`, `canonicalSeedPayload` would have to move with it or the cycle accepted.
- **Empty `localPeerId` fallback** exists only for test doubles. The claim policy does not special-case it; with a real libp2p node it is never empty. If a stricter stance is wanted, the policy could refuse an empty `localPeerId` outright.
- **`remotePeerId`** is only read for a log line in the claim policy; it is plumbed as the ticket specified for later policies.
- **`resolveDeliveryTarget` and a target with no usable address**: `mergeSeedPeers` drops malformed addresses and skips an empty list, so the dial by peer id then fails with libp2p's own error unless a connection already exists. A malformed peer id throws before anything is dialed.
- **No `CadreNode`-level or integration coverage** here by design; `node-claim-gate-and-helper` and `node-claim-cli-and-scenario` own that.
