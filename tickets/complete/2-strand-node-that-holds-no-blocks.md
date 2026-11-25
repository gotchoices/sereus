description: A machine can now take part in a shared workspace without storing or signing any of its data, reading and writing through the machines that do. This is what lets a workspace with tens of thousands of phones work, because a sleeping phone then never sits on the path of someone else's save.
prereq: strand-plugin-takes-a-node-that-serves-no-blocks
architecture: docs/cadre/node.md#node-classes
files: packages/cadre-core/src/node-roles.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/strand-database.ts, packages/cadre-core/test/node-roles.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, packages/cadre-core/test/cadre-node-control-node-options.spec.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, packages/integration-tests/src/harness/topology.ts, docs/cadre/node.md, docs/strands/lifecycle.md, docs/strands/formation.md, docs/strands/writes.md, docs/strands/membership.md, docs/strands/keys.md, docs/concepts.md, docs/contributing/topology-coverage.md, packages/cadre-core/README.md, packages/cadre-cli/README.md, .release-notes.pending.md
difficulty: hard
----

# A strand node that holds no blocks — complete

`roles: { strandCohortMember: false }` builds every strand node on the machine as an Optimystic client (`servesBlocks: false`): the strand runs — reads, writes, membership, change notifications — and none of its blocks are stored on the machine. The control node is unchanged. Landed in `ticket(implement): strand-node-that-holds-no-blocks`; this review pass made three small corrections, described below.

## What landed

- **`StrandInstanceManager`** binds `servesBlocks` once from the role in `buildStrandRuntime` and passes it to `createLibp2pNode`; `startStrand` resolves no per-strand store for a client, which makes the join catch-up and the rebalance option fall away with the absent store; the Arachnode option and the `StrandPeer` row publish are behind the same flag. `buildStrandDatabase` treats a client as synced, beside the founder case, so its database is published as soon as it initializes.
- **`CadreNode`** accepts the role. `hostUnclaimedStrands` resolves through `resolveHostUnclaimedStrands` in `node-roles.ts`: `alwaysOn && strandCohortMember` by default, and an explicit `true` beside the role off throws naming both.
- **Types.** `Libp2pNodeWithRepo.coordinatedRepo` and `StrandDatabaseConfig.coordinatedRepo` are optional; the repo is passed to `connectToStrand` only when present.
- **Harness.** `ControlNodeOpts.roles` and `TopologyMachineSpec.roles` forward per-role overrides.
- **Docs.** `docs/cadre/node.md` → "A node that holds no strand blocks" owns what a client does and does not do; the glossary gains **Client**; lifecycle, formation, writes, membership and keys carry the client exception in the owning section; the coverage map lists the scenario; both READMEs and the release notes describe the role.

## Follow-on tickets

- `plan/client-locked-out-of-closed-strand-after-party-key-replacement` — a client publishes no `StrandPeer` row, so a party key replacement cannot bind it under the new key and it is refused by the strand's serving machines from then on. Filed by the implementer; the analysis is confirmed below.
- `implement/client-strand-waits-for-a-serving-machine` — a client whose launch finds no serving machine fails outright instead of staying up and retrying the database phase.

## Review findings

**Read first:** the implement commit's source diff, then the scenario, then the docs, then the handoff. Lint, typecheck and build were run after the edits below; the cadre-core suite and the client-node scenario were re-run.

### Checked

