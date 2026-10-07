description: A member that admits a device by invitation while the owner is offline now hands the device the party's control data before writing the admission, so the admission commits on the first try even when that member is the only one online, and the returning owner sees the device. Review the change and the one-member test scenario that now covers it.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-invite-protocol.ts (`CadreInviteHandlerOptions.catchUpDevice`, `CadreInviteStore`, `seatAndRedeem`, `catchUpDeviceIfLive`), packages/cadre-core/src/cadre-node.ts (`admittingDevices`, `catchUpRedeemingDevice`, the `authorizePeer` in `startControlBackfill`, the handler construction in `start`), packages/cadre-core/src/peer-join-backfill.ts (`forceCatchUpPeer`, `trackRun`, `settleRun`, `inFlight` is now a Map), packages/cadre-core/src/control-database.ts (`isCadreInviteLive`), packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, docs/architecture.md, tickets/blocked/forked-control-collection-sync-livelocks.md
----

# The member hands the device its control store before writing the admission

## The problem this fixes

A device P that connects to member M to redeem a cadre invitation joins M's control write cohort at once. With the owner offline and M the only other node, M's cohort is {M, P}, and a cohort of two commits only when both hold the write. P held no control blocks, so it refused the `CadrePeer` and `OwnerKey` revisions (`missing-base-revision`). The admission tore, P was admitted only on a retry, and the returning owner forked onto a different history of `CadrePeer` and never listed P. The fix ticket has the full trace; the fork class is `tickets/blocked/forked-control-collection-sync-livelocks.md` → "Third trigger", whose first line now says this landing prevents it.

## What changed

**Handler (`cadre-invite-protocol.ts`).** New option `catchUpDevice?: (peerId) => Promise<void>`. `seatAndRedeem` now runs: verify → seat → `catchUpDeviceIfLive` → `redeemCadreInvite`. `catchUpDeviceIfLive` calls the callback only when `store.isCadreInviteLive(inviteKey)` is true. A throw from either the check or the push is logged, and the write goes ahead. The accepted-tradeoff `NOTE:` (the device keeps a store it was not admitted to if the write then fails; revisit if a control table ever carries data a non-member must not see) is at the call site. `CadreInviteStore` gains `isCadreInviteLive`.

**Liveness pre-check (`ControlDatabase.isCadreInviteLive`).** This goes further than the ticket's seat-count suggestion. It applies the same conditions as `hasLiveCadreInvite` (not withdrawn, unexpired, issuer still an owner, uses left) to one key, through the shared `cadreInviteStillOpen`. A seat count alone was not enough: the scenario's Q arm redeems a *withdrawn* invitation, and without the withdrawal check M would have pushed its whole control store to Q before refusing it. The runs confirm Q is sent nothing (`invitation … is not live here; … is not caught up before the write`). A retry of an admission that was already written, using a single-use invitation, also reads as not live and gets no push. It doesn't need one, because the device is already a member.

**CadreNode.** `admittingDevices: Map<peerId, count>` holds devices whose redemption has verified. The control backfill's `authorizePeer` admits them as it admits members. `catchUpRedeemingDevice` increments the count, awaits `controlBackfill.forceCatchUpPeer`, logs offered/accepted/rejected, and decrements in a `finally`. It uses a count rather than a set because a device's retry can overlap its first request still running on the member. With no control backfill (disabled by config), it logs and returns.

**PeerJoinBackfill.** `inFlight` is now `Map<peerId, Promise<result>>`. `catchUpPeer` keeps its contract: it returns an empty result when the peer is done or already in flight. The new `forceCatchUpPeer` waits out any in-flight run, then runs again **even when the peer is memoized done**. That second part goes beyond the ticket, which asked only for "run again when that run was denied". The reason: a `done` memo from an earlier clean run (say, a first redemption whose write then failed) can predate commits made since, and the device would then lack the base revision of the newer blocks. The cost is one extra whole-store push, 26 blocks taking about 65 ms on loopback, in the rare case where the in-flight run was itself authorized. The old `finally` (drop from in-flight, replay a deferred schedule) moved into `trackRun`. That function registers the run before its first await, so no second run can start beside it.

