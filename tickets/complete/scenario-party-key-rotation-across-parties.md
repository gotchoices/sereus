description: A real-network test now proves that when a cadre removes one of its machines from a private workspace another party manages, the host's fresh invitation is enough: the removed machine is cut off by everyone, the cadre's other machine keeps working with nothing done on it, and the waiting replacement disappears from the cadre's list. The four removal scenarios now share one harness module for their machine handles, reads and cut claims.
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/party-key-rotation-across-parties.integration.ts (new), packages/integration-tests/src/harness/strand-machine.ts (new), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, packages/cadre-core/src/strand-membership-reconciler.ts (one NOTE), docs/testing.md, docs/architecture.md, docs/strands.md, tickets/backlog/debt-hoist-strand-read-helpers-integration.md, tickets/.pre-existing-error.md
difficulty: hard
----
# Scenario: a removed machine is cut from a strand its party does not manage

## What was built (implement stage, `ticket(implement): scenario-party-key-rotation-across-parties`)

**The scenario** (`party-key-rotation-across-parties.integration.ts`, one case). Party B's owner B1 founds a closed strand and is its only manager. Party A's owner A1 joins it through the real formation handshake; A2, an always-on member with no owner key, launches it as a storage replica from the party-wide `JoinedStrand` row A1's connected reconcile pass publishes; A3, a second member with the app, attaches from the same row read on it. Bring-up waits until production wrote every binding and until a B1 write is on every machine. Then: the removal of A3 reports `needs-another-party`, fires `strand:party-key-rotation-blocked` once, lists the strand as waiting on `another-party`, and leaves B1's rows untouched with A3 still served; B1's fresh bound invitation, redeemed by A1, rotates the key (K' seated, K gone, B still the only manager, the second invitation spent against K', A1 and A2 bound under K', A3 under K only, listing empty, blocked report still one); A1, B1 and A2 each hang up A3 on the production schedule and a B1 write never reaches A3 while A3's write reaches nobody; A2 follows the control record with nothing asked of it (runs under K' on the same strand node, loop done, binding under K', A3's orphan binding kept) and keeps being served.

**The harness module** (`harness/strand-machine.ts`, exported from the barrel): the `StrandMachine` handle and `strandMachine`; the connection claims; the `Strand.*` membership scans and their gates; the `App.Data` gates with their paired negative, `rowLanded` and `insertWithRetry`; the control-row gates (`publishBoundInvitation`, `awaitPartyKey`, `awaitStrandRow`, `awaitJoinedStrandRow`, `awaitReplica`, `awaitSwapOn`); `meshStrandNodes`; `membershipLoopDone` and `runningPartyKey`; and the shared gate and budget constants with their measurement rationale stated once. The three earlier removal scenarios import it and keep only what is theirs. The assertion helpers throw plain `Error`s naming the machine, since the harness never imports vitest. `memberPeerIds` is gone and its one caller asserts the `MemberKey|PeerId` pairing.

**Docs.** `docs/testing.md` gained the scenario's bullet; `docs/architecture.md`'s Proof paragraph of "Removing a machine" names it as the cross-party proof; `docs/strands.md`'s cadre-removal bullet cites both scenarios. The backlog ticket `debt-hoist-strand-read-helpers-integration` records that its third and fourth arms landed here and which arms stay open.

## Review findings

**Read first:** the implement commit's full diff (the new scenario, the harness module, the three scenario diffs, the docs and ticket changes), then the handoff. Every helper in `strand-machine.ts` was compared against the three copies it replaced; the scenario bodies differ from their pre-ticket state only by the gate rename, explicit budget arguments, the `.node` argument to the row gates, and the `awaitBindingsVisible` callers now passing `MemberKey|PeerId` pairs. The new scenario's four steps were read against `docs/architecture.md` → "Removing a machine" and the `listPendingPartyKeyRotations` / `planMachineRemoval` / `removeMachine` contracts; the cut is asserted in both directions of evidence with a paired positive read, and every negative claim uses the shared budget.

