description: A node waiting to be claimed no longer has to be told in advance which cadre it will serve. The claim itself names the cadre, the node records that and switches over to it, and it comes back into the same cadre after any restart.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-trust-policy-claim.spec.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/src/config/env.ts, packages/cadre-cli/README.md, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md
difficulty: hard
----

# The claim carries the party id

First of the `cadre-host-join-a-cadre` chain (this → `cadre-host-remove-founder-role` → `cadre-host-hosted-nodes-join-by-qr` → `cadre-host-join-ui` → `cadre-host-join-by-invitation` → `cadre-host-join-docs`). This one is cadre-core and cadre-cli only; cadre-host is untouched.

## The problem

`node-claim-cli-and-scenario` left one gap: a node serves the party its config names (`controlNetwork.partyId`, required at start), and a claim does not change it. `SeedBootstrapService.verifyAndMergeSeed` never compares the seed's party with the node's. A node spawned for some other party accepts the claim and then never syncs with its owner, because cadre-core keys everything on the party id: the control network name (`control-<partyId>` in `control-database.ts`), the control storage scope, and the file names of the trusted-owner anchor, the retained dial targets, the enrolled-machine count and the strand network state (`<dir>/<store>.<partyId>.json`).

The host that starts an unclaimed node cannot know the party: the phone that will claim it has not been in touch yet, and the host does not listen for requests (settled in the plan). The only channel between the phone and the node before the claim is the claim seed, and `ControlNetworkSeed.partyId` is already in it, signed. So the party comes from the claim.

## Design

**cadre-core records the claim, party included, before it anchors the claimant.**

- `CadreNodeConfig.claim` gains `record: (claim: NodeClaimRecord) => Promise<void>` beside `secret`, with `NodeClaimRecord = { partyId: string; ownerKey: string }`. `CadreNode.initializeClaimPolicy` threads it into `claimSecretTrustPolicy` as `recordClaim`.
- In the policy, `anchorClaim` takes the seed's party (`SeedTrustContext.partyId`) and runs in this order: `recordClaim({ partyId, ownerKey: signerKey })`, then `trustedOwners.trust(signerKey, 'claim')`. A record failure refuses `claim-not-persisted` with nothing anchored and the latch cleared, exactly as an anchor failure does today. Record first, anchor second: a crash between the two leaves a record and an empty anchor, and the next start (below) takes the claimed path from the record, so the claimant that was refused `claim-not-persisted` retries and is accepted idempotently by the same owner. The other order would leave an anchored node with no record, serving the placeholder party forever.
- `claim:accepted` carries `{ ownerKey, partyId }`.
- The `NOTE:` in `verifyAndMergeSeed` that says nothing downstream reads `seed.partyId` is now false for the claim path; reword it to say the claim policy records it, and that a mismatch is still not rejected because an unclaimed node's own party is a placeholder.

**cadre-cli keeps the record in the node-state directory and starts from it.**