- **The lockout analysis (handoff gap 1), statically.** `strand-party-key-rotation.ts` → `bindMachines` binds `PartyStrandPeers.live` plus its own id, which is read from `StrandPeer` rows; the steps run back to back and the control row swaps last; `StrandRevocationEnforcer` derives its deny set from `MemberPeer` rows whose member key has no live `Member` row. A client's self-binding under the old key is therefore an orphan the moment that key leaves, and the client's re-keyed loop cannot write through a serving coordinator that denies it. Confirmed as the filed ticket states it. One thing the ticket did not say, checked here because it would have been a shipped defect: the membership reconciler clears bindings only for `peers.removed`, which is also derived from `StrandPeer` rows, so a sibling never clears a client's self-binding as a removed machine's.
- **Whether to ship the skipped `StrandPeer` row ahead of that fix.** Yes. `cohortGateWaitingForMachines` (`strand-party-machines.ts`) closes a serving sibling's offline queue while the sibling is alone in a block's cluster and any machine with a row exists; a client is in no cluster, so a client's row would hold that queue whenever the sibling is alone, with no way for the client to open it. That is the common case for a party with one always-on node and a phone; the lockout needs a machine removal on a closed strand, is documented with an operator instruction, and has a plan ticket.
- **Offline mode on a client.** The party-machine gate reads an empty cluster as "alone" (`!cohort.some(id => id !== self)` over `[]`), and Optimystic's own gate reads an empty cohort as closed, so a queued transaction on a client waits for a serving machine and nothing is committed alone, as `writes.md` says. Not run; read against `strand-party-machines.ts` and Optimystic's `docs/internals.md` → "Client nodes".
- **Doc claims against upstream.** The change-notification, durability, ring-occupancy and cross-release statements match Optimystic's `docs/internals.md` → "Client nodes". The cited ticket `clients-in-the-ring-crowd-out-serving-peers` exists on Optimystic's board. "Optimystic 1.28.0" is right: the commits that introduced `servesBlocks` and the storage-claim filter are both ancestors of Optimystic's `release v1.28.0` commit (checked with `git merge-base --is-ancestor` in the sibling, read-only).
- **Hibernation and wake of a client, by reading.** `releaseRuntime` leaves `strandStorages` alone and the wake rebuilds through `buildStrandRuntime`, which reads the absent store the same way the launch did; `disposeStrandStorage` is a no-op for it. Not run.
- **Every reader of `coordinatedRepo` and of the store map** handles the absent value; the control node keeps its own throw.
- **Scenario and unit tests as code under review.** The scenario's six assertions each observe a distinct claim and none restates the implementation; kept as is. The control-node options test pins the one silent breach; kept.

### Found and fixed in this pass (minor)

- **A dead type field.** `Libp2pNodeWithRepo.servesBlocks` was declared with a six-line comment and read by nothing in `src/`; the scenario cannot use it because the interface is not exported, and declares its own structural type. Removed, and the release-note bullet that advertised it corrected.
- **Test placement.** `resolveHostUnclaimedStrands` has three branches, and the branch the handoff relies on — a `server` with the role off defaults to hosting no replicas — was asserted nowhere, since `CadreNode.hostUnclaimedStrands` is private. Added a table test for the function in `node-roles.spec.ts` (the home of role resolution tests) and dropped the constructor-level throw test that duplicated it; the "constructs with the role off, on a server too" regression stays in `cadre-node.spec.ts`.
- **A doc gap on revocation latency.** The revoked-peer gate is woken by a membership change this node's storage takes in (`table-change-watch.ts`), and a client's storage takes in nothing; `Strand.Member` and `Strand.MemberPeer` carry no `optimystic.network_watch` tag either. So a removal made on another machine reaches a client's gate only on its backstop. Stated in `node.md`'s client section; the backstop values stay with the constants in `strand-revocation-enforcer.ts`, which own them.

### Major findings

None. Nothing here reached the filing bar beyond the two tickets the implementer already filed.

### Tripwires

- **`docs/cadre/node.md` is at its word budget.** The implement pass left it four words under 6,000, and this pass had to tighten the client section to add one sentence. The next addition needs a split by topic; `yarn check:docs` is the mechanism that will say so, and no separate note was added.
- **A client hears of its own removal late** — recorded in `node.md` as a stated limit, above. Not a defect: a client is on nobody's write path, so the gate's only live effect on it is the self-revocation stop.

### Not covered (unchanged from the handoff)

Change notifications on a client, hibernation and wake of a client, a client on a closed strand, and the all-clients / mostly-clients limits are stated in the docs and not exercised by a test. `strand:commit-held` never firing on a client is a stated absence with nothing to assert.

### Validation

- `yarn build` — clean (the usual sibling-`dist` chunking warnings and the reference-app chunk-size warning only).
- `yarn typecheck` — clean, including the three coverage guards.
- `yarn lint` — eslint clean; `check:docs` 66 files OK after the `node.md` tightening (it first reported the document at 6,049 words).
- `yarn workspace @serfab/cadre-core test` — 200 files, 2703 passed, 1 skipped (the pre-existing skip).
- `yarn workspace @serfab/integration-tests vitest run src/scenarios/strand-client-node-holds-no-blocks.integration.ts` — 1 passed, 49 s wall (6.3 s test body, 45 committed blocks on server 0).

No pre-existing failures surfaced. No sibling repository was built, installed into or edited. Logs: `tickets/.logs/strand-node-that-holds-no-blocks.review.{cadre-core,scenario}.log` (self-pruning).
