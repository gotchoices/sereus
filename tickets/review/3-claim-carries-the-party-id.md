description: A node waiting to be claimed no longer has to be told in advance which cadre it will serve. The claim itself names the cadre, the node records that and switches over to it, and it comes back into the same cadre after any restart.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-trust-policy.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/test/seed-trust-policy-claim.spec.ts, packages/cadre-core/test/cadre-node-claim.spec.ts, packages/cadre-core/test/cadre-node-trusted-owners.spec.ts, packages/cadre-cli/src/commands/claim-record.ts, packages/cadre-cli/src/commands/start.ts, packages/cadre-cli/src/commands/node-session.ts, packages/cadre-cli/src/server/health.ts, packages/cadre-cli/README.md, packages/integration-tests/src/scenarios/node-claim-by-phone.integration.ts, docs/architecture.md
difficulty: hard
----

# The claim carries the party id — review handoff

First of the `cadre-host-join-a-cadre` chain (this → `cadre-host-remove-founder-role` → `cadre-host-hosted-nodes-join-by-qr` → `cadre-host-join-ui` → `cadre-host-join-by-invitation` → `cadre-host-join-docs`). cadre-core and cadre-cli only; cadre-host is untouched (its `dist` was rebuilt once to satisfy the stale-build guard, no source change).

## What was built

**cadre-core records the claim, party included, before it anchors the claimant.**

- `NodeClaimRecord = { partyId, ownerKey }` (`types.ts`, exported from the package root). `CadreNodeConfig.claim` gains a required `record: (claim: NodeClaimRecord) => Promise<void>` beside `secret`; `CadreNode.initializeClaimPolicy` threads it into `claimSecretTrustPolicy` as `recordClaim` (optional on the policy, so a policy with nothing to record only anchors).
- `claimSecretTrustPolicy`: `anchorClaim` now takes the record and runs `recordClaim` first, then `trustedOwners.trust(ownerKey, 'claim')`. A record failure refuses `claim-not-persisted` with nothing anchored and the latch cleared; an anchor failure rolls back as before and the record stands. The decision-order comment has the new steps 7 and 8 and says why record-first is the right order.
- `onClaimed` and `claim:accepted` carry the whole `NodeClaimRecord` (`{ ownerKey, partyId }`). The event's doc now says it fires before the seed is acknowledged and that an embedder restarting on it should wait for that seed's `seed:applied`.
- The `NOTE:` in `verifyAndMergeSeed` is reworded: the claim policy reads the seed's party; a mismatch is still not rejected because an unclaimed node's party is a placeholder.

**cadre-cli keeps the record in the node-state directory and starts from it.**

- New `commands/claim-record.ts`: `claim.json` in `nodeStateDir`, `{ version: 1, partyId, ownerKey, claimedAt }`, written to a sibling temp file, fsync'd and renamed (a copy of cadre-core's unexported `writeFileAtomically`; noted at the site). `readClaimRecord` returns `undefined` for an absent file and throws, naming the file, for a present-but-unreadable or malformed one, so a claimed node never starts unclaimed. `partyOnRecord(config)` is the one place the served party is resolved: the record's, else the config's placeholder.
- `start.ts` is restructured around `buildNodeConfig` / `openNodeStores` / `buildClaimedNode` / `buildConfiguredNode` / `wireNodeEvents`, so the first start and the in-process restart build a node the same way. Record present at start: stores opened under the record's party, the record's owner anchored under source `claim` (idempotent), no pins, `claim` only when `CADRE_CLAIM_SECRET` is set, a `• Claimed by owner <key> into party <id> (controlNetwork.partyId '<x>' is a placeholder and is ignored)` line. No record and secret set: starts under the placeholder party with `record` writing `claim.json`; on `claim:accepted`, `afterClaimSeedSettles` waits for that seed's `seed:applied`/`seed:error` (the ack is written between the two events), then `restartIntoClaimedParty` stops the node, builds one from the record, re-attaches the health and admin servers, starts it, and prints `✓ Restarted into party <id> as a node claimed by owner <key>`. A restart failure prints and exits 1.
- The one-shot runner `withConnectedNode` (`node-session.ts`) also resolves the party through `partyOnRecord`, so `cadre strands` and friends run against a claimed node's real party, not its placeholder. Not in the ticket; added because the one-shot path would otherwise be wrong on every claimed node's config.
- `refuseClaimConflicts` gains a `subject` and is applied to a claim on record as well as to the secret (`--owner`, `--seed`, `--invitation`, pins). The ticket was silent on the record-without-secret case; refusing is the conservative reading (a claimed node takes its owner from the claim), and the README says so.
- `/status`: `HealthServerOptions.claimConfigured` is replaced by `claim: () => ClaimFacts` (`{ secretConfigured, claimedBy? }`), read on every request. `node.claim` is `claimed` iff a record exists (read at start or written in this process), `awaiting` with a secret and no record, `none` otherwise; `node.claimedBy` is present iff claimed. The old running-state rule is gone, so the in-process restart never flips a poller from `claimed` back to `awaiting`.

