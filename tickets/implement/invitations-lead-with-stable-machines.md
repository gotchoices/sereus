description: An invitation minted on a phone lists the phone's own address first, so a person redeeming it after the phone sleeps waits on a dead address before trying the party's always-on machines. Invitations should lead with the party's most reliably reachable machines and name the phone first only when it is the party's only machine.
architecture: docs/strands/formation.md#which-machines-an-invitation-names
files: packages/cadre-core/src/invitation-bootstrap.ts, packages/cadre-core/src/cadre-node.ts (createOpenInvitation, siblingInvitationAddrs, resolveInvitationSiblings, resolvePeerRecord, selectInvitationMembers, resolveInviteAddresses, issuedBundleParts), packages/cadre-core/src/strand-fret-addrs.ts (structural FRET access to copy), packages/cadre-core/src/node-class.ts (decodeAlwaysOn), packages/cadre-core/src/control-database.ts (peerAddressRecordOf carries `profile`), packages/cadre-core/src/node-claim-payload.ts (classifyDialAddress), packages/cadre-core/test/invitation-bootstrap.spec.ts (if present), docs/strands/formation.md, docs/cadre/membership.md, docs/cadre/owner-keys.md, docs/network/relay.md, docs/cadre/apps.md
----
# Invitations lead with the party's stable machines

## The problem

Two kinds of invitation name addresses of the inviting party's machines for the redeemer to dial in order:

- **Cadre invitation** (`createCadreInvitation`, and the owner grant, which shares the member selection through `issuedBundleParts` → `selectInvitationMembers`). `selectCadreInvitationMembers` in `invitation-bootstrap.ts` puts the minting machine's own addresses first (up to 4), then 2 each of up to 3 other machines, cut to 6 in total.
- **Open strand invitation** (`createOpenInvitation`). Its bootstrap list is `[...this.getMultiaddrs(), ...siblingInvitationAddrs()]`, so the minting machine comes first here too, then up to 3 other machines with 4 addresses each.

Other machines are ordered only by "this node is connected to it now", then by the newest signed `CadrePeer` record. Nothing looks at whether a machine is always on or how long it has stayed up.

In the main app flow the minting machine is a phone, and the phone is closed or in the background by the time the invitation is redeemed (`docs/cadre/apps.md` → "Whether another machine could redeem it"). The redeemer dials the list in order, and a dead relayed address costs about one relayed dial budget (around 21–23 s at the default link) before the next machine is tried. The party usually has an always-on machine (a cadre-host node, a drone, a provider container) that could have answered at once.

Seeds and node claims were checked and are left alone: there the minting machine is connected to the receiver while it delivers the seed, and the seed's preferred peers already include every always-on machine.

## What to build

Rank every candidate machine, the minting machine included, by evidence that it will still be reachable when the invitation is redeemed, and fill the address caps in that order.

### Evidence per machine

For each other member whose signed record resolves (the existing gates in `resolvePeerRecord`: key binding, signature, 15-minute freshness, trust policy):

- **Always on.** The machine's own signed declaration, `decodeAlwaysOn(record.profile) === true`. `resolvePeerRecord` already reads the record; return the decoded flag beside `addrs` and `updatedAt`. A row that has not published a profile (`null`) counts as not always on.
- **Reachability now.** From the control node's current connections to that peer:
  - `2`, it accepts incoming connections: this node holds a connection it opened (`direction === 'outbound'`) that is not relayed (the remote address has no `/p2p-circuit`, and the connection has no `limits`). A WebRTC connection does not count: ICE may have punched a hole, which does not show the machine accepts a plain dial.
  - `1`: connected in any other way.
  - `0`: not connected.
- **Tenure.** How long this node has itself watched the machine stay up, from the control node's FRET service: `services.fret.getPeerTenure(peerId)` (FRET 1.3.0, installed through `@optimystic/db-p2p`). Treat `undefined`, or a node with no FRET service, as `0`. Read it through a structural type the way `strand-fret-addrs.ts` reads `exportTable`, and add the helper there, beside `strandFretMembership`. The module reads any libp2p node's FRET service, and only its name is specific to strands. Tenure is never gossiped, so another machine cannot inflate it.
- **Record age**, `updatedAt`, as today.

Sort other machines lexicographically: always on first, then reachability (higher first), then tenure (longer first), then newest record. A live connection outranks tenure because tenure stops growing while a peer is silent, and a disconnected machine with an hour of past tenure is weaker evidence than one connected now.

### Where the minting machine goes

The minting machine knows its own class (`this.roles.alwaysOn`).

- **Minting machine is always on:** it stays first with up to 4 addresses (cadre) or all its addresses (open). This is today's behaviour, and it holds because the machine is up now and stays up.
- **Minting machine is a device** (a phone, a laptop, a browser):
  - When at least one other machine is named and that machine is always on, the device goes after every always-on machine and before any other device. It contributes only its best single address (`rankForPhone` order, which puts its relayed address first), and that slot is reserved inside the cadre cap of 6. So with three always-on siblings the cadre invitation names 2 + 2 + 1 of theirs and 1 of the phone's, not 2 + 2 + 2.
  - When the other named machines are all devices, the minting device goes first among them. It is the one machine the person handing out the invitation can keep open, and nothing is known about the others' sleep.
  - When no other machine resolves, the minting device is the only peer and is named first with its normal allowance. This is the case the user called out: the phone must still be in the invitation when it is the party's only machine.

