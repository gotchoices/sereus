description: A machine that is not a cadre member, but holds a connection to one, can get that member to count it as part of the party's control network, and so to send it the party's control-database writes. This happens because the member decides who belongs from the protocols a peer appears to serve, which any connected peer can claim.
architecture: docs/architecture.md#per-stream-protocol-guard
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts (`servesThisNetwork`, `membershipOf`, the `findCluster` membership filter; read-only sibling), ../Fret/packages/fret/src/service/fret-service.ts (`classifyByProtocols`, the `peer:identify` and `peer:update` listeners; read-only sibling), libp2p 3.3.11 `dist/src/connection.js` (`onIncomingStream`, the `peerStore.merge` before `getHandler`), packages/cadre-core/src/cadre-node.ts (`authorizeInboundControlStream`, `buildControlNodeOptions`, `refreshMembershipGate`), packages/cadre-core/src/control-protocol-guard.ts, packages/integration-tests/src/scenarios/control-stream-authz.integration.ts (the NOTE in step 5)
repro: verified
----
**Blocked: dependency outside this repo.** Unblocks when Optimystic (and FRET, through it) accepts a membership predicate for the control network's ring and cohort, or a human chooses the Sereus-side workaround below instead.

## What happens

On a control node, two libraries decide which peers belong to the party's network, and both decide it from the protocols libp2p's peer store says the peer serves:

- FRET, the peer-discovery ring, marks a peer a ring member when its peer-store protocols include any of the party's FRET protocols (`classifyByProtocols`, run on `peer:identify` and every `peer:update`).
- Optimystic's key network, which picks the cohort a control block is written to, keeps a candidate when its protocols include the party's `cluster` or `repo` protocol (`servesThisNetwork`).

A peer can put those protocols into the member's peer store in two ways, neither of which the control-protocol guard can stop:

- **Opening a stream.** libp2p records the protocol of every negotiated inbound stream as one the remote peer serves (`peerStore.merge` in `onIncomingStream`), before it looks up the handler. The guard runs at that lookup and resets the stream, but the record is already written.
- **Advertising.** A peer can register the party's protocol ids on its own node, and identify announces them.

So any peer holding a control connection to a member can become a FRET ring member and a cohort member on that member. The member then routes its control-database writes for those blocks through it (cluster requests carry the block contents) and counts it toward the cohort.

## Evidence

Measured 2026-10-07 in `control-stream-authz.integration.ts`, step 5, with temporary logging (since removed). Before the probe, owner A's peer store already listed outsider O as serving `/optimystic/control-<party>/repo/1.0.0`, from step 2's raw pend, which A refused. FRET still had O as `foreign`. O then opened one stream on each members-only protocol A serves, and A's guard reset every one. Afterwards:

- A's peer store listed O as serving all nine probed party protocols;
- A's FRET table had O as `member`;
- `keyNetwork.findCluster` on A, for a control block key, returned `[O, M, A]`, O being the outsider.

**Not observed:** A actually sending a cluster request to O. That follows from the cohort, but confirming it needs O to register a handler for A's `cluster` protocol id and count the streams it receives after A's next control write.

## When a stranger can hold the connection

- Today: while the member holds a live cadre invitation or an open formation invitation; on a relay-enabled member, for the 5.5 s relay-only window, or for as long as it holds an admitted relay reservation; and any delegate (a member's strand node).
- After `stranger-connections-admitted-provisionally`: on every enrolled member, at any time, for about 28.5 s per connection.

Closing the connection afterwards does not undo it. An address-less peer that disconnects stays a live FRET member (`fret-evicts-an-address-less-peer-that-disconnects`), so the stranger can stay in the cohort with no way to reach it.

## Proposed mechanism (recommended default)

Optimystic's `NodeOptions` gains a synchronous predicate for network membership, for example `isNetworkMember?(peerId: string): boolean`. It applies to both decisions:

- FRET classifies a peer that fails it as `foreign`, whatever protocols the peer lists.
- The key network's `membershipOf` treats it as not serving.

On the control node, Sereus passes the snapshot behind `authorizeInboundControlStream`, minus the protocol argument. Admitting a new member must also reclassify it: `refreshMembershipGate` already runs on every membership change and would call a FRET or Optimystic "reclassify this peer" hook for each peer whose answer changed. Strand nodes pass nothing, since their peers are legitimately cross-party.

## Alternatives considered

- **Sereus-only: filter the control node's peer-store writes.** Wrap `peerStore.merge`, `patch` and `save` to drop `/optimystic/control-<party>/…` protocols from the records of peers outside the snapshot. Rejected as the default: a genuine member whose row replicates after it connected would stay recorded as not serving until it reconnects or re-identifies, which drops real members from the cohort. It also rewrites another library's state behind its back. It is the fallback if Optimystic will not take a hook.
- **Refuse strangers' connections again.** Rejected: the maintainer chose to admit them (option B, plan ticket `cadre-invite-redeemable-before-the-row-replicates`), and invitation redemption needs them.

## If nothing is done

A peer that is not a cadre member, connected to a member, can receive that member's control-database writes and take part in its cohort. The control database holds the party's membership, addresses and strand list, so this is a disclosure path to strangers. A stranger that stays in the cohort after disconnecting also costs every control write a dead cohort member. The exposure grows once `stranger-connections-admitted-provisionally` lands.

## Reversibility

The predicate is an additive, optional upstream option, and Sereus wiring it is one call site. Either is easy to revert.
