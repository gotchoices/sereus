description: Remember a join that could not reach the inviter, in the invitee's own control database, and retry it from any of the party's machines until it succeeds or the invitation is spent or expired; let an app show its status.
files: schemas/control.qsql (JoinedStrand ~370), packages/cadre-core/src/cadre-node.ts (formStrand ~8066, createOpenInvitation ~8037, initializeStrandSolicitation ~7981, issueStrandMembershipInvite ~8244), packages/cadre-core/src/strand-formation-manager.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-cli, packages/cadre-host
----
# Durable pending join (gotchoices/sereus#25)

## The gap

`formStrand` is one live handshake with the inviter. If the inviter is offline, it fails at once and nothing in the invitee's party records the attempt. The join completes only if someone calls `formStrand` again while the inviter is online. kjeib's repro (relay-only, persisted storage, 1.8.0 with optimystic 1.8.1) shows that the invitation stays valid and that a manual retry succeeds in under a second.

## Requested shape (from the issue; a reasonable starting point)

- **A pending-join row in the invitee's control database**, written when a formation is attempted.
  - It holds the invitation, the disclosure and a status.
  - The invitation is a bearer credential. Storing it carries the same accepted risk as `JoinedStrand.MemberPrivateKey`.
  - The row is party-wide and owner-signed like `JoinedStrand`, so every machine of the party sees it.
- **Retries from any machine of the party**, paced from `network.linkRoundTripMs`, until the join succeeds or the invitation expires. On success `JoinedStrand` replaces the row; other machines already pick that up.
- **Temporary and permanent failures handled differently.**
  - Keep retrying when the inviter is unreachable, the attempt times out, or the reason is `MEMBERSHIP_INVITE_UNAVAILABLE_REASON`.
  - Stop and report the reason when the invitation is spent or expired, the approval hook refuses, or the reason is `HOST_STRAND_MUST_BE_RECREATED_REASON`.
  - Today a rejection reaches the joiner only as a free-text `reason`, so this split needs a typed code on the wire.
- **A status an app can read and subscribe to**: pending, trying, waiting for the inviter, then joined or failed with a reason.

## The inviter side (the issue's "related question")

Today no other machine of the inviter's party can answer the formation, for three reasons:

1. **The invitation carries only the minting machine's addresses.** `createOpenInvitation` uses `this.getMultiaddrs()`, so the joiner never learns of any other machine in the party.
2. **cadre-cli and cadre-host never install the formation responder.** `initializeStrandSolicitation` is called only by an embedder, or lazily by `createOpenInvitation` and `formStrand`. An always-on node therefore has no handler.
3. **A closed host strand needs a live runtime on the responder.** `issueStrandMembershipInvite` wakes the strand and needs `StrandPartyKey`.

The third is already met on an always-on node that hosts the party's strands (`hostUnclaimedStrands`, the default for the storage profile). `FormationInvite` and `FormationUsage` already replicate party-wide, so the responder's checks would pass there too. Fixing 1 and 2 therefore lets an always-on machine answer for the inviter. Together with the pending join, the two phones would never need to be online at the same time.

## Maintainer direction (2026-09-30)

> "In an ideal world, your entire cadre would enter a 'trying...' mode, so even if you exit the app on the phone, your other nodes can try on your behalf."

So the pending join is a fact about the party, not the device. Each always-on machine of the invitee's party retries it on its own. The phone only records the attempt and shows the status.

**Consequence for consent.** `FormationUsage.PeerKey` and `PeerSig` name the machine that dials, not the phone. A machine that retries therefore signs its own consent over the disclosure the phone recorded. The strand membership still goes to the party (`memberKey` is the party id), so it doesn't matter which machine completes the join.

**Consequence for "spent".** If two machines race and one wins, the loser sees the token as spent. Before treating "spent" as a permanent failure, a machine must check its own party's `JoinedStrand` for that strand. If the strand is there, the join succeeded and the pending row is closed.

## Open questions for planning

- **Source of other machines' addresses.** Should an invitation take them from `CadrePeer` rows, from live connections, or from both? They go stale; the joiner's retries make that tolerable.
- **Retries from two of the invitee's machines at once.** Each machine mints its own `UsageStampId` and signs its own consent, so they can't share one redemption. Under `TotalUses = 1` the inviter admits only the first, and the second sees "spent" (handled above). For an invitation with no use limit, both could redeem it. That wastes a use but does no harm, because the membership is the party's. Decide whether to stagger retries by machine to make this rare.
- **Ticket split.** (a) Install the responder on always-on nodes and put the party's addresses in invitations. (b) Add the pending-join row, the retry loop, typed failure codes and the status API.