### Open strand invitation

Apply the same machine order and the same rule for the minting machine to `createOpenInvitation`, keeping its existing caps (3 other machines, 4 addresses each). Its own addresses keep their record order inside the machine (relayed first), as the NOTE on `INVITATION_SIBLING_MACHINES` describes.

The minting machine was put first because it is the most likely to run the host strand. An always-on machine runs every strand its party takes part in (`docs/concepts.md`, "always-on node"), so it can answer the formation too. A device sibling may not run the strand, and the device rule above already puts the minting device ahead of other devices.

### Shape

Keep the selection pure and in `invitation-bootstrap.ts`. `InvitationSibling` gains `alwaysOn`, `reachability` and `tenureMs`. `connected` stops being a separate set, because reachability carries it. Add a self descriptor (`{ addrs, alwaysOn }`) so one function decides where the minting machine goes for both invitation kinds. `selectCadreInvitationMembers` and the open invitation's selection then differ only in their caps. `cadre-node.ts` only gathers evidence: `resolveInvitationSiblings` builds the richer sibling list, and the two callers pass their own descriptor. `cadreInvitationReach` is unchanged, because it already judges only the machines other than the issuer.

Remove the now-false parts of the NOTE comments on `selectCadreInvitationMembers` about machine order ("the minting one, then siblings by how likely each is to be up"). The per-machine ranking tradeoff they record still stands, so state it against the new order.

## Edge cases & interactions

- **Phone is the party's only machine.** Siblings are empty: the invitation names the phone first with up to 4 addresses (cadre) or all of them (open). `reach` stays `issuer-only`. Verify by a unit test of the pure selection.
- **Phone plus always-on siblings.** The always-on machines come first, the phone's single best address comes last, and the cadre total is at most 6. Verify by a unit test (this branch is the reason for the ticket).
- **Phone plus only device siblings.** The phone comes first. Verify by a unit test.
- **Always-on minting machine.** The output is unchanged from today apart from sibling order. Covered by the existing tests of `selectCadreInvitationMembers`. Update them where the sibling order changes, and do not add new ones.
- **Sibling declares always on but is down.** Its record is still fresh (under 15 minutes) and it sorts first, so the redeemer pays one dial budget on it. That is accepted: the declaration is self-declared and unchecked, as `projectSeedPeers` already accepts. Reachability and tenure only break ties within the always-on group. State this in the `## Limits and accepted tradeoffs` of `docs/strands/formation.md`.
- **Sibling with no FRET entry, or a control node built without FRET** (test doubles, partial libp2p handles): tenure is 0 and nothing throws. Verify by inspection: the structural guard returns 0.
- **`getPeerTenure` throws** (the node is mid-teardown). It runs inside `resolveInvitationSiblings`'s existing try/catch, which falls back to naming the minting machine alone and logs. Check that this still holds, and that a throw is logged rather than swallowed.
- **Device minting machine with no address of its own** (relay down). The siblings fill the list and nothing is reserved for the phone. Today's guarantee ("A phone whose relay is down can still mint an invitation that names an always-on machine") must hold. Verify by a unit test, or by folding it into the phone-plus-always-on test with empty own addresses.
- **Neither the minting machine nor any sibling has an address.** Both callers still throw, as today.
- **Owner grant.** It shares `selectInvitationMembers`, so it inherits the new order. Update `docs/cadre/owner-keys.md`, which says "with the issuer's first".
- **`invitationReach()` and `createCadreInvitation` agree.** Both go through `selectInvitationMembers`. Keep it that way.
- **Connection direction on relayed or limited connections.** A relayed connection this node opened is reachability 1, not 2. Verify by inspection of the predicate. A test is not worth it unless the predicate branches beyond those three checks.

## Docs

- `docs/strands/formation.md` → "What the inviter puts in the list": replace the "minting machine first" and "Order" bullets with the new order and the rule for the minting machine, and add the always-on misdeclaration tradeoff to its limits.
- `docs/cadre/membership.md` → "The bundle": the "issuer's own first" sentences.
- `docs/cadre/owner-keys.md`: the `members` bullet.
- `docs/network/relay.md`: the limit "A cadre invitation ranks addresses per machine, not across the whole bundle" names the old machine order. Restate it against the new one.
- `docs/cadre/apps.md` → "Whether another machine could redeem it": check that it still reads true. `reach` semantics do not change.
- Keep within the doc size gate (`yarn check:docs`).

## TODO

- Extend `resolvePeerRecord` to return the decoded always-on flag, and update its callers.
- Add a FRET tenure reader beside `strandFretMembership` in `strand-fret-addrs.ts`.
- In `resolveInvitationSiblings`, gather always-on, reachability (from `controlNode.getConnections()`) and tenure for each sibling.
- Rework `invitation-bootstrap.ts`: the sibling ranking, the placement of the minting machine, and caps per invitation kind. Route `createOpenInvitation` and `selectInvitationMembers` through it.
- Update the NOTE comments in `invitation-bootstrap.ts` to the new order.
- Write unit tests of the pure selection for the three device-minter branches above, and adjust the existing ones for the new sibling order.
- Update the docs listed above.
- Run `yarn build`, then `yarn lint` and the cadre-core tests, and the integration scenarios that assert on `invitation.members` order (`cadre-invite-row-unreplicated`, `enrollment-e2e`, `cadre-invite-any-member`, `cadre-host-join-by-invitation`).
