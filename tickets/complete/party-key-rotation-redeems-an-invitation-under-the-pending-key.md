description: When a cadre removes a machine it replaces its membership key in each private workspace, but in a workspace another party manages it could not seat the new key itself. The host's ordinary re-invitation now finishes the job: the cadre redeems the fresh invitation under the new key instead of the old one, and the replacement then completes on its own.
architecture: docs/strands.md#replacing-the-partys-key
files: packages/cadre-core/src/strand-membership-reconciler.ts (`readPendingKeyState`, `ensureMembership`, `ensureMembershipUnderOwnKey`, `leaveInviteStaged`, `seatPendingKey`, `kickRotationDriver`, `clearRemovedMachines`, `latchDone`, `handleConsumeFailure`, `noteAttemptOutcome`, module doc "Redeeming under the pending key"), packages/cadre-core/src/strand-party-peers.ts (`PendingPartyKeyState`, `PartyStrandPeerSource.pendingKey`), packages/cadre-core/src/cadre-node.ts (`PendingPartyKeyRead`, `readPendingPartyKey`, `readPendingPartyKeyState`, `openPendingPartyKey`, `partyStrandPeerSource`, the `onPartyKeySeated` line in `launchStrand`), packages/cadre-core/src/strand-instance-manager.ts (`StartStrandConfig.onPartyKeySeated`, `armMembershipReconciler`), packages/cadre-core/src/strand-party-key-rotation.ts (module doc step 2, `NOTE:` at `cleanUpSuperseded`), packages/cadre-core/src/types.ts, packages/cadre-core/src/machine-removal.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-party-key-rotation.spec.ts, docs/strands.md (Replacing the party's key; The host's re-invitation seats the new key; What removal still does not do), docs/architecture.md (Removing a machine)
difficulty: hard
----
# Complete: the party's key replacement in a strand another party manages

Implemented in `ticket(implement): party-key-rotation-redeems-an-invitation-under-the-pending-key`; reviewed here with two small inline edits and no tickets filed.

## What landed

While a `PendingStrandPartyKey` row exists for a strand, the membership reconciler never writes a `Strand.Member` row under the party's current key K, which the removed machine holds. Step 2 of each pass reads the pending state once at its head (`PartyStrandPeerSource.pendingKey`, replacing `isRotationPending`) and branches: no rotation pending runs today's logic (`ensureMembershipUnderOwnKey`); pending with the key unreadable here leaves a staged invitation alone and idles, without counting toward the blocked re-join report; pending with the key opened redeems a staged invitation under the new key N (or burns it if N is already seated) and kicks the rotation driver through the new `onPendingKeySeated` dependency, wired by `StartStrandConfig.onPartyKeySeated` to `CadreNode.driveRotationIfPending`. The loop does not latch done while a rotation is pending, so a by-hand admission is noticed on the next pass. `CadreNode` shares one private `readPendingPartyKey` between the driver's seam (throws on a closed row) and the reconciler's (answers a null key). The driver itself only gained documentation and a `NOTE:` at `cleanUpSuperseded`. `docs/strands.md` gained the subsection "The host's re-invitation seats the new key" and the "old key when the party cannot leave" bullet; `docs/architecture.md` states the flow in one sentence.

## Review findings

**Read first, before the handoff:** the full implement diff across the nine source files, the two specs and the two docs.

**Checked by reading and running the code.**

