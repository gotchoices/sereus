description: A real-network test now proves that when a cadre removes one of its machines from a private workspace another party manages, the host's fresh invitation is enough: the removed machine is cut off by everyone, the cadre's other machine keeps working with nothing done on it, and the waiting replacement disappears from the cadre's list. The four removal scenarios now share one harness module for their machine handles, reads and cut claims.
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/party-key-rotation-across-parties.integration.ts (new), packages/integration-tests/src/harness/strand-machine.ts (new), packages/integration-tests/src/harness/index.ts, packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts, packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts, packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts, docs/testing.md, docs/architecture.md, docs/strands.md, tickets/backlog/debt-hoist-strand-read-helpers-integration.md, tickets/.pre-existing-error.md
difficulty: hard
----
# Scenario: a removed machine is cut from a strand its party does not manage

## What was built

**The scenario** (`party-key-rotation-across-parties.integration.ts`, one case). Party B's owner B1 founds a closed strand and is its only manager. Party A's owner A1 joins it through the real formation handshake; A2, an always-on member with no owner key, launches it as a storage replica from the party-wide `JoinedStrand` row A1's connected reconcile pass publishes; A3, a second member with the app, attaches from the same row read on it. Bring-up waits until production wrote every binding (A's key K seated by A1's reconciler, A1, A2 and A3 bound under K, B1 under B's key, A2's and A3's `StrandPeer` rows on A1) and until a B1 write is on every machine. Then:

1. **Removal.** `A1.removeMachine(A3)` reports the strand `needs-another-party`, `strand:party-key-rotation-blocked` fired once on A1 with that reason, the removal plan said `another-party`, and `listPendingPartyKeyRotations()` lists the strand as `another-party` with a public key that is not K's and equals the pending row's. B1's rows are untouched (K and B's key the members, B the only manager, nothing bound under the new key). A3 is still served: a B1 write converges on A3 and A1, and B1 and A2 still hold strand connections to A3.
2. **Re-invitation.** B1 publishes a fresh bound invitation and A1 redeems it. Gated on the outcome: `strand:party-key-rotated` on A1; A1's control row names K' with no pending row; the listing is empty; the blocked report stayed at one. On B1: K' a member and K gone, B still the only manager, `ConsumedInvite` names the second invitation's key against K', `MemberPeer` holds A1 and A2 under K' and A3 under K only. A1's staged invitation is cleared.
3. **The cut.** A1, B1 and A2 each hang up A3 on the production schedule; a B1 write converges on A1 and physically on A2 (block coverage) and never on A3 within the 10 s budget; A3's write (it failed with a 1/4 super-majority in all three runs) reaches neither B1 nor A1.
4. **A2 followed the control record.** A2's control row names K', it runs under K' on the same strand node, its rebuilt membership loop is done with its binding under K', A3's binding under K is still there, and A1 and B1 keep serving A2. A1's rebuilt loop is done too.

