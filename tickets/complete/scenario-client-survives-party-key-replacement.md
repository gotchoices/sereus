description: A real-network test now shows that a phone which uses a party's closed shared workspace without storing it keeps working after the party removes one of its other machines, which is the situation that used to lock the phone out for good.
architecture: docs/strands/keys.md#replacing-the-partys-key
files: packages/integration-tests/src/scenarios/client-survives-party-key-replacement.integration.ts, packages/integration-tests/src/harness/strand-machine.ts, packages/integration-tests/src/scenarios/strand-client-node-holds-no-blocks.integration.ts, docs/contributing/topology-coverage.md, docs/strands/writes.md
----

# Scenario: a client survives its party's key replacement

Last of three tickets for `client-locked-out-of-closed-strand-after-party-key-replacement`, after `strand-peer-row-carries-the-machines-role` and `client-publishes-its-strand-peer-row-marked-client`. The implement commit is `ticket(implement): scenario-client-survives-party-key-replacement`; this review's own edits are listed below.

## What landed

**One new scenario**, `packages/integration-tests/src/scenarios/client-survives-party-key-replacement.integration.ts`, one test: one party of four machines on a closed strand the owner founded, three of them serving and meshed, the fourth a `device` with `strandCohortMember: false` hand-dialed to two of the servers. The owner removes a serving machine, which replaces the party's member key in the strand, and the run reads: the four `StrandPeer` rows with the client's marked `client`; the strand's rows on the new key with the client bound under it; the client still served by a serving machine and still committing a row once the old key has gone; and the removed machine cut in both directions of evidence.

**One helper hoisted** into `harness/strand-machine.ts`: `strandPeerRoles(node, strandId, label)`, previously a local function in `strand-client-node-holds-no-blocks.integration.ts`, now taking a `CadreNode` and returning `Map<string, StrandPeerRole | null>`.

**Docs**: a coverage-map row for the new file, a correction to the row for `strand-client-node-holds-no-blocks` (its strand is open, so it covers no membership rows and no party key), and one bullet in `docs/strands/writes.md` → "Limits and accepted tradeoffs" for a client's slower first write after a machine is removed.

No runtime code changed, and no release note: the behaviour is already covered by the pending notes for control schema version 5 and the client role.

## Review findings

**Read first:** the implement diff with no handoff in hand, then the scenario against the two prereq commits' production diffs, then the handoff.

### Checked