**Scenario.** `cadre-invite-any-member.integration.ts` now uses one member M. The "other member sees the rows by replication" check is gone, and the scenario pins `attempts === 1`. It also prints the owner's catch-up time (from reconnecting to M until A lists P), and the header's "Why this shape" is rewritten. `redeemWithRetry` is kept, and now logs each retryable attempt, so a regression shows the attempt count rather than failing at the first refusal.

**Docs.** In architecture → "Enrollment Flow: Invitation Redeemed at Any Member", the sequence diagram gains step 8 (the push), and a new paragraph, "The device holds the control store before its admission is written", states the constraint, the liveness gate and the tradeoff. The control gate's "What it admits anyway" paragraph names this push as the one push to a non-member.

## Validation run

- `yarn lint`: clean. `yarn workspace @serfab/cadre-core typecheck` and `yarn workspace @serfab/integration-tests typecheck`: clean.
- cadre-core unit suite: 153 files, 2380 passed, 1 skipped.
- `yarn workspace @serfab/integration-tests exec vitest run cadre-invite-any-member` (after `yarn workspace @serfab/cadre-core build`), 3 of 3 passed:

| run | owner left M's cohort | P admitted (attempt, ms after asking) | owner listed P after reconnecting to M |
| --- | --- | --- | --- |
| 1 | 5035 ms | 1, 520 ms | 1552 ms |
| 2 | 5036 ms | 1, 443 ms | 1545 ms |
| 3 | 5050 ms | 1, 442 ms | 1547 ms |

  In each run the push to P offered and accepted 26 blocks with 0 rejected. No trace had a `commit-not-durable`, `TornActionError` or `CoordinatorPartialCommitError` line. Traces: `tickets/.logs/redemption-write-tears.impl.run{1,2,3}.log`, which the runner prunes.

## Tests added

- `peer-join-backfill.spec.ts` → "forceCatchUpPeer waits out a run denied before the caller authorized the peer, then pushes": pins the in-flight race that `catchUpPeer` alone would lose (it answers empty while a denied `peer:identify` run is in flight). The integration scenario can't hit that race deliberately. One test, for the branch with real ordering logic. It does not test the `done`-bypass branch.
- No handler unit test: the change to the handler is call ordering, and the one-member scenario reproduces the bug with a real network.
- `cadre-invite-protocol.spec.ts`: one line, adding `isCadreInviteLive` to the `untouchable` fake store so it type-checks.

## Known gaps and observations for the reviewer

- **Relayed device not exercised.** The scenario's P reaches M over a direct loopback WebSocket. A phone usually redeems through a relay. db-p2p opens and registers every protocol stream with `runOnLimitedConnection: true`, so the push should run over a limited connection, but a third-party relay's data cap could cut it off. If the push fails, the write tears and is retried as before; no worse than today. Not measured.
- **Latency per redemption.** Every redemption at a live invitation now costs the liveness reads (4 control reads) plus one whole-store push before the write. On loopback admission went from about 410 ms (prototype) to 440–520 ms. The store is a party's membership (26 blocks here). Over a slow relay this adds to the device's per-address budget (28.5 s at the default declared link); not measured.
- **The owner's restart logs `Self-registration failed: ConcurrentModificationError` on `CadrePeer` in every run.** This happened in all three runs here and also in the prototype runs from the fix pass (`redemption-write-tears.lone.proto{1,2,3}.log`), so this change did not introduce it. A's startup self-record update loses a race with the replicated row. A's periodic record refresh (`startRecordRefresh`) re-publishes later, and the scenario passes. Not investigated; a reviewer may want to confirm it is the expected race on restart and not a symptom of the fork class.
- **Sibling ticket text is now stale in one place.** `tickets/implement/phone-owner-never-leaves-members-cohort.md` says to keep the second member N until this ticket lands, which is now satisfied: the scenario has no N. Its later paragraph also says this ticket "proposes answering `busy` while the cohort shrank". This ticket rejected that proposal (the cohort grew by the device; it did not shrink). I left that ticket untouched because it is another ticket's in-flight file.
- `forceCatchUpPeer`'s wait loop re-checks `inFlight` after every await. If debounce timers kept starting new runs it would keep waiting. In practice a timer that fires while a forced run is in flight returns empty, so this is bounded; it is noted only for review.
