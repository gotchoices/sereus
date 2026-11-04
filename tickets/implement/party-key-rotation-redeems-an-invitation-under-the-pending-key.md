description: When a cadre removes a machine it replaces its membership key in each private workspace, but in a workspace another party manages it cannot seat the new key itself. Make the host's ordinary re-invitation finish the job: the cadre redeems the fresh invitation under the new key instead of the old one, and the replacement then completes on its own.
architecture: docs/strands.md#replacing-the-partys-key
files: packages/cadre-core/src/strand-membership-reconciler.ts (`ensureMembership`, `burnLeftoverInvite`, `clearRemovedMachines`, `latchDone`, `noteAttemptOutcome`, module doc), packages/cadre-core/src/strand-party-peers.ts (`PartyStrandPeerSource.isRotationPending`), packages/cadre-core/src/cadre-node.ts (`partyStrandPeerSource` ~10345, `openPendingPartyKey` ~10194, `isPendingPartyKeyRecipient`, `driveRotationIfPending` ~10233, the launch config at ~7596), packages/cadre-core/src/strand-instance-manager.ts (`armMembershipReconciler` ~1723, `StartStrandConfig`), packages/cadre-core/src/strand-party-key-rotation.ts (module doc, `prepare`, `cleanUpSuperseded`), packages/cadre-core/src/types.ts (`strand:party-key-rotation-blocked`, `StrandKeyRotationPlan`, `StrandKeyRotationOutcome` docs), packages/cadre-core/src/machine-removal.ts (doc), packages/cadre-core/test/strand-membership-reconciler.spec.ts, packages/cadre-core/test/strand-party-key-rotation.spec.ts, docs/strands.md (Replacing the party's key; What removal still does not do), docs/architecture.md (Removing a machine)
difficulty: hard
----
# The party's key replacement in a strand another party manages

`machine-removal-rotates-party-member-key` (complete) replaces the party's membership key K with a fresh key K' in every closed strand the party holds a key for. The driver (`strand-party-key-rotation.ts`) seats K' with K's manager signature, so in a strand where K holds no `Strand.Manager` row it stops at step 2, reports `needs-another-party`, leaves the `PendingStrandPartyKey` row in place, and the removed machine keeps being served there under K. This ticket closes that gap. The sealed pending row, `OpenedPendingPartyKey` and `CadreNode.openPendingPartyKey` it builds on are on `master` (`ticket(implement): removed-machine-receives-new-party-key`; its review sits in `blocked/` only because the sibling repositories' builds were stale).

## The decision: the host's invitation is the admission path

Three ways to get K' seated were weighed in the plan. The one chosen needs no new table, no new protocol and no new trust assumption.

**Chosen: the host re-invites the party, and the party redeems under K'.** The host's owner mints a formation invitation bound to the strand, as for any new party (`createOpenInvitation` plus `publishFormationInvite` with a `strandId`, the reference apps' existing flow), and hands it to the rotating party's owner out of band. The rotating party's owner redeems it (`formStrand` or `requestJoin`). The host's responder issues a single-use `Strand.Invite` under its manager key, as it does for every closed-strand formation; `adoptFormationMembershipInvite` reuses the stored `StrandPartyKey` row K (`ensureStrandPartyKey` adopts an existing row) and stages the invitation; the membership reconciler is re-armed. Today that reconciler would find K already a member and burn the invitation. After this ticket it consumes it under K' instead, and K' becomes a member without any manager act by the party. The driver then runs its remaining steps unchanged: bind every remaining machine under K' (step 3), no promotion (K is not a manager, so step 4 is skipped), K leaves (step 5, the self-signed `leaveStrand`; no resign), and the control swap (step 6).

**Also works, with nothing added: the host's manager admits K' by hand.** `addMemberByManager` with K' public half (which the removal's app will show: `pending-party-key-rotations-listed`) seats the same row. The reconciler notices K' seated on its next pass and kicks the driver the same way. No app offers that writer today, so this is the embedder's path, not the reference apps'.

**Rejected: a request row in the strand that the host's node answers.** A `Strand.KeyReplacementRequest` row signed by K, naming K' public half, answered by the host's node with `addMemberByManager`. K is held by the removed machine, which is the whole reason for the rotation, so a request signed by K is exactly what a stolen machine can write: it would ask for a successor of its own choosing, be admitted, bind itself under it and survive the rotation. A human confirmation on the host's side does not help, since the host cannot tell the party's request from the stolen machine's without asking the party's owner out of band, which is what the chosen path already is. The request row would have added a strand table (mirrored in two schema copies), a manager-side answering loop and a social-engineering surface, to carry one public key that a phone call carries. Not revisited unless the strand gains a way to tell a party's machines apart that the removed machine does not hold.

**What this leaves out, deliberately.** Only the founding party can host a bound formation (the `NOTE:` at `CadreNode.issueStrandMembershipInvite`: a joined party gets no host `Strand` row), so in a strand whose founder is gone and whose manager is a promoted party, the by-hand admission is the only path. A re-admission invitation is a bearer credential: whoever redeems the formation invitation seats a key of its choosing, so the invitation must reach the rotating party's owner and not the removed machine, as with every invitation today (`backlog/feat-strand-invitee-bound-invites` has this as an evidence arm).

## What changes

### The membership reconciler redeems under the pending key

`strand-membership-reconciler.ts`. One rule, stated in the module doc: **while a `PendingStrandPartyKey` row exists for the strand, the loop never writes a `Strand.Member` row under K.** It redeems or burns under K' when this machine can open the pending key, and leaves the invitation staged otherwise.

Replace `PartyStrandPeerSource.isRotationPending()` (`strand-party-peers.ts`; its only reader is this loop) with:

```ts
/** The party's pending key in this strand, as this machine can read it. */
export type PendingPartyKeyState =
  | { pending: false }
  /** A rotation is pending; `key` is null when the row is sealed to other machines, or this node runs on an ephemeral identity. */
  | { pending: true; key: OpenedPendingPartyKey | null };

pendingKey(): Promise<PendingPartyKeyState>;
```

It rejects when the row cannot be read, and the loop treats a rejection as `{ pending: true, key: null }`, as it treats an `isRotationPending` rejection today. `CadreNode.partyStrandPeerSource` implements it from `queryPendingStrandPartyKey`, the recipient check and `openPartyKey`; share the opening with `openPendingPartyKey` through one private helper that returns null when the row does not open here, so the driver's seam keeps rejecting and this one answers null.

The pass reads it once at the head of `attempt` (one control read per pass; it replaces the read `clearRemovedMachines` makes today, which now takes the state as an argument) and passes it to `ensureMembership`:

- **No rotation pending**: today's logic, unchanged.
- **Pending, key not readable here**: neither consume nor burn. An invitation staged here is left staged with one debug line per invitation ("left staged: the party is moving to a key this machine cannot read"); the pass is idle (`waitForPoll`). This case is a machine admitted after the removal, one on an ephemeral identity, or a failed read.
- **Pending, key opened**: let N be the keypair of the opened key. If N is already a member (admitted by hand, or seated by a sibling's redemption), burn a staged invitation against N (`burnLeftoverInvite` already takes the keypair) and kick the driver. Else if an invitation is staged, `consumeInvite` with `memberKey` N public half, under `OWN_TRANSACTION`; on success clear the stage, log, kick the driver; on failure route through `handleConsumeFailure` as today (busy keeps it staged, dead drops it, half-committed warns and drops). Else the pass is idle: the driver has reported `needs-another-party` once per stamp already, and nothing happens until the host acts.

`ensureMembership` keeps its contract, "K's member row is visible", for the binding steps that follow: return whether K is a member, read once at the head. Binding under K after K has left (between step 5 and the swap replicating here) is refused by `MemberPeer.MemberExists` and polled, as the driver's module doc already states; the swap's `rekeyParty` ends it.

**The loop does not latch done while a rotation is pending.** `latchDone` takes the pending flag and returns without latching, logging once; a pass that wrote nothing is idle, so the cadence is the flat poll interval (30 s by default), not the ladder. This is what makes the by-hand admission and a sibling's redemption get noticed: each pass with the key opened and N a member kicks the driver. The pending state ends with the swap: `rekeyParty` rebuilds the loop under K', its next pass finds no pending row, clears the removed machine's stale binding and latches done as before.

**The blocked re-join report must not fire for a deliberately staged invitation.** `noteAttemptOutcome` counts passes that left the invitation staged toward the "probable blocked re-join" warning (`UNFINISHED_PASSES_BEFORE_ESCALATION`). A pass in the "pending, key not readable here" case left it staged on purpose; do not count it. A refused consume under N is a genuine unfinished attempt and still counts.

### The driver is kicked when the new key is seated

A new optional reconciler dep, `onPendingKeySeated?: () => void`, wired by `StrandInstanceManager.armMembershipReconciler` from a new `StartStrandConfig.onPartyKeySeated?: (strandId: string) => void`, which `CadreNode.launchStrand` sets to `void this.driveRotationIfPending(strandId, 'the pending key is seated in the strand')`. `driveRotationIfPending` already refuses on a non-owner machine, a non-recipient and a removed node, with a log line each; the driver's single flight and its re-drive of joined strands handle a kick that lands during a run (`machine-removal-rotates-party-member-key` review finding).

The driver itself changes only in its documentation: the step 2 blocked branch now says what seats K' from outside (the reconciler's redemption of the host's invitation, or the host's manager by hand), and that the reconciler kicks the driver when it sees the seat. Step 1 gains a `NOTE:` tripwire at `cleanUpSuperseded`: a superseded key that holds a seat in a strand the party does not manage can only be revoked by that strand's manager (the row carries only public halves, so the driver cannot `leaveStrand` as it); fine now, since it takes a second removal between the host's re-admission and the swap that follows it within seconds on the redeeming owner machine; if it is ever hit, seal the superseded private halves into the row so the driver can self-leave them.

### Nothing changes on the host's side

The host's responder, its invitation issuance and its approval are untouched. The host is not told that a party replaced its key; from the strand's rows it is an ordinary join (a `ConsumedInvite` naming K') followed by an ordinary departure (K's self-signed leave). Say so in `docs/strands.md`.

### The old key when the party cannot leave

If the rotating party loses every machine that could drive (the pending key is sealed to machines that are all gone), K stays a member and the removed machine stays served. The host's manager revokes K by hand (`revokeMember`), the same act as removing any party, and the party re-joins later with a fresh invitation, which seats a fresh identity through `ensureStrandPartyKey`'s mint only after the party deletes its own `StrandPartyKey` row. No new mechanism; state it as the limit in "What removal still does not do".

### Strands with no identity

A closed strand the party joined but holds no `StrandPartyKey` row for is skipped by the removal and the driver. That is right: the party seated nothing there, so the removed machine holds no membership identity to retire. It keeps the read secret (`JoinedStrand.MemberPrivateKey`), which is the documented "removal does not rotate the read secret" limit. Confirm the docs say this and move on.

## Edge cases & interactions

- **Pending row sealed to other machines, invitation staged** (a machine admitted after the removal re-joins, or an ephemeral-identity node): nothing is written, the invitation stays staged, the loop idles on the flat interval. Pinned by a test (below).
- **K has left, the swap has not replicated here** (step 5 done on another machine, pending row still present): a staged invitation is still redeemed or burned under N, never consumed under K, so K is not re-seated. By inspection of the rule; the branch is the same code as the first case.
- **Two owner machines redeem the same invitation** (`JoinSuccess` rows stage it on every owner machine): `ConsumedInvite`'s primary key lets one through; the loser classifies it as dead and drops it. Existing classification, by inspection.
- **K' admitted by hand and an invitation also staged**: burned against N, driver kicked. By inspection; the burn arm is existing code with a different keypair.
- **The join never finished before the removal** (K never seated, invitation still staged, then a machine removed): the invitation seats N directly; the driver's `stepDown` finds K no member and writes nothing; the swap follows. Pinned at the driver by the new rotation test (K a plain member or absent; nothing changes in the driver for it).
- **Second removal before the swap, after the host re-admitted the first pending key**: the superseded key holds a seat K cannot revoke; the `NOTE:` tripwire above. By inspection.
- **Sealed strand**: nobody can admit N; the driver stays blocked and the loop idles for the life of the pending row. `pending-party-key-rotations-listed` names it to the app.
- **The host's `Invite` row has not replicated to the redeeming machine yet** when the formation returns: `consumeInvite` fails, is classified as retry, and the ladder re-runs it. Existing behaviour, by inspection.
- **The driver's run races the redemption**: the driver reads K' no member and K no manager, reports blocked (deduplicated per stamp); the kick after the redemption runs it again. By inspection of `prepare` and `reportBlocked`.
- **An app transaction is open or the offline queue holds writes**: the consume is refused busy and retried, as today.
- **A non-owner machine** (a replica) with the key opened and N seated kicks the driver every pass until the owner machine swaps; `driveRotationIfPending` logs "no enrolled owner key" each time. Bounded by the seconds between the seat and the swap; add a `NOTE:` at the kick if the log ever matters.
- **`rekeyParty` rebuilds the loop mid-pass**: it stops and awaits `settle()` first. Existing.
- **The removed machine redeems the host's invitation** (it was handed to the wrong person): it seats a key of its own, which the host's manager must revoke. Out of scope; the bearer-invite arm.

## Tests

Two in `strand-membership-reconciler.spec.ts`, against the real strand engine the spec already uses, with a stub `PartyStrandPeerSource.pendingKey` and a spy `onPendingKeySeated`:

- **Redeems under the pending key.** Founder (manager) issues an invitation; joiner K is already a member; `pendingKey` answers the opened key N; the invitation is staged. One pass: `Strand.Member` holds N, `ConsumedInvite` names N, K's row is untouched, the stage is cleared, the kick fired once.
- **Leaves the invitation alone when the key is sealed elsewhere.** Same setup with `pendingKey` answering `{ pending: true, key: null }` and K not a member: after a pass no `Member` row for K, no `ConsumedInvite`, the invitation still staged, no `console.warn`.

One in `strand-party-key-rotation.spec.ts`: K is a member but not a manager; the strand's manager (another party's key) admits N; a run binds this machine and the sibling under N, writes no `Manager` row, K leaves, and the swap entry names N. This is the cross-party path at the driver layer and does not exist today, since every existing run has K as manager.

No test for the kick wiring, the seam replacement or the docs.

## Docs

- `docs/strands.md` "Replacing the party's key": replace the "A strand the party does not manage" bullet with the flow above (the host re-invites; the loop redeems under the pending key; the driver finishes; or the host's manager admits the key by hand), what the host sees, and the limit when the party cannot leave. "What removal still does not do": the bearer-invite note already there gains the re-admission case.
- `docs/architecture.md` "Removing a machine": the sentence ending "the cross-party flow is `plan/party-key-rotation-across-parties`" now states the flow in one sentence and links the strands section.
- `types.ts` (`strand:party-key-rotation-blocked`, `StrandKeyRotationPlan`, `StrandKeyRotationOutcome`), `machine-removal.ts` and the driver's module doc: replace every reference to `plan/party-key-rotation-across-parties` with the doc section.
- The reconciler's module doc: a "Redeeming under the pending key" section stating the rule and the three cases.

## TODO

- Replace `PartyStrandPeerSource.isRotationPending` with `pendingKey` (`strand-party-peers.ts`); implement it in `CadreNode.partyStrandPeerSource` sharing the opening with `openPendingPartyKey`.
- Reconciler: read the state once per pass; `ensureMembership` with the three cases; `burnLeftoverInvite` and `consumeInvite` under N; `clearRemovedMachines` takes the flag; `latchDone` does not latch while pending; the blocked re-join counter ignores a deliberately staged invitation; `onPendingKeySeated` dep.
- `StartStrandConfig.onPartyKeySeated`, wired in `armMembershipReconciler` and `launchStrand` to `driveRotationIfPending`.
- Driver docs and the `cleanUpSuperseded` `NOTE:`.
- The three tests.
- Docs and the doc references listed above.
- `yarn workspace @serfab/cadre-core typecheck`, `yarn lint`, the reconciler, rotation, instance-manager-membership and remove-machine specs, then `yarn workspace @serfab/cadre-core test`.
