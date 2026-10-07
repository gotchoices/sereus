description: A new device holding a cadre invitation is refused at the door by any member machine that has not yet received that invitation's record, even though the invitation itself carries the record. Decide whether such a member should let the device in anyway, or whether joining at a member simply waits until the record has reached it.
architecture: docs/architecture.md#enrollment-flow-invitation-redeemed-at-any-member
files: packages/cadre-core/src/cadre-node.ts (admitInboundControlConnection check 6, createCadreInvitation), packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/cadre-invite-protocol.ts (CadreInviteHandler.seatAndRedeem, seatCadreInvite), docs/architecture.md
repro: static
----

**Blocked category:** the planning spec contradicts itself. **What unblocks it:** a human picks one of the three options below (the first is the recommended default and is what the code and docs now say).

## The contradiction

The plan ticket `cadre-invitations-redeemable-by-any-member` said two things that cannot both hold:

- The connection gate admits an unknown device only while the member machine itself holds a live invitation record (the same rule as for open strand invitations).
- A member that has not yet received the invitation record should still answer the device, with a retryable "unknown" so the device tries the next machine.

The implement ticket `cadre-invite-redemption-protocol` went further than the second point: the invitation bundle now carries the owner-signed record, so a member that does not hold it can seat it from the bundle and redeem. But the gate decides before any protocol runs, and it has no way to see what a connecting stranger is carrying. So at a member that is already enrolled (it has at least one vouched member) and holds no live invitation record, the device's connection is refused, its dial of that member fails, and it moves on to the next address. If every named member is in that state, the device ends with a retryable "could not be redeemed at any address" error and has to try again later.

Found in review of `cadre-invite-redemption-protocol` by reading `admitInboundControlConnection` against `CadreInviteHandler`; not reproduced on a live network. The reproduction would be a three-node test: an owner, a member vouched by the owner that has not received the invitation record, and a device dialing that member.

## When it matters

Only when the owner mints the invitation while its machine cannot reach the other members (a phone with no connection) and the device tries to join before the owner reconnects. When the owner mints while connected, the record replicates to the members, and from then on each of them admits strangers until the invitation is spent, withdrawn or expired, so the designed flow (owner mints, goes offline, device joins at a member) works. The follow-on ticket's scenario waits for the member to hold the record before the owner goes offline, so it is unaffected.

The seat-from-bundle code is not dead: it serves a member whose gate is open for another reason, that is, a member with no vouched member yet, or one holding a different live invitation.

## Options

**A. Accept the limit (recommended default, already applied).** Joining at a member needs the record to have reached that member. The method doc of `createCadreInvitation`, the gate's check 7 and the architecture section now say so. Nothing else changes. Cost: an invitation minted while the owner is alone is not redeemable at other members until the owner has been online once since minting; the device sees a retryable failure and can retry. Reversible at any time by picking B or C.

**B. Let every node admit a stranger's connection and rely on the per-stream and read-time checks.** The architecture already calls the connection gate defense in depth and names the per-stream gates and the read-time voucher check as the layers that actually fail closed. Dropping stranger denial at the connection level would make the bundle-carried record work everywhere. Rejected for now: the gate exists so a known outsider is never in the conversation with the control protocols, and the ticket `bug-party-run-relay-drops-a-stranger-dialing-through-it` shows the stranger-admission rules are already delicate. This is a security posture change and should be a deliberate human decision, not a side effect of an invitation feature.

**C. Have the device prove its invitation before the gate decides.** Not possible with libp2p's connection gater, which runs after the encrypted handshake and before any protocol is negotiated; the only input is the peer id. Rejected as not implementable without a different gating layer.

## If we do nothing

Option A stands. The docs describe the real behaviour, the device fails retryably rather than silently, and the follow-on scenario passes. The only loss is the "minted while alone, redeemed before the owner reconnects" case, which no ticket currently depends on.