- **The scenario's sensitivity, by breaking the fix on a scratch build.** This is the check the handoff asked for and did not run, and it is the only one that turns "the scenario passes" into "the scenario would have caught this". Three runs, each a one-line edit to `@serfab/cadre-core` with the package rebuilt:
  - *`StrandInstanceManager.buildStrandRuntime`'s publish re-gated on `servesBlocks`, exactly as it was before the fix* — **the run still passes**, in 32 s. The client's row arrives anyway, because the membership reconciler's own step 6 (`publishOwnStrandPeer`) publishes it whatever the machine's role, and always did. So the bring-up publish alone is not what this run rests on.
  - *`CadreNode.publishStrandPeer` disabled for a client, which is the filed defect's premise — no row at all* — **the run fails**, at step 1: `A1 holds a StrandPeer row for each of the party's four machines` times out at 60 s.
  - *the binder blind to clients (`partitionPartyStrandPeers` dropping client rows from `live`), which is the lockout's actual mechanism* — **the run fails** at step 3, on the new key's bindings missing the client in one run and on `A4 runs under the new key, its rebuilt membership loop done` in the other: a client nobody binds cannot write its own binding, which is the defect.

  So the file does catch the defect, at steps 1 and 3 rather than at step 4. The header said step 4 was "the step that failed before the fix"; corrected below.
- **How the defect was filed is not quite how the code behaved, and this matters to nobody but the next reader of this scenario.** Before the fix only the *bring-up* publish was behind the serving role; the reconciler's step 6 was not, so a client on a closed strand did get a `StrandPeer` row — as `role: null`, the only form the row then had — once its first reconciler pass ran (30 s in production). The lockout therefore needed the removal to land inside that window, not merely a client to exist. The shipped fix is still the right one: the bring-up publish closes that window, and the role column is what keeps a serving sibling's offline queue from waiting for a machine that is in no cluster. No ticket; the claim was corrected where it is written down.
- **The one judgement call, the driven `refreshRevocationEnforcement`.** It holds. The call is a production `CadreNode` API (the joined-row detach path uses it), not a test-only hook, and what it stands in for is documented behaviour: `docs/cadre/node.md` → "A node that holds no strand blocks" says a client's revoked-peer gate is woken by a change its own storage takes in, which it has none of, so a removal made elsewhere reaches it on the five-minute backstop. The survival claim is read from A1's and A2's connections and from a write that commits through one of them, and the refresh touches neither; what it removes is the client contending with a removed machine in its own cohort. The file says so in two places, which is the right amount.
- **The dropped step 6 of the implement ticket (the offline queue never waiting for a client).** Justified as the handoff states it: `getUnreachedStrandMachines` reports serving machines with no open connection, A4 stays connected to A2 for the whole run, and both directions of the filter — a client's row arriving and leaving — are pinned in `strand-party-machines.spec.ts`'s "counts only the machines that serve the strand" test. Nothing to add at this layer.
- **The coverage-map correction is accurate.** `strand-client-node-holds-no-blocks` builds its strand row with `Type: 'o'`.
- **The helper hoist.** `strandPeerRoles` is typed against `StrandPeerRole` instead of the local copy's `string`, both callers pass `.node`, and no scenario-local copy is left. The harness header's claim about which scenarios share the module was updated with it.
- **No test was added beyond the scenario, which is right.** The row's publish, its role and the one reader that filters on it are already pinned at the unit layer by the prereq tickets; this layer exists for the libp2p refusal, which has no unit form.
- **Every claim the file makes is gated before it is read, and every negative claim is paired.** The `StrandPeer` rows, the old-key bindings and the client's first write are gated at bring-up, so the cut and the second write cannot pass for a bring-up that never worked; `expectNeverConverges(a3, …)` is paired with A2's read of the same row.
- **Noise worth not chasing.** Every run of this file logs two control-network `peer-join block catch-up … has failed 3 times in a row` warnings. They are the late-joining machines' control catch-up, not an assertion, and they appear identically in runs of the unmodified build and of all three broken ones.

### Fixed in this pass (minor)

- **The header's framing of the defect, replaced with what the run actually distinguishes** (the three results above, in three lines), and the correction about the pre-fix row never being wholly absent. A reader who trusts "step 4 is the step that failed" would strengthen the wrong assertion if this file ever needs strengthening.
- **Step 4's claim** now says it is the positive half of the proof, not the step a broken build fails at.
- **`TEST_TIMEOUT_MS`'s comment** said "Eight libp2p nodes … plus one replacement", which counts a key as a ninth node; the replacement is a key, not a machine. The measured range is now 30 to 50 s, which covers the runs here.

### Tripwires

- **`expectRowsOnNewKey` reads A1's bindings once, the moment `removeMachine` resolves, with no gate behind it.** One broken-fix run saw the removed machine's binding under the old key missing from that read — which, on an unmodified build, this assertion would report as the removal having cleared a deny record. `NOTE:` at the function says so and names the two candidates for a future flake: a networked scan of `Strand.MemberPeer` answering from a view older than the rotation's own writes, or the reconciler's `clearRemovedMachines` running in a pass still under the old key after the swap cleared the pending row. Not filed as a ticket: seven runs on the unmodified build did not reproduce it, the only self-clear path in production is `unpublishStrand`'s, and a removal write signed by a key that has already left the strand is refused — so the candidate mechanism may not be reachable at all. The same arm exists in `machine-removal-rotates-party-key.integration.ts` and has not flaked there either.
- **The handoff's own tripwire was reviewed and kept**: the `docs/strands/writes.md` bullet for a client's slower first write after a removal. It states the mechanism, links `docs/cadre/node.md`'s bullet instead of restating it, and carries a revisit condition. The right home — the concern is the composition of a client's gate backstop with Optimystic's cluster downsize and has no single code site.

### Not filed, with reasons

- **Nothing reached the major bar.** No correctness defect in the diff survived the sweep; the only substantive finding was that the file's prose claimed more than the file measures, which is a comment fix, not a ticket.
- **The handoff's open question about a second silent peer in its first run** was not pursued. It was observed once, before the refresh was added, and the write now commits on the first attempt in every run (3.7 to 7.2 s). There is no current symptom to attach an investigation to.
- **The non-claims stay non-claims**: A4 refusing A3, the recovery path for a client whose row reaches the remover after the replacement, and a shape where the client talks only to live machines. Each is deliberate, each is stated in the file with its reason, and none is cheap to add here — the recovery path in particular would need the run to suppress the direct path it exists to prove.

## Validation

| Check | Result |
|---|---|
| `yarn lint` (ESLint + check-docs) | pass, 66 docs OK |
| `yarn workspace @serfab/integration-tests typecheck` | pass |
| `yarn workspace @serfab/integration-tests exec vitest run client-survives-party-key-replacement` | pass; 4 runs on the unmodified build during this pass (32–50 s), 7 including the implement pass's |
| `yarn workspace @serfab/integration-tests exec vitest run strand-client-node-holds-no-blocks` | 2 of 2 pass (the helper's other caller) |
| The three broken-fix runs | fail as recorded above; `@serfab/cadre-core` rebuilt from the restored source afterwards and its `dist` checked clean of the scratch edits |

No pre-existing failures surfaced, so no `tickets/.pre-existing-error.md` was written. `machine-removal-rotates-party-key` was not re-run: this pass changed comments only, and the implement pass ran it (2 of 2). No sibling repository was built or touched.
