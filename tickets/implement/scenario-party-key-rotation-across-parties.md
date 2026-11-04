description: Prove on a real network that when a cadre removes one of its machines from a private workspace another party manages, the host's fresh invitation is enough: the removed machine is cut off by everyone, the cadre's other machine keeps working with nothing done on it, and the waiting replacement disappears from the cadre's list.
prereq: party-key-rotation-redeems-an-invitation-under-the-pending-key, pending-party-key-rotations-listed
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/party-key-rotation-across-parties.integration.ts (new), packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts (the shape to copy: `publishBoundInvitation`, `strandMachine`, `meshStrandNodes`, the cut assertions, the `NOTE:` at `StrandMachine`), packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts and strand-party-removal-via-formation-e2e.integration.ts (the two other copies of those helpers), packages/integration-tests/src/harness/ (the helpers move here), docs/testing.md (the scenario list; Known gaps), docs/architecture.md (the Proof paragraph of Removing a machine)
difficulty: hard
----
# Scenario: a removed machine is cut from a strand its party does not manage

The acceptance of the plan: party A with two remaining machines joins party B's closed strand through formation; A removes one of its machines; after B re-invites A, the removed machine is denied by B and by A's other machine, and that other machine is bound under A's new key with no owner action on it.

## Machines

- **B1**, party B's owner: founds the cadre and the closed strand; the strand's only manager.
- **A1**, party A's owner: joins B's strand through the real formation handshake (`formStrand` with a bound invitation B1 publishes, then `addStrand` with the formation's read secret, as B does in `machine-removal-rotates-party-key`), removes A3, and redeems B's second invitation.
- **A2**, an always-on member of A (`startPinningMember` plus `admitMember`, no owner key) that runs the strand as a storage replica. It launches the party-wide `JoinedStrand` row A1's connected owner reconcile pass publishes (`hostUnclaimedStrands`), the way the existing scenario's A2 launches an own-party strand. Nothing is called on it after bring-up.
- **A3**, a second member of A with the app: it claims the joined strand from `strand:discovered` (or `addStrand` from the `JoinedStrand` row read on it, the joined counterpart of the existing scenario's `awaitStrandRow`). The machine removed.

Bring-up as in the existing scenario: mesh the four strand nodes, then wait until production wrote every binding: A's `Strand.Member` K seated by A1's reconciler from the formation's invitation, A1, A2 and A3 bound under K, B1 under B's key, and A2's and A3's `StrandPeer` rows visible on A1.

## Steps and assertions

1. **Removal.** `A1.removeMachine(A3)` returns the strand as `needs-another-party`; `strand:party-key-rotation-blocked` fired on A1 with that reason; `A1.listPendingPartyKeyRotations()` lists the strand as `another-party` with a public key that is not K's. The strand's rows are unchanged: K a member, no new member. A3 is still served: a B1 write converges on A3 (the positive read that shows the cut below is the invitation's doing, not the removal's).
2. **Re-invitation.** B1 publishes a fresh bound invitation (`publishBoundInvitation`); A1 `formStrand`s it. Then, on gates: `strand:party-key-rotated` on A1; A1's `StrandPartyKey` row names a key K' that differs from K and whose public half is the listed one; A1's pending listing is empty; the strand's rows on B1 show K' a member, K no member, no `Manager` row for either, `ConsumedInvite` naming K'; `MemberPeer` holds A1 and A2 under K' and A3 under K only.
3. **The cut.** B1 and A2 both had a strand connection to A3 before and have none after; a B1 write converges on A1 and A2 (A2 physically, by block coverage, as the existing scenario does) and not on A3 within `NO_CONVERGENCE_BUDGET_MS`; an A3 write reaches neither B1 nor A1.
4. **A2 followed the control record.** A2's `StrandPartyKey` row names K', and its membership loop finished (it binds nothing further; the removed machine's binding under K stays, since K is gone and only a manager could clear it).

One case. The offline-sibling path of the swap is proved by the existing scenario and does not depend on who admits the key.

## Helpers

This is the fourth scenario wanting the `StrandMachine` handles and the strand read helpers that `machine-removal-rotates-party-key` copied from `strand-removal-cuts-network`, which copied them from `strand-party-removal-via-formation-e2e`. The `NOTE:` at `StrandMachine` says to move them to the harness at the fourth; do that, under `packages/integration-tests/src/harness/` (a `strand-machine.ts` or an extension of `strand-join.ts`), and make the three existing scenarios import them. The copies differ in small ways (`insertWithRetry`'s budget argument, `memberPeerIds` against `memberPeerBindings`); keep the most general signature and adapt the callers rather than keep three variants. A scenario that still needs something local keeps only that.

## Edge cases & interactions

- **The `Invite` row reaches A1 after the formation returns**: A1's reconciler retries on its ladder; the gates in step 2 wait on the outcome, not on the first pass. Set the reconciler's poll interval as the existing scenario does.
- **A1's listing in step 1 reads before the driver has reported**: `removeMachine` drives inside the call, so the pending row and the blocked report are there when it returns; assert the listing after the call, not concurrently.
- **A2 launches the joined strand late** (its reconcile pass publishes the `JoinedStrand` row on its own cadence): gate on A2's instance and its `StrandPeer` row on A1 before the removal, as the existing scenario gates A2's row.
- **The A3 positive read in step 1 against the cohort still listing A3**: a write right after a removal can take a few attempts (`REMAINING_COHORT_WRITE_BUDGET_MS`); reuse the retrying insert.
- **Hang-up timing**: the cut in step 3 happens on the production revocation schedule once the rows reach each machine; the gates allow that, as the existing scenario's do.

## Tests

The scenario is the test. Run it at least twice in a row; record the wall-clock per run in the file header and the review handoff, as the existing scenario does.

## Docs

- `docs/testing.md`: a bullet in the scenario list after the `machine-removal-rotates-party-key` one; the "A machine returning after a swap it missed is uncovered" line stays.
- `docs/architecture.md` "Removing a machine", the Proof paragraph: name this scenario as the cross-party proof.
- `docs/strands.md` "What removal does to the network", the cadre-removal bullet: add this scenario beside the existing one.

## TODO

- Move the shared handles and read helpers into the harness; re-point the three scenarios; keep them green.
- The scenario, with the four steps above.
- Docs.
- `yarn workspace @serfab/integration-tests typecheck`, `yarn lint`, this scenario twice, and the three scenarios that now import the moved helpers.
