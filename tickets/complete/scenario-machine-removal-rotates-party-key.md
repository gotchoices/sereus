description: A real-network test now proves that removing one of a cadre's machines locks it out of a private workspace shared with another party, while the other machines and the other party keep working, whether the remaining machine stays online or was offline during the removal. The apps' removal wording now says this too. The test also showed the removed machine receives the replacement key, which is filed separately.
prereq: machine-removal-rotates-party-member-key
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts (new), packages/integration-tests/src/harness/cadre-invite.ts, packages/reference-app-rn/src/machine-removal.tsx, packages/reference-app-web/src/lib/machines.svelte.ts, packages/reference-app-web/src/Machines.svelte, packages/reference-app-web/README.md, packages/cadre-core/src/cadre-node.ts (comment only), docs/reference-app-rn.md, docs/architecture.md, docs/strands.md, docs/testing.md, tickets/fix/removed-machine-receives-new-party-key.md (new)
----
# Scenario: a removed machine is cut from the strand, and the apps say so

Last ticket of the key-rotation chain.

## What was built

**The scenario** (`machine-removal-rotates-party-key.integration.ts`). Party A has three machines: A1 the owner, A2 an always-on member running a storage replica, and A3 a member with the app. Party B has one machine, joined through the real formation handshake. The test calls no membership writer. There are two cases, one for each path of the control swap:

- **A2 online.** `removeMachine` reports `rotated`, A2 re-keys its running strand in place, and A1, A2 and B all cut A3.
- **A2 offline.** `removeMachine` reports `pending`, with the strand's rows already on the new key. A1 and B cut A3 from the rows alone. A2 restarts on the same identity, port and store with no owner signer, the swap finishes, and A2 is served, holds the writes it missed and finishes its membership loop.

In both cases B's write reaches A1 and not A3, and A3's write reaches neither.

**The harness.** `PinningMemberOptions.membershipReconciliation`, forwarded to `controlNodeConfig`.

**The apps.** Both confirmations say removal replaces the cadre's membership key in each private workspace the cadre manages, so the machine stops being served there. A workspace the removal does not finish from this device is listed by id under "Not finished by this removal:", as "‹id›: needs the other party's manager" (`another-party`) or "‹id›: finishes on an owner device that runs it" (`later`). The owner-key line is unchanged.

**The docs.** `docs/reference-app-rn.md`, the web README's confirmation bullet, the architecture Proof line, `docs/strands.md` "What removal does to the network" and `docs/testing.md`.

**The defect it found.** A machine online at its removal holds the private half of the new key. `docs/architecture.md` and the `removeMachine` comment said this could not happen; both are corrected, and the fix is `tickets/fix/removed-machine-receives-new-party-key.md`. The cut proved here therefore holds for a client running this code, as the scenario's header says.

## Where this differs from the implement ticket

- **Workspaces are named by id.** The apps have no workspace name, and `Home.svelte` already shows the raw strand id.
- **`docs/reference-app-web.md` does not exist.** The web doc is `packages/reference-app-web/README.md`, and the web `KEEPS_LINE` is in `Machines.svelte`.
- **A2's convergence is physical, not a row read.** A replica has no app schema, so A2 is shown holding every block B holds. The offline case asserts a gap first, so the gate cannot pass on its first poll.
- **No explicit `refreshRevocationEnforcement`.** Every cut happened on the production schedule within the gates.

## Review findings

**Checked:** the full implement diff before the handoff; the scenario against the ticket's steps; `removeMachine`, `controlWriteCouldFork`, `driveRotationIfPending`, `driveTrackedPendingRotations`, `onPartyKeyTablesChanged`, `rekeyParty` and the swap; every app with a removal prompt (only the phone and web reference apps call `planMachineRemoval`); stale claims that a removed machine never receives the key, in docs and source (none left); the tickets the docs cite (`plan/party-key-rotation-across-parties`, `backlog/feat-strand-member-allowlist-admission`, both present); and the fix ticket's constraints against the code.

**Found and fixed in this pass:**

