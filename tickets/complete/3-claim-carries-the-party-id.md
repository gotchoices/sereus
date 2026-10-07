description: A node waiting to be claimed no longer has to be told in advance which cadre it will serve. The claim itself names the cadre, the node records that and switches over to it, and it comes back into the same cadre after any restart.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-trust-policy-claim.spec.ts, packages/cadre-cli/src/commands/claim-record.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/start-node.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/test/claim-record.spec.ts, packages/cadre-cli/README.md, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md, docs/api.md, docs/testing.md
difficulty: hard
----

# The claim carries the party id — complete

First of the `cadre-host-join-a-cadre` chain (this → `cadre-host-remove-founder-role` → `cadre-host-hosted-nodes-join-by-qr` → `cadre-host-join-ui` → `cadre-host-join-by-invitation` → `cadre-host-join-docs`). cadre-core and cadre-cli only; cadre-host untouched.

## What landed

Implemented in `ticket(implement): claim-carries-the-party-id`, reviewed and adjusted here.

- **cadre-core records the claim before it anchors the claimant.** `NodeClaimRecord = { partyId, ownerKey }`. `CadreNodeConfig.claim.record` is required beside `secret`; the claim policy runs it with the seed's party and the signer key, then anchors the key under source `claim`. A record failure refuses `claim-not-persisted` with nothing anchored and the latch cleared; an anchor failure rolls the anchor back and the record stands. `claim:accepted` carries the whole record and fires before the seed is acknowledged.
- **cadre-cli keeps `claim.json` in the node-state directory and starts from it.** `claim-record.ts` reads and atomically writes `{ version: 1, partyId, ownerKey, claimedAt }`; a present but malformed file refuses the start. `partyOnRecord(config)` resolves the served party for `cadre start` and the one-shot commands. A start with a record opens the stores under the record's party, anchors its owner, refuses the owner-choosing options, and prints that the config's party is a placeholder. A start with the secret and no record runs under the placeholder; on `claim:accepted` it waits for that seed's `seed:applied` or `seed:error`, then stops the node, builds one from the record, re-attaches the health and admin servers and starts it. A failed restart exits non-zero for the supervisor.
- **`/status`** reports `node.claim` as `claimed` whenever a record exists, `awaiting` with a secret and none, `none` otherwise, plus `node.claimedBy` when claimed. The old running-state rule is gone, so the in-process restart never flips a poller back to `awaiting`.
- **Docs**: cadre-cli README "Waiting to be claimed" and env rows; `docs/architecture.md` claim-secret entry; `docs/api.md` and `docs/testing.md` (review).

## Review findings

Read the implement diff first, then the handoff. Checked by reading and running: the record-then-anchor order and its two failure paths; the seed handler's order (verify and merge, acknowledge, dial owners, then `seed:applied`), which confirms the restart hook fires after the acknowledgement; the policy's idempotent acceptance of a latched or anchored signer; `CadreNode.stop()` being a no-op when not running (a SIGTERM during the restart window is safe); `PersistentTrustedOwnerStore.trust` skipping the write for a known key (the per-start anchor in `buildClaimedNode` is idempotent); every consumer of `claim:accepted`, `claimConfigured`, `isAwaitingClaim` and `/status` in the repo (cadre-host reads none of the new fields yet; nothing else builds a `claim` config); the README, architecture, API and testing docs against the code.

**Fixed inline (minor).**

- `start.ts` had grown to 732 lines with the node builders, event wiring and restart hook beside the command. Moved `openNodeStores`, `buildNodeConfig`, `claimConfigFor`, `buildClaimedNode`, `buildConfiguredNode`, `wireNodeEvents` and `afterClaimSeedSettles` into `commands/start-node.ts` (262 lines); `start.ts` is 495, holding the command, its checks, the servers and the restart. Measured with `wc -l`.
- `oneShotNodeConfig` took a defaulted `partyId` "for callers with no node-state directory"; no such caller exists (`withConnectedNode` is the only one). Made the parameter required.
- `docs/api.md` still said `claim:accepted` fires "with the owner key"; now says the party too, and that `claim.record` is handed both first.
- `docs/testing.md`'s scenario bullet did not mention the record or the in-process restart the scenario now proves; added.
- The copy of cadre-core's atomic write omits that helper's best-effort directory fsync; the `NOTE:` at the site now says so.

**Added one test.** `packages/cadre-cli/test/claim-record.spec.ts`: the record is absent on a never-claimed node and `partyOnRecord` returns the placeholder; a write round-trips through `readClaimRecord` and leaves no temp file; a present but malformed file (bad JSON, wrong version, bad owner key, empty party) refuses, naming the file. The refusal is the contract that a claimed node never starts unclaimed, and nothing exercised it: the scenario only reads a good record. The implementer's new policy case (record before anchor, record failure leaves the node unclaimed) was kept; it pins a branch with real consequences and does not restate the implementation.

**Tripwires (recorded as `NOTE:` at the site, not filed).**

- `start.ts`, at the `claimRecord` variable: if the anchor persist fails after the record is written, no restart follows but `/status` already reads `claimed` by that owner under the placeholder party; the claimant's retry or the next process start repairs it. Exit non-zero on such a refusal if the window is ever seen.
- Kept from the implementation, verified by reading: `afterClaimSeedSettles` settling early on a same-party rival's refusal; the restarted node holding no dial target for its owner; `publishSelfRecordOnceClaimed` not running when the secret is unset after the claim; the placeholder party's files staying on disk.

**Major findings: none.** The design decisions the handoff flagged (record-first order, conservative refusal of owner-choosing options beside a record, secret may stay set) all match the plan ticket and the README, and the scenario exercises each path they create.

**Not filed, with reason.** `cadre status` prints the config file's party in its "Configuration" section, which on a claimed node is the placeholder, and its runtime section carries no claim fields. The runtime section already shows the live party, the two sections are labelled, and no ticket in the chain reads `cadre status`; cadre-host reads `/status` directly. Left as is.

**Pre-existing failures:** none seen.

## Validation

- `yarn workspace @serfab/cadre-cli typecheck`, `yarn lint`: clean.
- `yarn workspace @serfab/cadre-cli build`, then `yarn workspace @serfab/cadre-cli test`: 20 files, 260 passed (one file more than the handoff's 19, the new spec).
- `yarn workspace @serfab/cadre-core test seed-trust-policy-claim cadre-node-claim cadre-node-trusted-owners`: 3 files, 15 passed. cadre-core source is unchanged since the implementer's full run (156 files, 2395 passed).
- `yarn workspace @serfab/integration-tests test node-claim-by-phone`: 6 of 6 steps, 19.6 s, against the rebuilt cadre-cli. Log: `tickets/.logs/claim-carries-the-party-id.review.scenario.log`.