- Happy path: K a plain member of a host's strand, the host's invitation staged, the key opened. One pass seats N, writes `ConsumedInvite` naming N, leaves K's seat and K's binding alone, clears the stage, kicks the driver; the driver's `prepare` then finds N a member and K no manager, binds under N, skips promotion, has K leave, swaps. Both halves are pinned by the two new tests and the driver test.
- The host's re-invitation really reaches the loop: `formStrand` on a strand already running here is the existing re-formation path (`adoptFormationMembershipInvite` adopts the stored `StrandPartyKey` row through `ensureStrandPartyKey`, stages the invitation and `notifyMembershipInviteStaged` kicks the running loop), so the redemption is attempted at once rather than on the next poll. Confirmed statically; the real-network proof is `implement/scenario-party-key-rotation-across-parties`, which has this ticket as a prereq.
- The kick from inside a pass against the driver: `StrandPartyKeyRotationDriver.drive` has an in-flight guard per strand and re-drives a joined call after the run in flight, so the per-pass kick cannot start concurrent runs; `rekeyParty` stops and settles the old loop before arming the new one, so a pass in flight when the swap lands finishes under K (a binding write after K's leave is refused and retried, as the module doc says) and the rebuilt loop takes over.
- The rejected pending read delaying the ordinary redemption under K by one idle pass (the handoff's first starting point): `requireControlDatabase` throws only when the node is stopped or has no control database, and strands launch after `_running` is set, so a transient control reconnect does not reject the read (it is a local store read). Accepted as the ticket asked.
- Error paths: a `sealed` refusal under the pending key drops the invitation and idles rather than stopping for good; busy, half-committed, dead and retry arms are the single-sourced existing ones. An undecodable pending private key throws to the pass catch and retries on the ladder, the same posture the driver takes (`failed` → `pending`).
- Docs: the `####` anchor `#the-hosts-re-invitation-seats-the-new-key` sits under the `###` "Replacing the party's key" heading and the slug is the GitHub form (apostrophe dropped). Every former reference to `plan/party-key-rotation-across-parties` in code and docs now points at the doc section. Nothing else that should have changed was found: `docs/testing.md` needs nothing until the scenario lands.
- Site claims: the grep over open tickets found this ticket, two backlog tickets that only list the reconciler as a reference file, and two blocked tickets on other defects. None claims this change.
- `yarn workspace @serfab/cadre-core typecheck` and `yarn lint`: exit 0. The four related spec files: 81 passed. `yarn workspace @serfab/cadre-core test`: 195 files, 2611 passed, 1 skipped (the pre-existing skip), 127 s. Logs in `tickets/.logs/party-key-rotation-redeems-an-invitation-under-the-pending-key.review*.log`. No pre-existing failures surfaced. The stale-build guard did not refuse this run.

**Minor, fixed inline.**

- `handleConsumeFailure` took its `under` argument with a default of `'own-key'`, so the own-key call site did not say which classification it wanted. The default is gone and both call sites pass the argument explicitly.
- Tripwire added (below) at `latchDone`.

**Major:** none found. Nothing here reaches the filing bar.

**Tripwires recorded.**

- `strand-membership-reconciler.ts` → `latchDone`, new `NOTE:`: a rotation the host never finishes keeps the loop polling flat for good, one control read plus the strand reads per poll interval per such strand; re-arm on the strand's `Member` table changing if a party ever carries many such strands.
- The implementer's two `NOTE:`s stand as written: `kickRotationDriver` (a non-owner machine that reads the key kicks every pass until the swap) and the driver's `cleanUpSuperseded` (a superseded key seated in a strand the party does not manage can only be revoked by that strand's manager).

**Considered and declined, no ticket and no note.**

- `PendingPartyKeyRead` in `CadreNode` and `PendingPartyKeyState` in the seam are two shapes of one read, and the reason a row is closed is dropped before the reconciler logs "a key this machine cannot read". The driver needs the reason to throw it and the reconciler does not act on it; carrying it would add a field for one debug line.
- The pending branches use the flat poll without the idle-escalation warning the own-key wait has. The driver already reported `needs-another-party` for the same situation, so a second warning would say nothing new.

**Tests.** The three added tests were kept: each pins one behaviour the implementation could lose silently (the redemption under N with K's seat untouched; the deliberate stay with no blocked re-join report; the driver resuming from a host's admission with no promotion). The updated sibling-binding test is right for the new no-latch rule. No test added: no defect was found, and the contracts I checked by hand (driver re-entrancy, the re-formation staging) are already pinned by their own specs.

**Not run:** the integration scenarios. The real-network proof is the scenario ticket named above.