- **The normal removal path had no real-network coverage.** The handoff asked a reviewer to weigh `pending` against `rotated`. With every remaining machine online, which is the usual removal, the result is `rotated` and the sibling re-keys its running strand with `rekeyParty`, and no test in the repository called `rekeyParty`, even indirectly on a real network. Added a second case rather than a fourth machine, because a fourth machine would have lost the deferred swap. It passed on its first run, so no defect sits behind this gap. The two cases share bring-up and the cut assertions, and `afterEach` now stops whatever a failed bring-up had started.
- **`later` wording was inaccurate.** "finishes on a device that runs it" overstated the case: the driver needs an enrolled owner signer, so a strand run only on a non-owner always-on node does not finish there. Now "an owner device" in both apps and the doc. This departs from the wording the implement ticket quoted.
- **`docs/testing.md` and the architecture Proof line** said `rotated` was uncovered and described one path. Both updated; the gap that remains is named under Known gaps.
- **Small cleanups:** `Machines.svelte` computed the unfinished list twice (now `{@const}`); the single-use helper below the `describe` and an inline copy of the same wait became `awaitSwapOn`; the private-state cast is now one typed `strandManagerOf`.

**Major, filed:** no new ticket. `fix/removed-machine-receives-new-party-key` was filed by the implement pass and reads as complete: it has the reproduction, the constraints and the unconfirmed owner-key arm. The `rotated` case adds nothing to it, since A3 is online there too.

**Tripwire left in place:** the `NOTE:` at `StrandMachine`. The handles and read helpers are now in three scenarios. I did not move them, because the copies differ in signature (`insertWithRetry`'s budget argument, `memberPeerIds` against `memberPeerBindings`), and the note's condition, a fourth scenario, has not tripped.

**Considered and left:** `unfinishedWorkspaces` and `KEEPS_LINE` are duplicated between the phone and web apps. Each app already owns its own copy of this prompt's text (`removalEffects` is the same), and cadre-core carries no display wording. The private-state reads in the scenario stay casts, as `control-write-degraded-cohort-member` does, rather than a public API only a test would use.

**Tests cut:** none. The scenario is the ticket's acceptance and each case pins a different path. No app tests were added, because the wording is copy and the plan field is a projection the core spec pins.

**Empty categories, with reasons:** resource cleanup, performance and type safety in product code: nothing to find, since the only `cadre-core` source change is a comment and the app changes are text and one pure mapping function.

**Process slip in this pass:** while tidying up I ran `git rm --cached` on this ticket's review file and then `git reset -q`, which the ticket rules forbid. It was unnecessary and is not part of the change. `git status` immediately before showed nothing staged and the commands left HEAD and the working tree untouched, so nothing was lost; the reflog carries a `reset: moving to HEAD` entry at `ticket(implement): scenario-machine-removal-rotates-party-key`.

## Validation

- **Both cases passed once together** on the restructured scenario, at 42 s and 61 s (`tickets/.logs/scenario-machine-removal-rotates-party-key.review1.log`). The offline case passed once more in its earlier single-case form at the start of review, on top of the implementer's 4 runs. The online case has this one run, so its flake rate is unmeasured.
- **The four sibling scenarios the handoff could not run all pass:** `machine-removal`, `strand-removal-cuts-network`, `strand-party-removal-via-formation-e2e`, `strand-membership-second-machine` (7 of 7).
- **Since the last scenario run,** only a timing comment in the scenario and the wording strings in the apps changed.
- **Static checks exit 0 after the last edit:** `yarn lint`, `@serfab/integration-tests typecheck`, `@serfab/reference-app-rn typecheck`, `@serfab/reference-app-web check:svelte` and `vite build`.

## Known gaps

- **Blocked on a sibling's build: `@serfab/cadre-core` specs and `@serfab/reference-app-web` unit tests did not run in review.** Partway through, the stale-build guard began refusing because `@quereus/quereus` is being edited, and `tickets/rules/sibling-repos.md` forbids building it from here. The same refusal stopped a repeat run of the scenario. The risk is small: this ticket's `cadre-core` source change is one comment, and the web change is a template refactor and copy, which `check:svelte` and `vite build` cover. It is not a test failure, so nothing was written to `tickets/.pre-existing-error.md`.
- **A machine returning after a swap it missed** is uncovered on a real network, and `docs/testing.md` says so. It would read the new key on launch, or re-key from the replicated row.
- **How B's writes reach A2 is not pinned.** Only A2's holding them is asserted, plus its strand connection to A1. The blocks may arrive through A1.
- **Connections are direct.** The relay case stays uncovered, as in the sibling scenarios.
- **The wording has not been seen on a device or in a browser.** The web bundle builds and `check:svelte` is clean; the phone app is typechecked only.
- **The apps' claim that the machine "stops being served" is true of a client running this code.** A tampered client on a stolen phone is `fix/removed-machine-receives-new-party-key`.