- `claim.json` in `config.nodeStateDir`, the party-independent name on purpose, since the party is what it records: `{ version: 1, partyId, ownerKey, claimedAt }`, written atomically (write to `.tmp`, rename). A present but malformed file refuses the start with a clear error: a node that silently started unclaimed would be claimable by anyone holding the secret while its owner's cadre loses it.
- On every `cadre start`, after `resolveConfig`: read the record. If it exists, the party is the record's (`config.controlNetwork.partyId` is a placeholder and is ignored, with a console line saying so); open the four file stores under that party; anchor the record's `ownerKey` with source `'claim'` on the trusted-owner store when it is not already there; pass `claim: { secret, record }` only if `CADRE_CLAIM_SECRET` is set, so a rival claim is still answered `already-claimed` (the scenario's step 4) rather than as an untrusted seed; never pass pinned keys, since `claim` beside pins is refused by cadre-core. If the secret is unset but the record exists, the record is still honoured and the node starts with no `claim` block.
- If no record exists and the secret is set, start under the config's party as today, with `record` writing `claim.json`. On `claim:accepted`, restart in-process into the claimed party: stop the node, build a new one through the same path the record-present start uses, re-attach the health server (`HealthServer.attach`), start it. Factor the node construction and event wiring out of the `start` action into one function both paths call; the shutdown handler and the health server must reference the current node. A restart that fails (a store that will not open, a port that will not rebind) exits the process non-zero rather than leaving a process with no node in it: the embedder's supervisor respawns it, and that start takes the claimed path from the record.
- The config's party for an unclaimed node is a placeholder. The README says to use `unclaimed`. The files the placeholder party created (`trusted-owners.unclaimed.json` and the like) are left where they are; nothing opens them again. Say so in a code comment.
- `--seed`, `--invitation`, `--owner` and pins are already refused beside a claim secret (`refuseClaimConflicts`); the restart path therefore never has to carry them.

**`/status`.**

- `node.claim` becomes: `claimed` when a claim record exists (started from one, or written in this process), `awaiting` when the secret is set and no record exists, `none` otherwise. This replaces the running-state rule from `node-claim-cli-and-scenario` (`claimed` only while running and not awaiting), because the in-process restart would otherwise flip a poller from `claimed` to `awaiting` and back. The concern that rule guarded against, a premature `claimed`, cannot arise: the record is written only after the proof is verified and before the ack. Update the doc comment on `claimState`.
- `node.partyId` already reports the running node's party, so after the restart it names the claimed party. Add `node.claimedBy?: string`, the record's owner key (base64url), present when `claim` is `claimed`. cadre-host's join flow reads both to show "claimed by `<first 8 chars>` into cadre `<party>`".

## Edge cases & interactions

- Record written, anchor persist fails: the policy rolls the anchor back and refuses `claim-not-persisted`; the record stands. Next start reads it and starts claimed by that owner; the retrying claimant is accepted idempotently. Verified by inspection of the ordering plus the unit test below.
- Record write fails: `claim-not-persisted`, nothing anchored, latch cleared. Unit test.
- A second claimant during the restart window: the node is down, the dial fails and the phone retries; after the restart it is answered `already-claimed`. Scenario step 4 covers the after-restart case; the window itself is by inspection.
- Restart while unclaimed (no record): same placeholder party, same secret, same identity, so the claim details a host already showed stay valid. Scenario step 6 before the claim is not exercised; by inspection.
- Malformed `claim.json`: start refuses, loudly. By inspection.
- `CADRE_CLAIM_SECRET` unset, record present: honoured, `/status` reads `claimed`. By inspection.
- The secret never reaches a log line and is not in the record. Scenario step 6 already asserts the log never contains it; the record file is asserted secret-free in step 3.
- One `claim:accepted` per process: the policy latches the signer. By inspection.
- The in-process restart rebinds the same listen ports (`CADRE_LISTEN_ADDRS` is unchanged). If libp2p's close does not release them in time, the restart fails and exits as above; the scenario would catch it.

## Tests

- `seed-trust-policy-claim.spec.ts`: one new case pinning the contract that the claim is recorded before it is anchored and a record failure leaves the node unclaimed (call order observed through fakes; `claim-not-persisted`; anchor empty).
- `node-claim-by-phone.integration.ts` is the proof: the child's config now names the placeholder party `unclaimed` (drop the header paragraph that explains why it named the claimant's party), step 3 additionally asserts `/status` reports the claimant's party and `claimedBy` equal to the claimant's owner key, that `claim.json` exists in the workdir and does not contain the secret, and that the log carries the restart line; step 6 asserts the restarted node still reports the claimant's party. The header's pointer to `tickets/plan/3-cadre-host-join-a-cadre.md` becomes `cadre-host-hosted-nodes-join-by-qr`.
- No cadre-cli unit test for the restart: it is wiring over `CadreNode.start`, and the scenario exercises it.

## Docs

- cadre-cli README, "Waiting to be claimed": the placeholder party, `claim.json`, the restart, the `/status` fields, and that the secret may stay set after the claim.
- docs/architecture.md, the claim-secret entry under the trust-policy list: one sentence that the claim seed's party becomes the node's and is recorded node-locally.

## TODO

- cadre-core: `record` on `CadreNodeConfig.claim`, `recordClaim` in the policy with the record-then-anchor order, `partyId` on `claim:accepted`, the reworded `NOTE:` in `verifyAndMergeSeed`, the unit test.
- cadre-cli: `claim.json` read/write, the record-present start path, the in-process restart on `claim:accepted`, the `/status` rule and `claimedBy`.
- Scenario and README and architecture.md updates.
- `yarn lint`, cadre-core and cadre-cli suites, `yarn workspace @serfab/integration-tests test node-claim-by-phone`. Rebuild cadre-core and cadre-cli first (the stale-build guard).
