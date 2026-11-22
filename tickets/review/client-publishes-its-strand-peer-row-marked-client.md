description: A phone that uses a party's shared workspaces without storing them now records its network identity for the party, marked as a non-storing machine, so the key replacement after a machine removal keeps it admitted while the offline write queue still waits only for machines that store the workspace.
prereq: strand-peer-row-carries-the-machines-role
architecture: docs/strands/membership.md#binding-the-partys-machines
files: packages/cadre-core/src/strand-party-peers.ts, packages/cadre-core/src/strand-party-machines.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-membership-reconciler.ts, packages/cadre-core/src/strand-party-key-rotation.ts, packages/cadre-core/test/strand-party-peers.spec.ts, packages/cadre-core/test/strand-party-machines.spec.ts, packages/cadre-core/test/strand-commit-durability.spec.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/strands/membership.md, docs/strands/keys.md, docs/strands/writes.md, docs/cadre/node.md, .release-notes.pending.md
difficulty: medium
----

# Review: a client publishes its `StrandPeer` row, marked `client`

Second of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`. The first (`strand-peer-row-carries-the-machines-role`, landed) gave the row a `Role` column with two signed forms. This one makes every machine publish the row, makes the one reader that must ignore clients ignore them, and updates the docs that stated the old limit. The third (`scenario-client-survives-party-key-replacement`) proves the chain end to end on a real network.

## What was built

**Every machine publishes.** `StrandInstanceManager.buildStrandRuntime` dropped the `servesBlocks` condition around `config.partyPeers.publishOwn`, so the row is written at bring-up for every machine and every strand, open or closed. `CadreNode.publishStrandPeer` now passes `this.roles.strandCohortMember ? null : 'client'` to `insertStrandPeer` and names the role in its log line. `deferredStrandPeerWrites` still stores the strand peer id alone; the role is read again at each retry, which is safe because a node's role cannot change while it runs.

**The partition carries the role.** `PartyStrandPeer` gained `serves: boolean`, set in `partitionPartyStrandPeers` from `row.role !== 'client'`. No row is dropped for its role: `PartyStrandPeers.live` holds clients, and `removed` is unchanged.

**Only the machine tracker filters.** `StrandPartyMachines.read` now keeps `peers.live.filter((peer) => peer.serves)`. The filter runs *before* the change comparison, so a client's row arriving changes neither the serving set nor the removed set and wakes no `onChange` listener. `removed()` still carries every removed id, client or server. Everything downstream of `machines()` therefore sees serving machines only with no change of its own: the composed gate `cohortGateWaitingForMachines`, `StrandInstanceManager.unreachedPartyMachines` (what `CadreNode.getUnreachedStrandMachines` reports), a commit's `awaitedMachines`, and the redial loop's `partyMachines`.

**The binders read `live` unfiltered,** and needed no code change — `CadreNode.readSiblingPeerIds` (feeding `StrandPartyKeyRotationDriver.bindMachines`) and the reconciler's `reconcileSiblings` both map `peers.live` to ids. Their module comments were rewritten to say so: `strand-party-peers.ts` now names three readers and which of them cares about the role, `strand-party-key-rotation.ts` step 3 says every live machine including clients, and the reconciler's step 6 says bring-up already wrote the row for every machine.

**Docs and release notes.** `docs/strands/membership.md`: the "publishes no row" bullet is replaced by one saying every machine of the party is bound, serving or not, and that the role has exactly one reader; a sentence on how a machine unbound by a replacement recovers; and a new limit that the role is fixed at the machine's first publish for a strand. `docs/strands/keys.md`: the old "cannot bind a machine that holds no strand blocks" limit is replaced by the one that actually remains — a replacement cannot bind a machine whose row has not reached the party yet, which recovers on its own. `docs/strands/writes.md` → "Which machines count" and `docs/cadre/node.md` → the client bullet now state the row-plus-role shape. `.release-notes.pending.md` gets the rewritten client bullet and a new "The control schema is at version 5" section with the fixed-role limit, the mixed-release window and the recovery.

## Use cases to check the work against

- **A phone that stores nothing, in a closed strand, when a machine is removed.** The phone's row reaches the party; the replacement's step 3 binds it under the new key; it keeps writing after the old key leaves. This is the defect the chain exists to fix, and it is the third ticket's scenario — nothing here proves it on a network.
- **A phone and a server in one party, offline mode on the server.** A queued transaction on the server must not wait for the phone. The composed gate opens when the phone is the only other machine with a row.
- **Two phones in one party, offline mode on a phone.** A phone must not wait for another phone; its tracker reads the other's row and skips it.
- **A phone whose row has not reached the party when a replacement runs.** It stays unbound and is refused once the old key leaves, then recovers with no operator action: the row's arrival re-arms every sibling's membership loop, a sibling binds it under the current key, and each serving machine's revoked-peer enforcer stops refusing it when the binding replicates. Verified by inspection only (`reconcileSiblings` binds from `live` with no role test; the enforcer watches `Strand.MemberPeer`).
- **A machine reconfigured between client and serving.** The row is immutable, so the first statement stands for every strand it had already run. `insertStrandPeer` logs the mismatch at debug level; the limit is documented in membership.md.
- **A party on mixed releases.** A machine still on the previous release verifies a client's row against the three-field form, fails, and drops it, so its binders and its queue behave as before. An owner on the old release driving a replacement still leaves clients unbound. Stated in the release note; not tested.

## Tests

| Test | What it pins |
|---|---|
| `strand-party-peers.spec.ts` — the one case, extended | A live `'client'` row lands in `live` with `serves: false`, serving rows with `serves: true`, and a removed client's id lands in `removed` like a removed server's. |
| `strand-party-machines.spec.ts` — new `it` on `StrandPartyMachines` | `machines()` is the serving sibling alone when the read holds a server and a client; `removed()` keeps every removed id; a client leaving the live set announces no change. |
| `strand-client-node-holds-no-blocks.integration.ts` — assertion 6 flipped | All three machines published a row; the client's role is `'client'` and both servers' are null; the client holds its own row. Observes the bring-up write on an **open** strand, where no membership loop runs to write it later. |

`strand-membership-reconciler.spec.ts` and `strand-commit-durability.spec.ts` needed `serves` on their `PartyStrandPeer` fixtures. In the reconciler spec one of the two siblings was made a client, which turns an existing assertion into the claim that the loop binds a client like any other machine — a fixture change, not a new test. No new test for the key rotation driver: it binds whatever `live` holds, and the third ticket's scenario covers the chain.

## Known gaps, for the reviewer

- **Nothing here proves the fix end to end.** The behaviour that closes the parent defect — a client still admitted after a party key replacement — is only reachable on a closed strand with a removal, which is `scenario-client-survives-party-key-replacement`. What this ticket proves is that the row is published and marked, and that the queue skips it.
- **The mixed-release window is asserted nowhere.** A version-4 machine dropping a client's row is inference from the two signed forms (previous ticket's review reached the same conclusion by inspection). The release note states it; no test reproduces it, and no layer in this repo can without a store holding a row this build refuses to write.
- **`docs/cadre/node.md` is 4 words under the 6,000-word gate** after this change (it was 9 words under before). The next addition to that document has to split it by topic — the gate will say so.
- **`docs/cadre/control-schema.md` was left unchanged.** Its `StrandPeer` table row and its "A machine's own signature" paragraph already carry the role and the two signed forms from the previous ticket, and the fixed-role limit lives in membership.md rather than being restated here. Worth a second opinion on whether control-schema.md should link to that limit.
- **The scenario's claim that a sibling can "look up a client's strand address" was removed, not kept.** The row does carry the client's strand peer id, but the only consumer of that mapping is the redial loop's `partyMachines`, which now reads the serving-only list — so a serving machine still does not dial a client. The docs were written to claim only what holds: the row makes the client *bindable*. Check `docs/cadre/node.md` and the release note for any residue of the stronger claim.
- **No tripwires were added.** The one conditional concern in range — a tracker read that stalls — already has its `NOTE:` on `StrandPartyMachines` from an earlier ticket, and this change does not alter it.

## Validation

| Check | Result |
|---|---|
| `yarn workspace @serfab/cadre-core typecheck` | pass |
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| `yarn workspace @serfab/cadre-core test` (full) | 200 files, 2705 pass, 1 skipped, **1 failed** — see below |
| `strand-client-node-holds-no-blocks.integration.ts` | 2 of 2 pass, 62 s |
| `strand-offline-waits-for-party-machine.integration.ts` | 4 of 4 pass, 72 s |
| `yarn lint` (ESLint + check-docs) | pass, 66 docs OK |

The one failure was `control-database-solo-warm-start.spec.ts` → "start() then addStrand() with THREE vanished prior-cohort peers on disk", `solo-warm-start control op ensureOwnerKey() (genesis) timed out after 15000ms`. That is the `one-off` entry dated 2026-11-14 in `tickets/.pre-existing-known.md`, which is a CPU-load symptom with a confirm protocol. Followed it: the file alone with `DEBUG=sereus:cadre:control-db` passed 6 of 6, and the genesis step measured 1746–2045 ms across the six runs, inside the 1–2 s band the record calls "load, needs nothing". No `.pre-existing-error.md` was written, and the skipped test is the Windows-conditional `it.skipIf` in `key-store.spec.ts`.

`@serfab/cadre-core` was rebuilt (`yarn workspace @serfab/cadre-core build`) so the integration scenarios ran against this change. No sibling repository was built or touched.
