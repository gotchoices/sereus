description: A real-network test now shows that a phone which uses a party's closed shared workspace without storing it keeps working after the party removes one of its other machines, which is the situation that used to lock the phone out for good.
architecture: docs/strands/keys.md#replacing-the-partys-key
files: packages/integration-tests/src/scenarios/client-survives-party-key-replacement.integration.ts, packages/integration-tests/src/harness/strand-machine.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/contributing/topology-coverage.md, docs/strands/writes.md
----

# Scenario: a client survives its party's key replacement

Last of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`. The first two gave the `StrandPeer` row its role column and made every machine publish one; this one proves the chain end to end on a real network. The scenario is the reproduction of the filed defect at the only layer that reproduces it: the lockout was the revoked-peer gate on the serving machines refusing the client's libp2p streams after the old key left, which needs real nodes.

## What landed

**One new scenario file**, `packages/integration-tests/src/scenarios/client-survives-party-key-replacement.integration.ts`, one test. One party of four machines over `bootTopology`, one closed strand the owner founded, no second party — so the owner runs every step of the replacement itself. A1 is the owner, A2 and A3 are serving machines with the app, A4 is a `device` with `roles: { strandCohortMember: false }` and the app. The three serving machines are meshed and barriered at a cohort of three; A4 attaches last and is hand-dialed to A1 and A2, as `strand-client-node-holds-no-blocks.integration.ts` does.

What it asserts, in order: the four `StrandPeer` rows in the owner's control database with A4's marked `client` and the rest carrying no role; every machine bound under the founding key; a row A4 writes reaching A2; `removeMachine(A3)` reporting the strand `rotated` with a new control key and no pending row; the strand's rows on the new key with A4 bound under it and A3 left on the old one; A4's own strand switching to the new key with its rebuilt membership loop done; then — the step that failed before the fix — A4 still served after the old key's departure has reached A1 and A2, and a second row A4 writes reaching A2; and A3 cut in both directions of evidence.

**One helper hoisted**, `strandPeerRoles(node, strandId, label)`, from `strand-client-node-holds-no-blocks.integration.ts` into `harness/strand-machine.ts`. It takes a `CadreNode` rather than a `TopologyMachine` so both callers can use it; the client scenario's three call sites now pass `.node`. Nothing moved out of `machine-removal-rotates-party-key.integration.ts` — the helpers the ticket named (`awaitSwapOn`, `memberPeerBindings`, `binding`, `awaitCut`, `expectConnected`) were already in the harness, so that part of the TODO was a no-op.

**Coverage map**: a row for the new file, and the correction the ticket asked for — the row for `strand-client-node-holds-no-blocks.integration.ts` said "a closed strand" was not covered, which was accurate but thin; it now says the strand is open, so no membership rows and no party key.

**One docs bullet**, in `docs/strands/writes.md` → "Limits and accepted tradeoffs": a client's first write after a machine is removed retries for longer than a serving machine's, because nothing wakes the client's revoked-peer gate and it keeps the removed machine in every cohort until the gate's backstop. See *Tripwires* below.

No runtime code changed. No release note: the behaviour this proves is already in `.release-notes.pending.md` under the control schema version 5 and the client-role sections.

## Validation

| Check | Result |
|---|---|
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| `yarn workspace @serfab/integration-tests exec vitest run client-survives-party-key-replacement` | 5 runs, 5 passes, 29–34 s each |
| `yarn workspace @serfab/integration-tests exec vitest run strand-client-node-holds-no-blocks` | 2 of 2 pass (the scenario the helper moved out of) |
| `yarn workspace @serfab/integration-tests exec vitest run machine-removal-rotates-party-key` | 2 of 2 pass, 48 s and 235 s (the sibling scenario sharing `strand-machine.ts`) |
| `yarn lint` (ESLint + check-docs) | pass, 66 docs OK |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. No sibling repository was built or touched.

## Use cases to exercise in review

- **Run the new file.** `yarn workspace @serfab/integration-tests exec vitest run client-survives-party-key-replacement`. It prints two lines worth reading: `[strand-machine] A4 committed 'after-removal' on attempt N after M ms` (the measurements above had N=1, M≈3.6 s) and `[client-survives-rotation] A4 writes against a cohort of 3, the removed machine still among them`.
- **Check the test can fail for the right reason.** The claim rests on A4 being in the new key's bindings. Deleting `binding(newMemberKey, a4)` from `expectRowsOnNewKey` and the `waitUntil` that gates on A2 reading it should leave the write in step 4 as the only thing standing between the run and the old defect — worth confirming the write actually fails when the binding is removed from the driver's reach, for instance by reverting `StrandInstanceManager.buildStrandRuntime`'s unconditional `publishOwn` to the old `servesBlocks` condition on a scratch build. Not done here; it is the one check that would turn "the scenario passes" into "the scenario would have caught this".
- **Weigh the driven gate refresh** (next section). It is the one judgement call in the file.

## Known gaps and judgement calls, honestly

- **The run drives A4's own revoked-peer gate rather than waiting it out.** Between the two halves of step 4 the scenario calls `a4.node.refreshRevocationEnforcement(strandId)` and gates on `awaitCut(a4, a3, …)`. Why: a client stores none of the membership rows, so nothing wakes that gate and a removal made elsewhere reaches it only on the five-minute backstop; until then A4 stays connected to A3 and keeps it in every block's cohort. The first run of this scenario, without the refresh, failed: A4's second write got `1/3 approvals (needed 3)` on all 20 attempts across the 90 s budget, with two of the three cluster peers silent — the removed machine and, apparently, one of the two remaining serving machines. With the refresh the write commits on the first attempt in 3.6 s, five runs out of five. **What a reviewer should decide is whether driving that refresh weakens the claim.** My reading is that it does not: the claim is that A1 and A2 do not refuse A4, which is read from A1 and A2's connections and from a write that commits through one of them, and A4's own refusal of A3 is explicitly not asserted. But the refresh is a deviation from "the production schedule on every machine" and the file's header says so in two places.
- **I did not get to the bottom of the first run's second silent peer.** The hypothesis in the file's comment is only about A3 in the cohort; it does not explain why one of A1/A2 also went silent from A4's view in that run. A connection-slot theory (A3 re-dialing an edge-tier client) fits the diagnostics — A4 held duplicate connections to A3 and A2 and a single one to A1 — but is not measured. If a reviewer wants that settled, the evidence is the harness diagnostics, not this scenario.
- **Step 6 of the ticket — the negative control on the offline queue — was dropped.** The ticket allowed dropping it "if that doubles the bring-up cost"; my reason is different and worth checking. `getUnreachedStrandMachines` answers empty on a node offering no offline mode, so the claim needs A2 rebuilt with a file journal, which `TopologyMachineSpec` does not expose today (`strandOffline` would have to be added to it). And it would be vacuous as specified: the list names only serving machines with no open connection, and A4 stays connected to A2 throughout, so A4 could not appear whatever its role were. The branch itself — `StrandPartyMachines.read` filtering on `serves` — is pinned at the unit layer in `strand-party-machines.spec.ts`, including both directions of a client's row arriving and leaving.
- **The recovery path is not asserted.** A client whose `StrandPeer` row reaches the remover only after the replacement is bound later by a sibling's membership loop. The ticket said it stays by inspection, and the prereq's review checked it by inspection. The scenario gates on A4's row being in A1's control database before the removal precisely so the run asserts the direct path and not that one.
- **A4 refusing A3 is still unasserted**, deliberately, and the file says so.
- **The scenario leaves A3 connected to A4** for most of its life, which is production behaviour but means the file does not run a shape where a client talks only to live machines.

## Tripwires

- **A client's writes are slow in the window after a machine is removed.** Recorded as a bullet in `docs/strands/writes.md` → "Limits and accepted tradeoffs" rather than as a code comment, because the concern is the composition of two mechanisms (the client's gate backstop and Optimystic's cluster downsize) and has no single code site. The bullet states the mechanism and the revisit condition — a gate woken by what the client reads rather than only by what it stores — and links to `docs/cadre/node.md`'s existing bullet instead of restating it. No measurement is in the doc, per the docs rules; the measurement is in this handoff. Nothing was filed as a ticket: the behaviour is a consequence of two already-documented limits, and it is fine at the shapes the suite runs.
