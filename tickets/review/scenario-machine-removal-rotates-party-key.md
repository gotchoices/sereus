description: A real-network test now proves that removing one of a cadre's machines locks it out of a private workspace shared with another party, while the other machines and the other party keep working and a machine offline during the removal rejoins by itself. The apps' removal wording now says this too. The test also showed the removed machine receives the replacement key, which is filed separately.
prereq: machine-removal-rotates-party-member-key
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts (new), packages/integration-tests/src/harness/cadre-invite.ts, packages/reference-app-rn/src/machine-removal.tsx, packages/reference-app-web/src/lib/machines.svelte.ts, packages/reference-app-web/src/Machines.svelte, packages/reference-app-web/README.md, packages/cadre-core/src/cadre-node.ts (comment only), docs/reference-app-rn.md, docs/architecture.md, docs/strands.md, docs/testing.md, tickets/fix/removed-machine-receives-new-party-key.md (new)
----
# Scenario: a removed machine is cut from the strand, and the apps say so

Last ticket of the key-rotation chain.

## What was built

**The scenario** (`machine-removal-rotates-party-key.integration.ts`). Party A has three machines: A1 the owner, A2 an always-on member running a storage replica, and A3 a member with the app. Party B has one machine, joined through the real formation handshake. The test calls no membership writer. Its sequence: all four serve the strand; A2 stops; A1 removes A3; the strand's rows move to the new key; A1 and B cut A3 from the rows alone; B's write reaches A1 but not A3; A3's write reaches nobody; A2 restarts on the same identity, port and store with no owner signer, is served, holds the writes it missed and finishes its membership loop; A2's control record holds the new key, no pending row, and no `CadrePeer` row for A3.

**The harness.** `PinningMemberOptions.membershipReconciliation`, forwarded to `controlNodeConfig`.

**The apps.** Both confirmations now say removal replaces the cadre's membership key in each private workspace the cadre manages, so the machine stops being served there. A workspace the removal does not finish from this device is listed under "Not finished by this removal:" as "‹id›: needs the other party's manager" (`another-party`) or "‹id›: finishes on a device that runs it" (`later`). The owner-key line is unchanged.

**The docs.** The bullet in `docs/reference-app-rn.md` that named the prereq ticket is replaced, the web README's confirmation bullet is updated, the architecture Proof line names the scenario, `docs/strands.md` "What removal does to the network" gains a bullet, and `docs/testing.md` gains a line.

## Found while building: read this first

**The removed machine receives the new key.** With A1 stopped and A3 holding no connections, A3's control database returned the private half of the new key, identical to A1's. The likely path is the removal's commit, since A3 is still in the control cohort then, but I did not separate that from a background read on A3 pulling the block in before the cut; the fix ticket says so. `docs/architecture.md` and the `removeMachine` comment both said this could not happen, so I removed those claims and stated the behaviour under "What removal still leaves". The defect is filed as `tickets/fix/removed-machine-receives-new-party-key.md`, with the reproduction, the constraints a fix must keep, and what a modified client could do with the key (read from the code, not run). The fix ticket also carries an unconfirmed second arm: a removed machine holding an owner key looks able to drive the rotation and bind itself. One probe run did not show it, and that is not enough to rule it out. The new scenario's cut therefore holds for a client running this code. The header says so.

The probes were temporary and are not in the tree.

## Where this differs from the ticket

- **`removeMachine` reports `pending`, not `rotated`.** The ticket's step 3 cannot hold on its own topology. With A3 removed and A2 offline, A1 can reach no sibling while the party still has a member, so `controlWriteCouldFork` defers the swap. This is documented behaviour, not a bug in the driver. The scenario asserts `pending` with the strand's rows already on the new key, then gates on A1's growth drain finishing the swap when A2 returns. That exercises the deferred path the prereq's handoff had only wired by reading. **A reviewer should weigh this**: the alternative was adding a fourth, always-reachable machine to get `rotated`.
- **A2's convergence is physical, not a row read.** A replica has no app schema, and a claim would have been a call on A2 beyond starting it, which the ticket forbids. So A2 is shown holding every block B holds, with an assertion before the restart that a gap exists, so the gate cannot pass on its first poll. Its membership rows are read normally.
- **"The loop done" reads private state.** `membershipReconcilers` is private to the instance manager, so the scenario reaches it through a narrow cast, as `control-write-degraded-cohort-member` does for `pendingPeerWrites`. I did not add a public API that only a test would use.
- **Workspaces are named by id.** The ticket says "<name>", but the apps have no workspace name, and `Home.svelte` already shows the raw strand id.
- **`docs/reference-app-web.md` does not exist.** The web doc is `packages/reference-app-web/README.md`, and the web `KEEPS_LINE` is in `Machines.svelte`, not `machines.svelte.ts`.
- **No explicit `refreshRevocationEnforcement`.** The ticket allowed one, but every cut happened on the production schedule within the gates.

## Tests

- `machine-removal-rotates-party-key.integration.ts`: the ticket's acceptance. A removed machine is cut by its former siblings and the other party on rows production wrote, and a machine offline through the removal returns with no owner signer and finishes by itself.
- No app tests: the wording is copy, and the plan field is a projection the core spec pins, as the ticket says.

## Validation

- The scenario passed all 4 runs on its final assertions, each 60 to 67 s of test time, with B's first post-cut write committing on attempt 2. Two earlier passes predate the gap assertion and the `pending` assertion. The newest run predates only a comment edit in the scenario's header and one `NOTE:`; I could not re-run after those because of the stale-build guard described under Known gaps. Log of the newest run: `tickets/.logs/scenario-machine-removal-rotates-party-key.final1.log`.
- `yarn workspace @serfab/integration-tests typecheck`, `@serfab/reference-app-rn typecheck`, `@serfab/reference-app-web typecheck`, `@serfab/reference-app-web check:svelte` (0 errors, 0 warnings), `@serfab/reference-app-web exec vite build`, `yarn lint`: all exit 0.
- `yarn workspace @serfab/cadre-core build` was run because the dist predated the prereq; the only `cadre-core` source change here is a comment.

## Known gaps

- **The sibling scenarios were not run, and that is blocked on the sibling's build.** I tried `machine-removal`, `strand-removal-cuts-network`, `strand-party-removal-via-formation-e2e` and `strand-membership-second-machine`, since the rotation code had not been on a real network before this ticket. The stale-build guard refused both attempts, naming `@optimystic/db-core` and `@optimystic/quereus-plugin-optimystic`, which are read-only from here (`tickets/rules/sibling-repos.md`), so I built nothing. That repo had committed minutes earlier. Run these four in review once the guard is clear.
- **`removeMachine` reporting `rotated` on a real network is uncovered**, and `docs/testing.md` says so. The driver's own `rotated` result is in `strand-party-key-rotation.spec.ts`.
- **The other path of A2's return is not exercised.** If the swap had already happened, A2 would read the new key on launch or re-key from the replicated row.
- **How B's writes reach A2 is not pinned.** Only A2's holding them is asserted, plus its strand connection to A1. A direct B to A2 connection after the restart is not asserted, and the blocks may arrive through A1.
- **Connections are direct.** The relay case stays uncovered, as in the sibling scenarios.
- **The wording has not been seen on a device or in a browser.** The web bundle builds and `check:svelte` is clean; the phone app is typechecked only.

## Tripwires recorded

- `NOTE:` at `StrandMachine` in the scenario: the handles and read helpers are now in three scenarios; a fourth should move them to the harness.
