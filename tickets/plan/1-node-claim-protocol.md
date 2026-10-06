description: A new cadre node waiting to be added to someone's cadre should accept its first seed only from the person holding a one-time secret shown on the host's screen. The phone delivers the seed over the existing stranger-open seed protocol, instead of the host relaying it through HTTP routes.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/trusted-owner-store.ts, packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-cli/src/config/env.ts, docs/architecture.md
difficulty: hard
----

# Claiming an unclaimed node with a seed and a one-time secret

## Why

cadre-host is being reframed (see `cadre-host-join-a-cadre`). Its main job becomes running *your own* always-on node in a cadre you started on your phone. The host operator sets this up out of band: the host shows a QR code, the phone scans it and dials the node. The phone cannot be dialed, so the phone dials the node and the payload has to carry the node's addresses.

Today the add-a-node step is split across HTTP routes on the host (`POST /grants`, `GET /grants/:id/peer`, `PUT /grants/:id/seed`). The owner key is pinned only through `CADRE_OWNER_KEYS` at spawn. Until the party rows arrive, the node admits any peer that can reach it (docs/cadre-host.md → "Who dials whom"). That gap is tolerable on loopback, but this node is about to be exposed to the internet.

## What exists to build on

The meta layer is already there. The control network's connection gate lets strangers use exactly two protocols, `/sereus/seed/1.0.0` and `/sereus/formation/1.0.0`, each with its own in-protocol trust check (docs/architecture.md → "Seed Delivery Protocol"). The seed protocol's "direct" mechanism is this case: the instigator dials the new node and sends a `SeedMessage`, and the node answers with a `SeedAck`. What is missing is **trust**. A fresh node's `SeedTrustPolicy` rejects every seed unless the signer's key reached it out of band (spawn pin, invite `ownerKeys`, TOFU prompt). The claim secret is that out-of-band channel.

## What to build

No new protocol. Extend the seed protocol and add one trust policy:

- **Claim secret.** A node can start with a claim secret (high-entropy; config/env, e.g. `CADRE_CLAIM_SECRET`) and an empty anchor. The secret never enters replicated state.
- **Proof in the seed message.** `SeedMessage` gains an optional claim proof that the node can check and a passive observer cannot replay, e.g. an HMAC keyed by the secret over the node's peer id, the `signerKey` and the seed digest. That binds the proof to this node and this seed, so it cannot be moved to another seed or another node. Settle the construction in planning and version the message.
- **`claimSecretTrustPolicy`** in `seed-trust-policy.ts`: the signer is trusted iff the proof verifies and the node is not yet claimed. On accept it anchors the signer key (`anchorAs` a new `claim` source, or `operator`) and durably marks the node claimed. From then on the anchored policy applies as usual, and a later seed signed by the same owner needs no proof.
- **Gate while unclaimed.** A node holding a claim secret and an empty anchor admits strangers only on `/sereus/seed/1.0.0`; formation and control-DB streams wait until it is claimed. Today an un-enrolled node admits everything, which is too open for a node exposed to the internet.
- **Phone side.** Scan → `addDrone({ dronePeerId, droneMultiaddrs })` (both are in the QR) → `deliverSeed` with the claim proof attached. `addDrone` keeps the addresses, so the phone's reconcile pass keeps dialing the node afterwards. Add a small `claimNode({ peerId, multiaddrs, secret })` helper over those two calls.

## Edge cases & interactions

- Two claimants racing: exactly one wins; the loser gets a definite "already claimed" answer, not a hang. (Test.)
- Wrong secret: refused; guesses are rate-limited per connection/peer. (Test.)
- Crash between accepting the claim and applying the seed: after restart the node is either still unclaimed or fully claimed, never half. (Inspection; write the claimed marker last.)
- The same owner re-sends the claim after a dropped response: treat it as idempotent success, not "already claimed". (Test.)
- A claimed node restarted with the secret still in its config ignores the secret.
- A host respawn keeps the identity key and the claimed state (workdir survives).
- The claim anchors exactly one key, the claimant's. Owners added to the cadre later reach this node's anchor through `owner-anchor-follows-owner-key-changes`, not through the claim.
- The claim policy composes with the other trust sources (spawn pin, anchor). A node spawned with both a pin and a claim secret is a configuration error; reject it at start.
- Seed size limits and the receiver hardening (`seedReadTimeoutMs`, `maxConcurrentSeeds`) apply unchanged.

## TODO

- Settle the proof construction; document it in docs/architecture.md under "Seed Delivery Protocol" (trust sources) and add a row to "Which Side Dials".
- Implement the policy, the `SeedMessage` field, the unclaimed gate and the cadre-cli config/env.
- `claimNode` helper in cadre-core.
- Integration test: a phone-shaped requester (no listen addrs, ws only) claims a cadre-cli child and syncs into its party.
