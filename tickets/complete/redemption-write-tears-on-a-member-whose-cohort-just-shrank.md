description: A member that admits a device by invitation while the owner is offline now hands the device the party's control data before writing the admission, so the admission commits on the first try even when that member is the only one online, and the returning owner sees the device.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-invite-protocol.ts (`CadreInviteHandlerOptions.catchUpDevice`, `seatAndRedeem`, `catchUpDeviceIfLive`), packages/cadre-core/src/cadre-node.ts (`admittingDevices`, `catchUpRedeemingDevice`, `startControlBackfill`'s `authorizePeer`), packages/cadre-core/src/peer-join-backfill.ts (`forceCatchUpPeer`, `trackRun`, `settleRun`), packages/cadre-core/src/control-database.ts (`isCadreInviteLive`, `cadreInviteStillOpen`), packages/cadre-core/test/peer-join-backfill.spec.ts, packages/cadre-core/test/cadre-invite-protocol.spec.ts, packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, docs/architecture.md
----

# The member hands the device its control store before writing the admission

## What landed

A device that connects to a member to redeem a cadre invitation joins that member's control write cohort at once. With the owner offline and the member alone, the cohort was {member, device}; the device held no control blocks, refused the admission's revisions, and the write tore. The returning owner then forked onto a different `CadrePeer` history and never listed the device (the fork class is `tickets/blocked/forked-control-collection-sync-livelocks.md` → "Third trigger").

The fix, landed in `ticket(implement): redemption-write-tears-on-a-member-whose-cohort-just-shrank`:

- **Handler.** After the request verifies and the row is seated, `seatAndRedeem` calls `catchUpDeviceIfLive`, which pushes the member's control store to the device only when `ControlDatabase.isCadreInviteLive` says the invitation is still redeemable here (not withdrawn, unexpired, issuer still an owner, uses left), then writes. A failed check or push is logged and the write goes ahead. The accepted tradeoff (a device whose write then fails keeps a store it was not admitted to) is a `NOTE:` at the call site.
- **CadreNode.** `catchUpRedeemingDevice` admits the device at the control backfill's gate (`admittingDevices`, a per-peer count so overlapping retries are safe) for the length of a `PeerJoinBackfill.forceCatchUpPeer` push.
- **PeerJoinBackfill.** `forceCatchUpPeer` waits out a run already in flight for the peer (one that may have been denied a moment before the device was admitted), then pushes again even if the peer is memoized as caught up. `trackRun` registers each run before its first await.
- **Scenario.** `cadre-invite-any-member` runs with one member and pins admission on the first attempt.
- **Docs.** architecture → "Enrollment Flow: Invitation Redeemed at Any Member" states the constraint, the liveness gate and the tradeoff; the control connection gate's "What it admits anyway" names the push.

Validation after review: `yarn lint` clean; `yarn workspace @serfab/cadre-core typecheck` clean; cadre-core suite 153 files, 2380 passed, 1 skipped; `cadre-invite-any-member` passed (owner left M's cohort after 5040 ms, P admitted on attempt 1 in 424 ms, returning owner listed P 1553 ms after reconnecting).

## Review findings

**Checked, no defect found:**

- `forceCatchUpPeer` / `trackRun` ordering: `settleRun` cannot finish before `inFlight.set` (it awaits `runCatchUp` first), so no second run can start beside a tracked one. The wait loop is bounded: a new run for the peer can only start from a debounce or backoff timer, which is a no-op once the forced run memoizes the peer.
- Interaction with the rest of the backfill: after the admission commits, `refreshAuthorizedControlPeers` → `scheduleConnectedPeers` finds the device memoized and does not push again; a pending backoff timer fires into `catchUpPeer` and returns empty; the mid-run re-arm replay still lives in `trackRun`'s `finally`.
- Backfill disabled by config (`controlBackfill.enabled === false`): `controlBackfill` stays null and `catchUpRedeemingDevice` logs and returns, so the off switch holds.
- `isCadreInviteLive` against `redeemCadreInvite`: every refusal the write can make for a dead invitation (no row, withdrawn, expired, issuer not an owner, seats spent) reads as not live first, so no store goes to a holder that will be refused for those reasons. The remaining gap (a race taking the last seat between check and write) is the accepted tradeoff at the site.
- Handler error paths: a throw from the check or the push is logged with the peer id and the write proceeds; neither can escape into the stream handler.
- A retry by an already-admitted device on an unlimited-use invitation reads as live and gets a whole-store push before being answered as already a member. Cost only (the implement runs measured 26 blocks in about 65 ms on loopback), and the device is a member by then; not parked.
- The implementer's backfill test pins real ordering logic (denied in-flight run, then forced push) and stays. The one-line fake-store change in the handler spec is type-only.

**Found and fixed in this pass:**

- `docs/architecture.md` → "Whole-party breadth…" bullet still said control pushes go only to `isAuthorizedMember` peers. Added one sentence naming the redeeming device as the one exception, linking the enrollment section.
- `cadreInviteStillOpen`'s doc comment listed its sharers without the new `isCadreInviteLive`, the reason the helper exists (so they cannot drift). Updated.
- The liveness gate and the push-before-write ordering were unpinned: the scenario only logs that Q is sent nothing. Extended two existing tests in `cadre-invite-protocol.spec.ts` (no new `it`): the shared handler now records each push and whether the device's row existed at that moment; the end-to-end acceptance asserts exactly one push before the row was written, and the expired-invitation refusal asserts no push. This is the security-relevant half of the change (no control store to a holder of a dead invitation).
- `tickets/implement/phone-owner-never-leaves-members-cohort.md` was stale on two points this landing settled: it said to keep the second member N until this ticket lands (the scenario no longer has N), and it said this ticket proposes answering `busy` while the cohort shrank (rejected; that question now has no owner). Both sentences updated in place; that ticket is parked behind its blocked FRET prereq, so no run was editing it.

**Tripwires parked:**

- The owner's restart logs `Self-registration failed: ConcurrentModificationError` on its own `CadrePeer` row in every traced run, including the pre-fix lone-member runs (`redemption-write-tears.lone.run{2,4}.log`), so this change did not cause it. The record is republished at the next heartbeat. `NOTE:` at the catch in `CadreNode.scheduleSelfRegistration`: retry once if a restarted machine's changed addresses must publish sooner.

**Not measured, left as the implementer reported:**

- A device redeeming through a third-party relay: the push runs over a limited connection and a relay's data cap could cut it off. If it does, the write tears and the device retries as it did before this change. No relay scenario exists to measure it.
- Per-redemption latency over a slow link (four liveness reads plus one whole-store push before the write) against the device's 28.5 s per-address budget.

**Considered, no ticket filed:** nothing found met the filing bar. No major defect turned up, and the open questions above are conditional (relay caps, slow links), so they are recorded here rather than queued.
