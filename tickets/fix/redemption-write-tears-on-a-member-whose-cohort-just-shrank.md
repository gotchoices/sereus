description: When the only always-on member of a cadre admits a new device right after the owner went offline, the member can save the "invitation used" record while failing to save the device's membership, leaving the invitation spent and the device half admitted; the owner that comes back then never sees the device as a member. Two always-on members do not show this.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-invite-protocol.ts (`CadreInviteHandler`, the `conflict` and `internal` answers), packages/cadre-core/src/control-database.ts (`redeemCadreInvite`: one transaction over `CadrePeer`, `OwnerKey`, `CadreInviteUsage`), packages/cadre-core/src/cadre-node.ts (`redeemCadreInvitation`: one `usageStampId` per call), packages/integration-tests/src/scenarios/cadre-invite-any-member.integration.ts, tickets/blocked/strand-half-committed-join-recovery.md (the strand analogue of the same optimystic property)
repro: verified
difficulty: hard
----

# A lone member's redemption write tears right after the owner leaves

## What was observed

Measured once on 2026-10-07 while writing `cadre-invite-any-member.integration.ts` (the implement pass of `cadre-invitations-redeemable-by-any-member`), in the shape with owner A listening on a loopback WebSocket port and ONE always-on member M. A stops; about 5 s later M's cohort no longer names A; device P then redeems an untargeted owner-granting invitation at M. With `DEBUG=sereus:cadre:invite-proto` the handler on M logged:

```
redeeming invitation <key> for <P> failed: CoordinatorPartialCommitError: Multi-collection commit was not atomic: 2 collection(s) durably committed via distributed consensus before the commit failed and CANNOT be rolled back — reconciliation is required. Committed (durable, now out of sync with the failed collections): [default/cadrecontrol/CadreInviteUsage, default/cadrecontrol/CadreInviteUsage/index/CadreInviteUsageByInvite]. Failed (never committed; local state reverted for retry): [default/cadrecontrol/CadrePeer, default/cadrecontrol/CadrePeer/index/_uniq_7.stampid, default/cadrecontrol/OwnerKey, default/cadrecontrol/OwnerKey/index/_uniq_7.stampid]. Underlying failure: collection default/cadrecontrol/CadrePeer: action <tx> is torn at rev 6 — its log entry is stored but block(s) <id> are not known to hold it, and the write cannot be finished
```

M answered P with the retryable `internal` refusal; P's second attempt (a fresh `redeemCadreInvitation` call, so a fresh `usageStampId`), 22 s after the first, was accepted, and M then listed P as an authorized member and held P's `OwnerKey` row. A restarted over its kept storage, reconnected to M, and did NOT list P as an authorized member within 60 s, although in the two-member shape it does so within seconds. Log: `tickets/.logs/cadre-invitations-redeemable-by-any-member.any-member.log` from that run is overwritten; the handler line above is the whole of what it showed, and the scenario's header records the finding.

With a second always-on member N present (the committed scenario), the same write committed cleanly in 3 of 3 consecutive runs, P admitted on its first attempt each time.

## Why it matters

The redemption is one transaction over three tables by design: `CadreInviteUsage` is what spends a use and what the `CadrePeer` and `OwnerKey` consent branches require in the same transaction. Optimystic commits each collection separately and documents partial visibility as a permanent property of its distributed commits (the blocked ticket `strand-half-committed-join-recovery` quotes it for the strand join, which has the same two-table shape). Here the usage row landed and the membership rows did not, so:

- the invitation's use is spent on a device that is not a member, and a second attempt by that device with a fresh stamp writes a second usage row (how M came to admit P on the retry is not fully traced: the first usage row should have counted against `totalUses: 1`);
- the torn `CadrePeer` action may be what kept the returning owner from syncing the collection, since A never saw P's row.

Every other control write a member makes while alone is exposed the same way, but this one is the feature's whole point: the owner is offline by design when it runs.

## What the fix stage should settle

- Trace the retry path: how `redeemCadreInvite` admitted P on the second attempt with a usage row already spent, and whether the admitted state is one every reader (`verifyInvitationAdmission`) accepts.
- Trace why the restarted owner never listed P: a torn action on `CadrePeer` at the member, or a replication gap after it. The ledger `tickets/.pre-existing-known.md` says a `CoordinatorPartialCommitError` on a join is to be reported to optimystic as a regression of its half-commit fix; check whether this instance is that class (the member alone, `durableHolders: 1`) before filing upstream.
- Whether the redemption should refuse to run while the member's cohort is smaller than its replication breadth or has shrunk within the last commit budget, answering `busy` (retryable) instead of tearing, which is a member-side rule with no upstream change.

## How to reproduce

In `cadre-invite-any-member.integration.ts`, keep A listening (as committed) and start one member instead of two (`members.push(await startMember(aOwnerKey))` once); run with `DEBUG=sereus:cadre:invite-proto`. Seen once; run several times before concluding anything about its rate.