**Run:** `yarn workspace @serfab/integration-tests typecheck` and `yarn lint` (exit 0, before and after the review's edits), plus each of the four scenarios once, from the repo root, with `vitest run <name>`:

| Scenario | Result | Test time |
|---|---|---|
| `party-key-rotation-across-parties` | 1 of 1 passed, no unhandled errors | 38 s |
| `machine-removal-rotates-party-key` | 2 of 2 passed; vitest then counted 59 unhandled `StreamStateError`s at teardown, which fails the run | 267 s + 100 s |
| `strand-removal-cuts-network` | 3 of 3 passed | 85 s |
| `strand-party-removal-via-formation-e2e` | 2 of 2 passed (first attempt refused by the stale-build guard: `@quereus/quereus` was being edited; the retry minutes later ran) | 108 s |

Logs: `tickets/.logs/scenario-party-key-rotation-across-parties.review.*.log`.

**Found and fixed inline (minor):**

- The triage run dispatched after the implement commit (`tess: triage pre-existing test failure`, 2026-11-04 02:47) committed a `TEMP-DIAG` block into `machine-removal-rotates-party-key.integration.ts` (a 15 s sleep and four diagnostic logs around the restarted replica's loop gate) and exited before removing it or recording anything. Removed; the file is byte-identical to the implement commit again. That run also deleted the implement stage's `tickets/.pre-existing-error.md` without a ledger entry, so the report is re-filed (below).

**Tripwires recorded (conditional, not tickets):**

- `harness/strand-machine.ts` at `StrandManagerInternals`: the loop reads reach the instance manager's private `membershipReconcilers` and `launchConfigs` by name through a cast, so a rename compiles and turns the gates built on them into 60 s timeouts. `NOTE:` at the site says to have the manager expose a typed test-only probe if that ever bites.
- `cadre-core/src/strand-membership-reconciler.ts` at `kickRotationDriver`: the handoff's observation that the owner machine alone re-runs the driver's reads every reconciler pass while its swap is deferred (the only sibling offline), each ending "swap deferred", for as long as that sibling is away. Reads only; the existing `NOTE:` about the non-owner machine's kicks was extended by that clause, with the same remedy (kick once per seat). `cadre-core` was rebuilt so its `dist` is not stale for the next run.

**Considered and left as is:**

- The hoisted `strandMachine` dropped the formation scenario's `status !== 'active'` check in favour of the sibling's "database and libp2p node present" check. `liveStrandStatus` reports `'active'` exactly when the database is set, so for a live instance the checks agree, and the thrown message still names the status.
- `expectNeverConverges` recognises a `waitUntil` expiry by the `Timeout waiting` text, as the three regex versions it replaced did; both live in the harness, so the coupling is one directory wide.
- The scenario's `A3` attaches from the `JoinedStrand` row rather than `strand:discovered` (a pinning member without `hostUnclaimedStrands` runs `strandFilter: 'none'`); the ticket allowed the row path and it is the joined counterpart of the sibling's `awaitStrandRow`.

**Tests:** none added, none cut. The scenario is the test and pins the four steps on a real network; the hoist moved helpers without changing behaviour, and no cadre-core logic changed. The sibling scenarios' existing cases are the regression check for the hoist and all passed.

**Docs:** `docs/testing.md`, `docs/architecture.md` and `docs/strands.md` read against the scenario and found current. No doc indexes harness modules by file, so none needed a `strand-machine.ts` entry. The backlog ticket's status section matches what landed.

**Pre-existing failures, re-filed in `tickets/.pre-existing-error.md`** (the earlier report's triage lost them): the unhandled libp2p `StreamStateError` at teardown (seen here in the sibling scenario's run, 59 errors; the implement stage saw 6 in the new scenario once), and the sibling's offline case timing out on the restarted replica's loop gate (implement stage 1 of 2; not reproduced in the review's one run; the suggested confirm step is a gate reorder). Also noted there, not a failure: the sibling's online case took 267 s of test time against the 42 to 67 s its header states, with nothing in the output saying where the time went.

**Not run:** the full integration suite; the scenarios that carry `SIMPLE_SCHEMA` but none of the moved helpers are untouched.