**Docs.** cadre-cli README "Waiting to be claimed" (placeholder party, `claim.json`, the restart, the `/status` fields, the secret may stay set, the record refuses the same options) and three env-table rows; `docs/architecture.md`, the claim-secret entry's "On the node and on the owner" paragraph. `config/env.ts` was in the ticket's file list but needed no change.

## Tests

- `seed-trust-policy-claim.spec.ts`, one new case: the claim is recorded (party and key observed) before the anchor write; a record failure refuses `claim-not-persisted` with `trust` never called and `onClaimed` never fired, and the latch clears so another claimant is accepted and recorded, then anchored. The existing `onClaimed` assertion now expects `{ partyId, ownerKey }`.
- `cadre-node-claim.spec.ts`, `cadre-node-trusted-owners.spec.ts`: supply the now-required `record` callback; no behaviour change.
- `node-claim-by-phone.integration.ts` is the proof. The child's config names `unclaimed`. Step 1 asserts the placeholder party, no `claimedBy`, no `claim.json`. Step 3 asserts `claimed` immediately after `claimNode`, then waits for `/status` to be healthy under the claimant's party with `claimedBy` equal to the claimant's key, reads `claim.json` (`{ version: 1, partyId, ownerKey }`, secret absent), and asserts both the claim and the restart log lines before the existing dial-in and row-crossing checks. Step 6 asserts the restarted process reads the record (party, `claimedBy`, the placeholder-ignored line) beside the existing `• Already claimed` and reconnect checks. `waitForClaimState` became `waitForStatus({ claim, partyId })`.
- No cadre-cli unit test for the restart (wiring over `CadreNode.start`, exercised by the scenario), for `parseClaimRecord`, or for the `/status` rule. The parser and the rule are small branching functions a reviewer may judge worth a case each; I left them out on the ticket's test list.

## Validation

- `yarn workspace @serfab/cadre-core typecheck`, `yarn workspace @serfab/cadre-cli typecheck`, `yarn workspace @serfab/integration-tests typecheck`: clean.
- `yarn lint` at the root: clean.
- `yarn workspace @serfab/cadre-core test`: 156 files, 2395 passed, 1 skipped (pre-existing skip, not in a file I touched). Log: `tickets/.logs/claim-carries-the-party-id.cadre-core.log`.
- `yarn workspace @serfab/cadre-cli test`: 19 files, 258 passed.
- `yarn workspace @serfab/integration-tests test node-claim-by-phone`: 6 of 6 steps pass, 19 s. Step 3, which now includes the in-process restart, ran in 2.3 s. Log: `tickets/.logs/claim-carries-the-party-id.scenario.log`. The stale-build guard first refused on cadre-host's `dist` (its source was newer than its build before this ticket); rebuilt, no source change.

## Known gaps and judgment calls for the reviewer

- **Restart timing.** `afterClaimSeedSettles` waits for the first `seed:applied` or `seed:error` whose party is the claimed one or the node's own placeholder (a failure after the trust decision is reported under the node's party). A second claimant of the same party refused in that window settles it early; the claimant then retries and is accepted idempotently. NOTE at the site.
- **Owner dial target not carried over.** The claim seed's peers were merged into the placeholder party's bootstrap store; the restarted node holds no dial target for its owner and waits for the owner to dial in, which `claimNode` retained the node's addresses for. NOTE in `buildClaimedNode`. A phone that must be dialed through a relay the node initiates to would need the seed re-applied after the restart.
- **Secret unset after the claim.** Without `claim`, cadre-core's `publishSelfRecordOnceClaimed` does not run, so such a node republishes its address record on the heartbeat only. cadre-host keeps the secret set on respawn (per `cadre-host-hosted-nodes-join-by-qr`). NOTE in `claimConfigFor`.
- **Record overwrite in-process.** If the record is written and the anchor persist then fails, the latch clears and another claimant's accepted claim overwrites `claim.json` with its own party and key, which is consistent with what ends up anchored. Across a restart this cannot happen (the anchor is non-empty). By inspection; no test.
- **The placeholder party's files** (`trusted-owners.unclaimed.json`, `bootstrap-peers.unclaimed.json`, and the `control-unclaimed` storage directory) stay on disk. Said in `buildClaimedNode`'s comment and the README.
- **The atomic write is a second copy** of cadre-core's `fs-atomic.ts` helper (cadre-host carries the sync shape too). NOTE at the site: export cadre-core's if a third copy is needed.
- Required `record` on `CadreNodeConfig.claim` is a breaking shape change for any embedder building a claim config; the two cadre-core tests that did were updated, and nothing else in the repo does.
