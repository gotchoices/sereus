description: When two machines of a cadre start at the same moment, each used to write its own address record before it could reach the other, and the two writes conflicted permanently, so the cadre could no longer add machines (gotchoices/sereus#53). Writes nothing needs made at once now wait until another machine is reachable when the party has other members.
architecture: docs/architecture.md#writes-made-while-alone
repro: verified
files: packages/cadre-core/src/cadre-node.ts (`controlWriteCouldFork`, `publishSelfRecordInBackground`, `registerSelfUnlessCouldFork`, `selfPeerPublishDeferred`, `runDrainControlReplication` steps 2 and 5), packages/cadre-core/src/pending-join-runner.ts (`deferBackgroundWrites`, `resumeDeferredWrites`, `startAttempt`/`attemptOnce`, `attemptNow`, `ageOut`), packages/cadre-cli/src/commands/start-owner.ts (`registerOwnerNode`), packages/cadre-core/test/pending-join-runner.spec.ts, packages/integration-tests/src/scenarios/control-members-restarted-together.integration.ts, docs/architecture.md, docs/strands.md, docs/testing.md
----
## What was built

One predicate, `CadreNode.controlWriteCouldFork()` (formerly `ownerKeyWriteAlone`): no sibling reachable while the party has other authorized members, read after the start-time membership refresh. Writes nothing needs made at once consult it and wait for a sibling instead of committing alone:

- The self address record's boot publish, heartbeat and address-change republish go through `publishSelfRecordInBackground`. On deferral it sets `selfPeerPublishDeferred`, and the next growth drain publishes the record unless it is still current (`publishSelfRecordUnlessCurrent`).
- `cadre start --owner`'s startup publish goes through the new public `registerSelfUnlessCouldFork()` (added in review, see below).
- The pending-join runner's background attempts, the `expired` outcome due in an attempt's place, and the removal of a finished join (`ageOut`) take a `deferBackgroundWrites` dependency. Drain step 5 resumes them with `resumeDeferredWrites()`. `requestJoin` (`attemptNow`) is never deferred, and neither is recording the outcome of an attempt already made.
- Drain step 2 takes and clears both self-record flags before its publish, so a flag set while that publish runs survives to the next growth.

`OwnerKey` adds (`addOwner`, `removeOwner`'s re-vouch, local owner grant redemption) keep refusing `alone` through the same predicate. The implement-stage handoff (`ticket(implement): background-control-write-forks-a-cadre-restarted-together`) has the full audit of background control writers and their dispositions.

## Review findings

Read the implement diff first, then the handoff, then the surrounding code in `cadre-node.ts` (self-record publish, drain, membership gate, `authorizedAmong`) and `pending-join-runner.ts` (pass, consider, pump, attempt).

**Found and fixed in this pass**

- **`cadre start --owner` still forked on a restart.** `registerOwnerNode` (`packages/cadre-cli/src/commands/start-owner.ts`) called the unguarded public `registerSelf()` right after `node.start()`, before any sibling identifies. Two CLI owner servers restarted together (a compose restart, a power cut) would each write their `CadrePeer` row alone: the same fork this ticket fixes, on a path the audit had not covered. Added `CadreNode.registerSelfUnlessCouldFork()`, which routes `registerSelf` through `publishSelfRecordInBackground` (now generic over the publish's outcome type). The CLI uses it and prints a `deferred` message, with `Record<typeof selfReg, string>` keeping the message table exhaustive. A lone founder (empty membership) still writes at once, so the first seed still carries the minter's address. In a party with other members and none reachable, a seed minted before the drain carries the row from the previous session. `docs/architecture.md` (seed section, "Writes made while alone") now says so. cadre-host and cadre-provider never pass `--owner`, so the CLI is the only such caller. No test added: the predicate is the one the reproduction scenario already covers, and the CLI change is wiring.
- **`requestJoin` could return without attempting.** When `attemptNow` joined a background attempt for the same join that then deferred, the explicit request ended with no attempt (the implementer had left a `NOTE:` about it). `attemptOnce` and `startAttempt` now resolve `'deferred'`, and `attemptNow` starts its own foreground attempt when the joined one deferred. The `NOTE:` is removed, and `docs/strands.md` → "Background attempts wait for a sibling" says so. Added a regression test, "a requestJoin that joins a background attempt which then defers still attempts". I confirmed it fails with the fix disabled and passes with it.

**Checked, agreed, no change**

- Drain step 2's reordering (both flags taken before the publish): agreed. Before, a self write that started alone and ended while the drain's publish joined it (single-flight) had its re-touch flag wiped after the fact. Now that flag survives to the next growth, or the next heartbeat writes the row with the sibling reachable. A publish that fails loses its flag, as it did before.
- `controlWriteCouldFork` excludes this node's own row (`authorizedAmong` filters `selfPeerId`), so a lone founder reads as a party of one. `membershipGateDrain` never rejects (`drainMembershipGate` catches), so awaiting it from the runner's attempts and `ageOut` cannot turn into attempt failures.
- Hot loop: a deferred join is rescheduled by the next pass and defers again, at most once per pass (passes are triggered by changes plus the backstop). No retry storm.
- Predicate-then-flag window: only microtask hops lie between the predicate and setting the flag, and a growth edge before the predicate makes the predicate false. The implementer's analysis holds.
- `ageOut` on a lone founder now removes finished joins. Before, the plain `isAlone()` gate was always true for a party of one, so finished joins never aged out. That was a latent bug, and this change fixes it.
- Availability cost (an owner machine that reaches no sibling makes no background join attempts) is documented in `docs/strands.md`. I agree with the conservative choice while the membership rows cannot say which machines hold owner keys.
- The implementer's runner test ("defers a background attempt …") pins the new branch with real logic. Kept.
- Tripwires already parked by the implementer, left as they are: the empty-snapshot `NOTE:` on `controlWriteCouldFork`, and the strand-watcher `StrandPartyKey` heal `NOTE:` at `resolveStrandPartyKey`.
- Docs: re-read `architecture.md` (Cadre Node item 4, seed section, "Writes made while alone"), `strands.md` ("While cut off", "Background attempts wait for a sibling") and `testing.md` (first-publish paragraph). They match the code after the two fixes above.
- Error handling, resource cleanup, type safety: the new flags are reset in `stop`/`resetSessionState`. No `any`. The deferral path logs at debug and does not escalate, which is intended because a deferral is not a failure.

**Size:** `cadre-node.ts` is 11,526 lines (`wc -l`). This is tracked by `tickets/backlog/debt-cadre-node-single-file-size.md`, so no new ticket. This change adds about 40 lines there.

**Release note (carried from implement):** a cadre already forked by 1.19.x stays forked. Healing it waits on the upstream work in `tickets/blocked/forked-control-collection-sync-livelocks.md`.

**No tickets filed.** Both defects were fixed inline. Nothing else met the filing bar.

## Validation (review)

- `yarn typecheck`, `yarn lint`: clean. cadre-core and cadre-cli rebuilt.
- `yarn workspace @serfab/cadre-core test`: 189 files, 2559 passed, 1 skipped. When I first tried, the stale-build guard refused (`../optimystic`'s `db-p2p` was being edited). In that window I ran only `pending-join-runner.spec.ts`, from a scratch config without the guard. That spec touches no `db-p2p` path. The full suite ran once the sibling's build was fresh.
- Integration, all passed: `control-members-restarted-together` (the reproduction), `pending-join-survives-restart`, `strand-always-on-replica-hosts-cross-party-join`, `strand-always-on-replica-survives-phone-loss`, `owner-grant-backup-recovery`, `owner-grant-without-machine`. These are the five the implementer could not run, plus the reproduction.
- Not run: `provider-container-joins-by-invitation`, the only scenario that runs the real `cadre start --owner`. It needs Docker, and its founder is alone in its party, so it writes at once exactly as before.
