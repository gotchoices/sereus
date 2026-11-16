description: When an owner claims a new node and sends the claim a second time while the node is still saving the first, the node answers the second one "accepted" straight away; if the save then fails, the owner has been told the node is theirs while the node has recorded nothing.
architecture: docs/cadre/membership.md#what-the-node-does-with-a-valid-proof
files: packages/cadre-core/src/seed-trust-policy.ts (`claimSecretTrustPolicy`: `evaluate`, `anchorClaim`, `rollbackClaim`, `latchedSigner`), packages/cadre-core/src/seed-bootstrap.ts (`applySeed`, the caller that acts on the decision), packages/cadre-core/test/seed-trust-policy-claim.spec.ts
repro: static
severity: edge-case
likelihood: contrived
tradeoffs: It needs a re-send to land inside the short window of the first delivery's two writes and one of those writes to fail, and the owner's next attempt repairs it, so the fix buys correctness in a case that may never have happened.
----

# A claim re-sent during the first delivery's save is trusted before anything is saved

## Background

A node started with a claim secret accepts the first seed that proves possession of the secret (`claimSecretTrustPolicy` in `seed-trust-policy.ts`). Acceptance is meant to be definite: the policy makes two durable writes, `recordClaim` and then `trustedOwners.trust(key, 'claim')`, and answers trusted only after both. If either fails it answers `claim-not-persisted`, leaves nothing anchored and the owner retries. The policy's comment gives the reason: "a lost claim anchor would leave the node unclaimed again after a restart with nobody told".

To stop two claimants racing, `evaluate` sets an in-memory latch (`latchedSigner`) to the claimant's key before its first `await`.

## The defect

Step 3 of the documented decision order handles a re-send by the same owner: "The latch names `K` → trusted. The same owner re-sent while its first delivery's persist is still in flight (a dropped response); idempotent success." In `evaluate` that is

```ts
if (latchedSigner === ctx.signerKey) {
  return { trusted: true };
}
```

returned synchronously, without waiting for the first delivery's `anchorClaim` to settle and without looking at the claim proof.

If the first delivery's `recordClaim` or anchor write then rejects, `anchorClaim` clears the latch and answers the first delivery `claim-not-persisted`. The second delivery has already been answered trusted, and its caller (`SeedBootstrapService.applySeed`) has gone on to apply the seed and acknowledge it. One delivery was accepted with nothing anchored, which is the outcome the two awaited writes exist to prevent:

- The owner's device may see the acknowledgement of the second delivery and treat the node as claimed.
- When `recordClaim` failed, the node holds no record and no anchor. It is unclaimed, still accepts a claim from anyone holding the secret, and after a restart serves its placeholder party.
- When only the anchor write failed, the record stands and an embedder that starts from its record comes up claimed by that owner, so this half heals at the next start.

The success is not idempotent while the first outcome is unknown. It is idempotent only once that outcome is success.

## Expected behaviour

A re-send by the latched signer gets the same answer as the delivery it duplicates: trusted if the claim became durable, `claim-not-persisted` if it did not. Keeping the in-flight claim's promise beside the latch and returning it from step 3 would do that; `evaluate` may already return a promise.

Whether a re-send should also have to carry a valid proof is a smaller question for the same change. Today any seed signed by the latched key is trusted during the window, proof or not. The signer is the legitimate claimant, so this admits nobody new.

## Evidence and confirmation

Read from `seed-trust-policy.ts`; not run. The existing case "the same owner re-sending after a dropped response is trusted each time and anchored once" in `seed-trust-policy-claim.spec.ts` pins the latch answer only where the first persist succeeds. To confirm the failing half, in the same file: build the policy with a `recordClaim` that returns a promise the test controls, call `evaluate` with a valid proof (it stays pending), call `evaluate` again with the same signer, then reject the first promise. The second call has already resolved `{ trusted: true }`, the first resolves `claim-not-persisted`, and the anchor is empty.

`tickets/backlog/host-tofu-seed-trust-confirmation.md` names the same file for a different policy (`tofuTrustPolicy`) and lists "concurrent seed deliveries racing one prompt" among its design cases; a shared in-flight-decision helper could serve both, but neither ticket depends on the other.
