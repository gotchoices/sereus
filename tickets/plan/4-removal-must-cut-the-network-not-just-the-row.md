----
description: Removing a party from a closed strand deletes a database row and nothing else. The removed party's nodes stay connected, stay dialable, stay in the cohort, and keep being served. Design the enforcement that makes removal mean what an app's "remove member" button claims.
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/strand-membership-writer.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/strand-member-registry.ts, packages/cadre-core/src/types.ts, schemas/strand.qsql, docs/strands.md
difficulty: hard
tradeoffs: a membership-aware gate on strand nodes trades the current "peers are legitimately cross-party" simplicity for a correct revocation boundary, and risks partitioning genuine members whose revocation view is stale
likelihood: certain
----

# Removal must cut the network, not just the row

Answers **gotchoices/sereus#4**, where an outside consumer building a chat app asked what removal
guarantees so they could write honest user-facing wording. They were hedging because they could not
tell. They were right to hedge.

## The ruling that unblocks this (owner, 2026-09-09)

> "removing a member should implicitly cause all cadre members for that member to no longer be
> answered to or communicated with by remaining members. Once this happens, I don't see any relevance
> to writing or anything like that, since no cadre nodes that remain should be even connecting to
> former members' cadre nodes."

This settles the design question the blocked ticket posed. Enforcement is at the **connection and
stream layer**, not the write-authorization layer. That is a strictly stronger and simpler position
than gating writes: if nobody talks to the removed party's nodes, the question of whether its key
still satisfies `Member.Authorized` stops mattering — which is what makes it the right answer, since
`feat-strand-party-identity` (backlog) records that every joiner is currently handed the *same*
`MemberPrivateKey`, so a key-based write gate cannot distinguish parties at all today.

## What is actually there now (measured 2026-09-09)

| question | answer |
| --- | --- |
| removal recorded? | yes — `Member` is insert+delete only, revoked via a `Revocation` tombstone (`schemas/strand.qsql:175-289`); `revokeMember()` at `strand-membership-writer.ts:862`, self-departure at `:915` |
| membership-aware connection gater on a strand node? | **no** — `strand-instance-manager.ts:447` passes `config.network?.connectionGater` straight through; `types.ts:295-309` documents this as deliberate ("their peers are legitimately cross-party") |
| per-stream authorization gate on a strand node? | **no** — nothing analogous to the control network's `authorizeInboundControlStream` |
| existing connections closed on removal? | no |
| new inbound connections refused? | no |
| dropped from the Optimystic cohort / peer set? | no |
| stop dialing them? | no |
| can we even identify their peers? | yes — `MemberPeer` binds `Member.Key` to `PeerId` (`schemas/strand.qsql:298-353`), read by `listMemberPeers()` (`strand-membership-writer.ts:1039`) |

The last row is the good news: the identity mapping needed to enforce this already exists. Note that
`MemberPeer` rows **survive revocation as orphans** — an existing test proves a manager must clean
them up by hand (`packages/integration-tests/src/scenarios/strand-membership-closed-strand-e2e.integration.ts:727-806`).
Enforcement that reads `MemberPeer` must therefore not assume its presence means "current member";
it must join against the live `Member` / `Revocation` state.

Existing tests cover *authorization to remove* (`packages/cadre-core/test/strand-member-revocation.spec.ts`)
and *database visibility* of removal. None covers enforcement, because there is none.

## The design to settle

1. **A membership-aware gate for strand nodes.** The control network's
   `membership-connection-gater.ts` is the model, and its own doc comment is the required reading:
   it separates a connection-level opportunistic deny from fail-closed per-stream gates, and it
   documents exactly why a relay-reservation checkpoint must not answer a membership question. Decide
   how much of that structure transfers. In particular the "self-healing" argument differs: on the
   control network a wrongly-denied member recovers via an outbound reconcile dial. Establish whether
   the same recovery exists on a strand node before adopting a connection-level deny.
2. **Open strands must keep working.** `Type='o'` strands admit strangers by design. A gate that
   reads "not in `Member` implies deny" breaks them. The policy has to be keyed on *revocation*, not
   on *absence of membership* — a removed party is a distinguishable state from a party that was
   never a member, and `Revocation` is exactly that record.
