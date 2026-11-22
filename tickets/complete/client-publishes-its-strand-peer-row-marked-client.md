description: A phone that uses a party's shared workspaces without storing them now records its network identity for the party, marked as a non-storing machine, so the key replacement after a machine removal keeps it admitted while the offline write queue still waits only for machines that store the workspace.
architecture: docs/strands/membership.md#binding-the-partys-machines
files: packages/cadre-core/src/strand-party-peers.ts, packages/cadre-core/src/strand-party-machines.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/test/strand-party-peers.spec.ts, packages/cadre-core/test/strand-party-machines.spec.ts, packages/cadre-core/test/strand-commit-durability.spec.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/strands/membership.md, docs/strands/keys.md, docs/strands/writes.md, docs/cadre/node.md, .release-notes.pending.md
----

# A client publishes its `StrandPeer` row, marked `client`

Second of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`. The first (`strand-peer-row-carries-the-machines-role`) gave the row its `Role` column and the two signed forms. This one makes every machine publish the row and makes the single reader that must ignore clients ignore them. The third (`scenario-client-survives-party-key-replacement`, still in `implement/`) proves the chain end to end on a real network.

## What landed

**Every machine publishes.** `StrandInstanceManager.buildStrandRuntime` dropped the `servesBlocks` condition around `config.partyPeers.publishOwn`, so the row is written at bring-up for every machine and every strand, open or closed. `CadreNode.publishStrandPeer` fills the role from `this.roles.strandCohortMember` and names it in its log line. `deferredStrandPeerWrites` still stores the strand peer id alone; the role is re-read at each retry.

**The partition carries the role.** `PartyStrandPeer` gained `serves: boolean`, set in `partitionPartyStrandPeers` from `row.role !== 'client'`. No row is dropped for its role.

**Only the machine tracker filters.** `StrandPartyMachines.read` keeps `peers.live.filter((peer) => peer.serves)`, before the change comparison, so a client's row arriving or leaving wakes no `onChange` listener. `removed()` still carries every removed id. The binders — `CadreNode.readSiblingPeerIds` for the key rotation driver, and the reconciler's `reconcileSiblings` — read `live` whole and needed no code change.

**Docs and release notes.** `docs/strands/membership.md`, `docs/strands/keys.md`, `docs/strands/writes.md`, `docs/cadre/node.md` and `.release-notes.pending.md` were rewritten to the new shape, including a release-note section for control schema version 5 and the fixed-role limit.

The implement commit is `ticket(implement): client-publishes-its-strand-peer-row-marked-client`; this review's own edits are listed below.

## Review findings

### Checked

- **The role's source.** `publishStrandPeer` reads the node-wide `this.roles.strandCohortMember`, where the dropped publish condition read the per-strand `config.roles.strandCohortMember`. These are the same value: `CadreNode.roles` is a `readonly` field resolved once in the constructor and is the only producer of `StartStrandConfig.roles`, and a launch config retains it across hibernate and wake. The comment's claim that the role cannot change while the node runs holds, so re-reading it at each deferred retry is safe.
- **Every reader of `PartyStrandPeers.live`.** Three: `CadreNode.readSiblingPeerIds` (the key rotation driver's step 3), the reconciler's `reconcileSiblings` (step 5), and `StrandPartyMachines.read`. Only the third filters, which is what the change intends. Nothing else in the repo calls `queryStrandPeers` or `readPartyStrandPeers`.
- **Every consumer of `StrandPartyMachines.machines()`.** The composed cohort gate, `StrandInstanceManager.unreachedPartyMachines` (what `CadreNode.getUnreachedStrandMachines` reports), the commit durability report's awaited machines, and the redial loop's `partyMachines`. All now see serving machines only, with no change of their own.
- **`removed()` is deliberately unfiltered, and that is a new behaviour nobody listed.** A removed client's strand peer id now reaches `StrandInstanceManager`'s `isNetworkMember`, the redial loop's `isRevoked`, and `watchRemovedMachinesInSeed`. In all three the new answer is the right one — a machine removed from the party should be refused whatever its role — and the seed watcher's `announced` set bounds the extra work to one runtime rebuild per removed id. No action.
- **The schema agrees with the release note.** `CONTROL_SCHEMA_VERSION` is 5; `KnownStrandPeerRole` admits null and `'client'` only; `Authorized` carries the two signed forms. `insertStrandPeer` marks the row held when it finds a stored one stating a different role, so a reconfigured machine stops retrying a write that could never change the row.
- **The recovery `keys.md` now promises.** A `StrandPeer` change re-runs each closed strand's binding through the party-machine watch (`docs/cadre/control-convergence.md` → the watch table), and `armMembershipReconciler` arms the loop for every closed strand with a party key regardless of role, so a client's own step-6 retry runs too. The claim is sound by inspection; the scenario that observes it is the third ticket.
- **The deleted claim was right to delete.** The old docs said a sibling could not look up a client's strand address. That was already untrue: `strandAddrRefreshTargets` asks the connected control cohort for strand addresses, not the `StrandPeer` rows, so a serving machine learned a client's strand address before this change. Nothing was lost by dropping it, and no residue survives — a grep over `docs/`, `packages/` and the release notes finds no "publishes no row" claim anywhere.
- **`docs/contributing/topology-coverage.md` stays accurate.** Its row for the client scenario says "a closed strand" in the *Not covered* column, and the scenario's strand is `Type: 'o'`. No contradiction with the scenario's new comment.
- **No other package assumes the old shape.** `cadre-host`, `cadre-cli`, `quereus-plugin-sereus`, `cadre-rn` and the reference apps never touch `StrandPeer` or `PartyStrandPeer`.

### Fixed in this pass (minor)

- **`docs/strands/writes.md` did not carry the limit its own readers will hit.** The implement filed the fixed-role limit in `docs/strands/membership.md` → "Limits and accepted tradeoffs", but its one concrete consequence is an offline queue that waits forever for a machine that became a client — and that list already holds the near-identical bullet about a machine that stops running the strand. Added one bullet to writes.md's limits stating the claim and linking to membership.md's, rather than restating it.
- **Two doc comments described the old criterion.** `CadreNode.getUnreachedStrandMachines` said "each has written its `StrandPeer` row for it", which is now true of every machine and no longer the criterion; `StrandInstanceManager.unreachedPartyMachines` said "known to hold". Both now say the list is the machines that store the strand, clients already dropped.
- **The new `StrandPartyMachines` test asserted only half its own claim.** Its comment said a client arriving or leaving wakes nobody, but the script only removed a client from a live set that had one. Added the arriving direction — the one that actually matters, since a client's row reaching the party must not wake the gate — inside the same test rather than as a second one.

### Not filed, with reasons

- **Nothing reached the major bar.** No correctness defect survived the sweep above, so no ticket was filed and the architecture ladder was not climbed.
- **No tripwires added.** The one conditional concern in range — a tracker read that stalls, holding the queue — already carries its `NOTE:` on `StrandPartyMachines` from an earlier ticket, and this change does not alter it. The removed-client-in-seed rebuild above is bounded and correct rather than conditional, so it stays a finding and not a comment.
- **`docs/cadre/control-schema.md` stays unchanged** — the second opinion the implement handoff asked for. The fixed-role limit is a consequence of the row's immutability, which the schema comment already states at the table, and its user-visible effects belong to membership.md and writes.md, which now both carry it. A third copy in control-schema.md's limits would break "one home per fact".
- **`docs/cadre/node.md` is at 5993 of the 6,000-word budget**, measured by `scripts/check-docs.mjs`'s own rule (words on every line outside a fenced block). The next sentence added to it fails `yarn lint`. That is already `debt-cadre-node-doc-at-its-word-budget` in `backlog/`, so nothing new was filed.

### Known gaps carried forward

- **Nothing here proves the fix end to end.** The behaviour that closes the parent defect is only reachable on a closed strand with a machine removal, which is `scenario-client-survives-party-key-replacement` in `implement/`. What this ticket proves is that the row is published and marked, and that the offline queue skips it.
- **The mixed-release window is asserted nowhere.** A version-4 machine verifying a client's four-field row against the three-field form and dropping it is inference from the two signed forms. No layer in this repo can reproduce it without a store holding a row this build refuses to write. The release note states the consequence and the remedy: update every machine of a party before removing a machine from it.

## Validation

| Check | Result |
|---|---|
| `yarn workspace @serfab/cadre-core typecheck` | pass |
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| `yarn workspace @serfab/cadre-core test` (full) | 200 files, 2706 pass, 1 skipped, 0 failed |
| `yarn lint` (ESLint + check-docs) | pass, 66 docs OK |

The failure the implement pass reported — `control-database-solo-warm-start.spec.ts` → "start() then addStrand() with THREE vanished prior-cohort peers on disk" — did not recur in the full run here, which confirms the `one-off` CPU-load diagnosis dated 2026-11-14 in `tickets/.pre-existing-known.md`. No `.pre-existing-error.md` was written. The one skipped test is the Windows-conditional `it.skipIf` in `key-store.spec.ts`.

`@serfab/cadre-core` was rebuilt after the comment edits so the integration scenarios' stale-build guard stays satisfied. The scenarios themselves were not re-run: this pass changed no runtime behaviour, and the implement pass ran `strand-client-node-holds-no-blocks` (2 of 2) and `strand-offline-waits-for-party-machine` (4 of 4) against the same code. No sibling repository was built or touched.
