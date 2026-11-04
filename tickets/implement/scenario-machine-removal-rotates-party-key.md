description: Prove on a real network that removing one of a cadre's machines locks it out of a private workspace shared with another party, while the cadre's other machines and the other party keep working and a machine that was offline during the removal rejoins by itself. Then change the apps' removal wording, which still says the removed machine keeps the workspace keys.
prereq: machine-removal-rotates-party-member-key
architecture: docs/architecture.md#removing-a-machine
files: packages/integration-tests/src/scenarios/machine-removal-rotates-party-key.integration.ts (new), packages/integration-tests/src/scenarios/strand-party-removal-via-formation-e2e.integration.ts (the two-party formation fixture to copy), packages/integration-tests/src/scenarios/strand-removal-cuts-network.integration.ts (the cut assertions to copy), packages/integration-tests/src/scenarios/machine-removal.integration.ts (the three-machine party fixture), packages/integration-tests/src/harness/index.ts, packages/reference-app-rn/src/machine-removal.tsx, packages/reference-app-web/src/lib/machines.svelte.ts, docs/reference-app-rn.md ("What removal does not do" ~997), docs/reference-app-web.md, docs/architecture.md (Removing a machine, the Proof line), docs/strands.md (What removal does to the network), docs/testing.md (if it lists scenarios)
difficulty: medium
----
# Scenario: a removed machine is cut from the strand, and the apps say so

Last ticket of the key-rotation chain. The acceptance the plan set: a real-network scenario beside `strand-removal-cuts-network.integration.ts`.

## Topology

Party A, three machines: A1 the owner that founds the cadre and the closed strand and removes A3; A2 an always-on non-owner member admitted the owner-online way (`startPinningMember` + `admitMember`, as `machine-removal.integration.ts` does) that runs the strand; A3 a second non-owner member that runs the strand. Party B, one machine, joins the strand through the real formation handshake (the `strand-party-removal-via-formation-e2e` fixture). No membership writer is called by the test: every `Member`, `MemberPeer` and `StrandPeer` row is production's. Reconciler poll intervals through the harness as that fixture sets them; revocation enforcement on the production schedule on every machine (the cut is driven by the rows arriving, which is what an app gets), with one awaited `refreshRevocationEnforcement` where a gate would otherwise wait on the 5-minute backstop.

## The sequence and what is asserted

1. All four machines serve the strand; a B write converges on A1, A2 and A3; each of A's machines has a `StrandPeer` row and a `MemberPeer` binding under A's key (read on A1, scan-and-filter, never a point lookup).
2. A2 is stopped (the machine offline through the rotation).
3. A1 calls `removeMachine(A3)`. Asserted on its result: `strands` names the strand as `rotated`. On A1's strand database: a new `Member` key that is also a `Manager`, the old key absent, bindings for A1 and A2's strand peer ids under the new key, A3's binding only under the old key.
4. The cut. Connections that existed before from A3 to A1 and to B are gone after their refreshes; a B write after the removal converges on A1 and is read back on B, while A3 does not converge on it within `NO_CONVERGENCE_BUDGET_MS`; a write A3 attempts does not reach B. Both directions of evidence, as the cut scenario words it.
5. A2 restarts with no owner signer wired. Asserted: it converges on B's post-removal write and a later one, and its reconciler finishes with its binding under the new key present and the loop done, with no call on A2 by the test other than starting it.
6. Control side: A3's `CadrePeer` row is gone on A1 and A2; the `StrandPartyKey` row on A2 holds the new key (replicated), the pending row is gone.

Gate budgets follow the cut scenario's constants and the formation fixture's `RECONCILE_POLL_MS`; name each one's reason as those files do.

## The apps

- `packages/reference-app-rn/src/machine-removal.tsx` and `docs/reference-app-rn.md` "What removal does not do": the prompt and the doc stop saying the removed machine keeps the strands' member keys. New wording: removing the machine also replaces this cadre's membership key in each private workspace it manages, so the machine stops being served there; the plan's `strands` entries are shown so a workspace reported as `another-party` or `later` is named ("<name>: needs the other party's manager" / "finishes on a device that runs it"). The owner-key caveat stays.
- `packages/reference-app-web/src/lib/machines.svelte.ts` and `docs/reference-app-web.md`: the same wording where the web app has it.
- No new app tests: the wording is copy and the plan field is a projection the core spec already pins.

## Edge cases & interactions

- **A2's return must not depend on an owner**: A2 is started without an owner signer; its binding was written by A1's driver from A2's `StrandPeer` row. If the assertion in step 5 fails with A2 orphaned, the driver bound before A2's row replicated; the fixture waits for A2's row on A1 in step 1, so that is a defect, not a gate.
- **The first write after the cut may need retries** (three to four seconds measured in the cut scenario); the gates allow it.
- **Step 4's negative assertions** are only evidence beside the paired positive read on B, as the cut scenario's comment explains; keep that comment's substance.
- **Timing of the A3 cut on B**: B hangs up A3 on the refresh after the old key's departure replicates; with production scheduling that is the change path. If it proves flaky, drive B's refresh explicitly and say so.

## TODO

- The scenario file, registered the way its siblings are (check `docs/testing.md` and the package's scenario listing).
- App wording and both app docs.
- `docs/architecture.md` Removing a machine: the Proof line names this scenario; `docs/strands.md` What removal does to the network: a bullet on a machine removed from the cadre, pointing here.
- Run the scenario in the foreground; `yarn lint`.
