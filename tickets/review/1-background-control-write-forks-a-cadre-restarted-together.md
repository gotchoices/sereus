description: When two machines of a cadre start at the same moment, each used to write its own address record before it could reach the other, and the two writes conflicted permanently, so the cadre could no longer add machines (gotchoices/sereus#53). Background control writes now wait until another machine is reachable when the party has other members; this ticket reviews that change.
architecture: docs/architecture.md#writes-made-while-alone
repro: verified
files: packages/cadre-core/src/cadre-node.ts (`controlWriteCouldFork`, formerly `ownerKeyWriteAlone`; `publishSelfRecordInBackground`; `selfPeerPublishDeferred`; `scheduleSelfRegistration`; `startRecordRefresh`'s `republish`; `runDrainControlReplication` steps 2 and 5; `startPendingJoinRunner`; `resolveStrandPartyKey` NOTE), packages/cadre-core/src/pending-join-runner.ts (`deferBackgroundWrites` dep, `resumeDeferredWrites`, `startAttempt`/`attemptOnce` `background` flag, `deferAttempt`, `ageOut`), packages/cadre-core/test/pending-join-runner.spec.ts, packages/integration-tests/src/scenarios/control-members-restarted-together.integration.ts (the reproduction, written in the fix stage), docs/architecture.md, docs/strands.md, docs/testing.md
----
## What changed

**One predicate.** `CadreNode.ownerKeyWriteAlone` is renamed `controlWriteCouldFork()`: no sibling reachable (`committedAlone()`) and `authorizedControlPeers.size > 0`, read after `membershipGateDrain`. Its callers `addOwner`, `removeOwner`'s re-vouch and `redeemOwnerGrantLocally` are unchanged in behaviour. The doc comment now says "no sibling reachable" and carries a `NOTE:` tripwire for an empty snapshot on a node that does have members (it reads as a party of one and writes alone, as before).

**Self-record seam.** `publishSelfRecordInBackground(reason, publish)` runs a background self-record publish unless `controlWriteCouldFork()`; on deferral it sets the new `selfPeerPublishDeferred` flag, logs, and returns `'deferred'` without stamping `lastSelfRecordPublishAt` and without escalating. The boot one-shot (`publishSelfRecordUnlessCurrent`) and both `startRecordRefresh` triggers (heartbeat and `self:peer:update`, `registerSelf`) go through it. The boot path still wires `startRecordRefresh()` and triggers the reconcile pass after a deferral. `registerSelf()` stays unguarded (awaited by callers).

**A separate flag, not `pendingSelfPeerWrite`.** The ticket proposed setting `pendingSelfPeerWrite` on deferral. That flag makes the drain call `registerSelf()`, which always writes, so a redeemed-invitation device whose boot publish was deferred would write its record a second time (undoing `invited-machine-skips-its-first-publish`). The new `selfPeerPublishDeferred` makes the drain call `publishSelfRecordUnlessCurrent()`, which still writes when the record is old (heartbeat) or the addresses changed. Drain step 2 now takes and clears both flags before the publish rather than after, so a flag set while that publish runs (a write that committed alone after all, a heartbeat deferred meanwhile) survives to the next growth instead of being wiped. That is a small behaviour change to `pendingSelfPeerWrite` handling; reviewer, confirm you agree.

**Pending-join runner.** New dependency `deferBackgroundWrites()` (wired to `controlWriteCouldFork`). `startAttempt(entry, background)`: background attempts (from `pump` and from `consider`'s expired/held-join path) check it inside `attemptOnce`, after the `joinedHere` branch. When deferring, `deferAttempt` leaves the entry unscheduled and sets `deferredWrites`. `resumeDeferredWrites()` kicks a pass, and drain step 5 calls it after `reissueWritesMadeAlone()`. `ageOut` uses the same predicate in place of `isAlone()`. `attemptNow` (from `requestJoin`) is never deferred. An outcome of an attempt already made (`joinedHere`, or the write right after `deps.attempt` returns) is recorded even alone, because the approval exists only in memory and a restart would turn it into a `token-spent` failure.

## Audit of background control writers (dispositions)

- Boot one-shot, heartbeat, `self:peer:update` republish: guarded through `publishSelfRecordInBackground`.
- `publishFirstSelfRecord`, revoked-row reap, `joinedStrands.syncWithParty` in the reconcile pass: already gated on `hasReachableControlSibling()`. No change.
- Growth drain (revocation re-issue, self row, `retouchSelfDeviceToken`, `reconstructAuthoredMembership`, pending owner authorizes, pending-join re-issue): runs on the reachability edge. No change; the connection can still drop mid-drain, as before.
- `pending-join-runner.ts`: background attempts (their `StrandPartyKey` seat inside `formStrand` and the outcome rows), the `expired` outcome and `ageOut`'s removal wrote alone before this change (only `ageOut` was gated, on plain `isAlone()`). Now deferred as described above. Concrete fork trigger this closes: two owner machines restarted together that both hold an expired pending join both wrote a `JoinFailure` row on their first pass, which runs at start, before either reached the other.
- Inbound handlers (cadre invitation, owner grant redemption): write in answer to a peer counted through `admittingDevices` (`admitRedeemingDevice` in both handlers' options). Seed delivery (`applySeed`) writes no control row. No change.
- Strand watcher: reads only, except `resolveStrandPartyKey`'s heal path, where a founder launching a closed row stored without its key mints a `StrandPartyKey` in the background. Left unguarded (only the row's founder mints, and only for that repair case), with a `NOTE:` tripwire at the site.
- Membership gate watch, `refreshDelegateGrants`, `refreshStrandPeerAddrs`: no control writes.
- `registerDeviceToken`: public and awaited; its background caller is the drain only.

## Edge cases, as read in the code

- Device redeeming within a second of start: the redeeming device is reachable through `admittingDevices` during the write and is an authorized member after it. The boot publish is not deferred, and `publishSelfRecordUnlessCurrent` still spares the second write. `scheduleSelfRegistration`'s comment is rewritten.
- Restart while the sibling stays down: the node defers until a sibling appears. Nothing awaits that write (`relayStatus` does not; other machines cannot reach it anyway). An owner minting a seed while alone gets the minter's address from its own row, which may be from the previous session. Not checked beyond reading the code.
- Address change while alone: deferred, flag set; the drain publishes the current addresses.
- A lone founder writes at once (empty snapshot, no other members).

## Tests

- Added `pending-join-runner.spec.ts` → "defers a background attempt while a write could fork the party, and makes it once a sibling is reachable": no attempt while deferring, then `resumeDeferredWrites()` leads to one attempt and a `joined` outcome. It pins the runner's new branch. The self-record seam is covered by the reproduction scenario; no unit test was added for it.
- Existing reproduction `control-members-restarted-together.integration.ts` (fix stage): failed 2/2 on HEAD per the fix ticket; with this change passed 3/3 (9.8 s, 9.7 s, 13.3 s).

## Validation run

- `yarn workspace @serfab/cadre-core typecheck`, `yarn typecheck` (repo), `yarn lint`: clean. cadre-core rebuilt.
- `yarn workspace @serfab/cadre-core test`: 189 files, 2558 passed, 1 skipped.
- `control-write-while-alone-convergence` (2), `cadre-invite-any-member` (1), `control-delete-while-alone-convergence` (2): all passed, 1 run.
- **Not run:** `pending-join-survives-restart`, `strand-always-on-replica-hosts-cross-party-join`, `strand-always-on-replica-survives-phone-loss`, `owner-grant-backup-recovery`, `owner-grant-without-machine`. These were extra checks beyond the ticket's list, chosen because the change touches their paths. The stale-build guard refused every run for about 18 minutes: `../optimystic`'s own ticket runner was editing `db-p2p`/`db-core` source. Per `tickets/rules/sibling-repos.md` the sibling was not built from here. Run them once the sibling's build is fresh: `yarn workspace @serfab/integration-tests exec vitest run <name>`. One attempt during that window printed "No test files found" ahead of the guard error; that is probably a side effect of the failed global setup, but confirm the filter matches when you rerun.

## Known gaps and judgment calls for the reviewer

- **Availability cost of deferring pending-join attempts.** On an owner machine that reaches none of its siblings in a party with other machines, background join attempts now wait until it does. The common case is a phone whose always-on machines are down while the inviter is up. That shape has only one owner machine, so it carries no fork risk, but today we cannot tell from the membership rows which machines hold owner keys. `requestJoin` still attempts at once. This is documented in `docs/strands.md` → "Background attempts wait for a sibling". If this is judged too costly, the narrower alternative is to defer only the `expired` outcome and `ageOut` and leave attempts alone.
- **`ageOut` on a lone founder.** It used to be gated on plain `isAlone()`, which is always true for a party of one, so a lone owner never removed finished joins. With the new predicate it does.
- **`requestJoin` racing a deferring background attempt.** A `requestJoin` can join a background attempt for the same join that is in the middle of deciding to defer, and then return without attempting. The window is one membership-snapshot refresh. A `NOTE:` is at `startAttempt`.
- **Predicate-then-flag window.** Between `controlWriteCouldFork()` resolving and the flag being set, a growth drain could start. It would see the flag only if its own awaits outlast that gap (they do: step 1 does I/O first). The worst case is waiting for the next heartbeat. Not handled.
- **Release note:** a cadre already forked by 1.19.x stays forked after this fix. Healing it, and the torn multi-collection commit (`CoordinatorPartialCommitError`) seen when adding a machine to it, still need the upstream work `tickets/blocked/forked-control-collection-sync-livelocks.md` waits on.

## Docs touched

`docs/architecture.md`: "Cadre Node" item 4, the boot-time publish sentence under the seed section, and "Writes made while alone" (a new labelled paragraph on background versus awaited writes, the `OwnerKey` paragraph now names the shared predicate, plus the Proven-by and Tickets lines). `docs/strands.md`: "While cut off from the party" is narrowed, and a new "Background attempts wait for a sibling" paragraph is added. `docs/testing.md`: the paragraph on a node's first address-record publish. Comment updates in `control-database.ts` (`deleteCadrePeer`) and the always-on replica scenario's `awaitBootRecordOnPhone` doc. `tickets/backlog/bug-owner-key-removal-revouch-made-alone-is-not-reissued.md`'s `files:` header now names `controlWriteCouldFork`.