**The harness module** (`harness/strand-machine.ts`, exported from the barrel). The fourth scenario moved the family the three removal scenarios each carried: the `StrandMachine` handle and `strandMachine`; `strandConnectionsTo`, `expectConnected`, `expectCut`, `awaitCut`; `memberKeys`, `managerKeys`, `memberPeerBindings`, `binding`, `consumedInvites`, `awaitMemberSeated`, `awaitBindingsVisible`; `dataValue`, `awaitRowVisible`, `expectNeverConverges`, `rowLanded`, `insertWithRetry`; `publishBoundInvitation`, `awaitPartyKey`, `awaitStrandRow`, `awaitJoinedStrandRow` (new, for A3), `awaitReplica`, `awaitSwapOn`; `meshStrandNodes`; `membershipLoopDone` and `runningPartyKey`; and the shared constants `STRAND_GATE`, `NO_CONVERGENCE_BUDGET_MS`, `REMAINING_COHORT_WRITE_BUDGET_MS`, `STRAND_MESH_TIMEOUT_MS`, `BOUND_INVITATION_TTL_MS`, with the measurement rationale stated once. Decisions: the most general signature everywhere (`insertWithRetry` and `expectNeverConverges` take their budget explicitly; `awaitPartyKey` and the row gates take a `CadreNode`, so the formation scenario's callers pass `.node`; gates default to `STRAND_GATE`); `memberPeerIds` is gone and its one caller now asserts the `MemberKey|PeerId` pairing; `strandMachine` accepts an undefined instance and names the status and error. The three scenarios import it and keep only what is theirs (`admitSecondParty` and `freshKeyPair`; `formStrandWithRetry`; the shared-strand bring-up). The scenario-specific `NOTE:` about four sequential negative arms moved to its call site in `strand-removal-cuts-network`.

**Docs.** `docs/testing.md` gained the scenario's bullet after the sibling's (the "returning after a swap it missed is uncovered" line stays); `docs/architecture.md`'s Proof paragraph of "Removing a machine" names this scenario as the cross-party proof; `docs/strands.md`'s cadre-removal bullet cites both scenarios.

**The backlog ticket** `debt-hoist-strand-read-helpers-integration` tracked this hoist as its third and fourth arms; a status section now says they landed here, how the `expect` question was decided, and that the first two arms (the `scanColumn` family and the relay-path helpers) and `freshKeyPair` stay open.

## Where this differs from the implement ticket

- **A3 attaches from the `JoinedStrand` row, not from `strand:discovered`.** A pinning member without `hostUnclaimedStrands` runs `strandFilter: 'none'`, so its watcher offers nothing; the ticket allowed the row path, which is the joined counterpart of the sibling's `awaitStrandRow`.
- **The cut is asserted on A1 too**, beside B1 and A2: A1 wrote K's leave, and the claim costs one gate.
- **The harness assertion helpers throw plain errors.** The harness never imports vitest (stated at `harness/control-trio.ts`), and the backlog ticket left that decision to whoever hoisted; `expectConnected`, `expectCut` and `expectNeverConverges` keep their names and throw an `Error` naming the machine. What is lost is vitest's value diff, which a count-against-zero or row-seen-or-not claim does not need.
- **The budget constants moved too**, since each scenario cited the same measurement; a scenario that keeps a local note keeps only the note.

## Validation

| Run | Result | Time |
|---|---|---|
| `yarn workspace @serfab/integration-tests exec vitest run party-key-rotation-across-parties`, run 1 | passed | 47.0 s test, 60.3 s file |
| same, run 2 | test passed; vitest then counted 6 unhandled `StreamStateError`s at teardown, which fails the run | 44.4 s test, 60.0 s file |
| `… vitest run machine-removal-rotates-party-key` | online case passed; offline case timed out on one gate | 161 s |
| `… vitest run machine-removal-rotates-party-key -t 'only sibling offline'` with reconciler debug | passed | 63.5 s test |
| `… vitest run strand-removal-cuts-network` | 3 of 3 passed | 90 s test |
| `… vitest run strand-party-removal-via-formation-e2e` | 2 of 2 passed | 119 s test |
| `yarn workspace @serfab/integration-tests typecheck`, `yarn lint` | exit 0 | |

Logs: `tickets/.logs/scenario-party-key-rotation-across-parties.*.log`. The stale-build guard did not refuse any run. The scenario's header records the two runs' wall clock.

## Known gaps and notes for the reviewer

- **Two pre-existing failures are reported in `tickets/.pre-existing-error.md`**, not chased here: the sibling scenario's offline case timing out on the restarted replica's loop gate (1 of 2 today; the log says the loop was still under the old key because the swapped control row had not reached the replica, and the test gates on that arrival only after the failing gate, so a gate reorder is the suggested confirm step), and the unhandled libp2p `StreamStateError` at teardown, which the new scenario showed in 1 of 2 runs with the same stack the sibling showed before this ticket. Neither test body changed in this ticket beyond the renames; an earlier report of both fingerprints started a triage run that exited before recording anything.
- **The owner alone re-runs the driver every reconciler pass while the swap is deferred.** The debug log of the sibling's offline case shows A1's loop kicking the driver every 2 s, each run ending "swap deferred". The `NOTE:` at `kickRotationDriver` describes the non-owner machine's version; this is the owner-alone version of the same shape, reads only. Observation, nothing done.
- **The A3 positive read in step 1 never needed a retry** (one attempt in every run); the retrying insert stays, as the ticket asked, for the cohort that still lists A3.
- **"peer-join block catch-up to peer … has failed 3 times" warnings** appear on party A's control network after the removal in every run, two peers' worth; the sibling scenario prints the same for one. Read as the removed machine and its former siblings failing to reach each other after the hang-up, not confirmed by peer id.
- **Not run:** the full integration suite, and the scenarios that carry `SIMPLE_SCHEMA` but none of the moved helpers (untouched).
- **Tests:** the scenario is the test; it pins the four steps above on a real network. No unit test was added: no cadre-core logic changed.