3. **Stale revocation views.** A member whose replica has not yet seen the revocation keeps serving
   the removed party; a member whose replica has not yet seen a *legitimate* member keeps refusing
   them. Both are real and they pull in opposite directions. Decide the failure direction
   deliberately and write down why.
4. **Active teardown, not just future refusal.** Refusing new connections does nothing to a peer that
   is already connected — and a long-lived strand connection may never re-dial. Removal must close
   what is open. Find the seam that can do that (a hook off the revocation write, or the strand
   watcher noticing the tombstone) and specify it.
5. **The Optimystic cohort.** A removed party's node sitting in the strand collection's cohort still
   participates in commits. Determine whether dropping it is (a) automatic once connections are cut,
   (b) a separate action against the cluster peer set, or (c) impossible without upstream support —
   and if (c), that arm goes to `blocked/` as a category (b) dependency, not into this ticket.
6. **`MemberPeer` orphan cleanup.** Enforcement makes the orphan rows load-bearing rather than
   cosmetic. Decide whether revocation should tombstone the peer bindings too, or whether the join
   against live membership is sufficient.
7. **Delegate admission.** `delegate-admission.ts` grants short-lived admission for a member's strand
   node peerId announced over the authenticated control channel. A revoked party must stop receiving
   grants, and outstanding grants must expire or be revoked — otherwise the grant path is a bypass of
   whatever gate lands.

## Explicitly out of scope

**Reading what they already have.** `docs/strands.md` is clear that revocation is forward-looking and
that rotating the read gate means re-forming the strand. The reporter explicitly is not asking for
that, and the owner's answer does not change it. Say so plainly in the docs; do not build it.

**Re-admission via a held invitation.** A removed party holding an unspent, unexpired, uncancelled
bearer invitation still re-admits itself — `docs/strands.md` states this outright, and `Invite`
carries no intended recipient (`schemas/strand.qsql`). Network enforcement does not close that hole:
the party rejoins legitimately and the gate then correctly admits it. Closing it properly is
`backlog/feat-strand-invitee-bound-invites`. Reference it; do not absorb it.

## Edge cases & interactions

- **Multi-machine removed party.** A removed party with several cadre nodes — every one of its strand
  peerIds must be cut, not just the one that happened to be connected.
- **Removal racing a join.** A party being removed while one of its machines is mid-admission.
- **Self-departure** (`leaveStrand()`, `:915`) — same enforcement, or deliberately not? A party that
  leaves voluntarily is not hostile, but the remaining members' behaviour should not silently differ.
- **A manager removing itself,** or the last manager being removed.
- **Relay-mediated connections.** If a removed party reaches a remaining member through a relay, the
  gate must still see it — the control gater's relay-reservation seam exists precisely because that
  checkpoint is unrecoverable when answered wrongly.
- **Both parties removed each other** concurrently, from divergent views.
- **The removed party's own view.** It does not know it was removed until it replicates the tombstone,
  and after enforcement it may never replicate again. Whether it is told, and how, is a product
  question worth naming even if the answer is "it is not".

## Tests this must produce

- A closed strand, two parties, one removed: the removed party's strand node can no longer read or
  write the strand collection, and the remaining member holds no connection to it.
- The same with the removed party on two machines.
- An open strand: a stranger still connects and participates after an unrelated removal — the
  enforcement did not break the open case.
- A remaining member with a stale revocation view: whichever failure direction was chosen in (3),
  assert it deliberately.
- An already-open connection torn down, not merely future dials refused.

## TODO

- [ ] Read `membership-connection-gater.ts`'s doc comment in full; decide what transfers to strand
      nodes and what does not, and say why in the implement ticket.
- [ ] Settle the open-strand policy (revocation-keyed, not membership-keyed).
- [ ] Settle the stale-view failure direction.
- [ ] Specify the teardown seam for already-open connections.
- [ ] Determine whether cohort eviction is reachable from here or is an upstream dependency.
- [ ] Decide `MemberPeer` tombstoning vs. live-membership join.
- [ ] Close the `delegate-admission.ts` grant path against revoked parties.
- [ ] Split into `prereq:`-chained implement tickets — the gate, the teardown, and the cohort arm are
      separate changes and one of them may not be ours.
- [ ] Update `docs/strands.md` with what removal now guarantees, and what it still does not
      (past reads; re-admission by held invitation).
