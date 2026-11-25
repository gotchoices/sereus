description: Invitations now list the party's most reliably reachable machines first, so a person redeeming an invitation minted on a phone that has since gone to sleep reaches an always-on machine at once instead of waiting on the phone's dead address. The phone is still named, and comes first when it is the party's only machine or every other machine is also a device.
architecture: docs/strands/formation.md#which-machines-an-invitation-names
files: packages/cadre-core/src/invitation-bootstrap.ts, packages/cadre-core/src/cadre-node.ts (resolvePeerRecord, selectInvitationMembers, createOpenInvitation, invitationSelf, resolveInvitationSiblings), packages/cadre-core/src/strand-fret-addrs.ts (fretPeerTenureMs), packages/cadre-core/src/index.ts, packages/cadre-core/src/cadre-invite-protocol.ts, packages/cadre-core/src/owner-grant-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/test/invitation-bootstrap.spec.ts, packages/integration-tests/src/scenarios/cadre-invite-row-unreplicated.integration.ts, docs/strands/formation.md, docs/cadre/membership.md, docs/cadre/owner-keys.md, docs/network/relay.md
----
# Review: invitations lead with the party's stable machines

## What was built

Both invitation kinds now share one pure selection in `invitation-bootstrap.ts` (`selectInvitationAddrs`) and differ only in their caps:

- `selectCadreInvitationMembers(self, siblings)`: the cadre invitation and the owner grant (through `CadreNode.selectInvitationMembers`, which `invitationReach()` also uses). Own allowance 4, 2 per sibling, 6 in total, each machine's addresses ranked by `rankForPhone`.
- `selectOpenInvitationBootstrap(self, siblings)`: `createOpenInvitation`. Own allowance unlimited, 4 per sibling, no total cap, each machine's addresses kept in the order the caller holds them.

**Sibling order** (`compareSiblings`): declares always on → reachability (2/1/0) → FRET tenure → newest record. At most 3 siblings are named.

**Minting machine** (`InvitationSelf = { addrs, alwaysOn }`, `alwaysOn` from `NodeRoles.alwaysOn`):

- Always on, or no always-on sibling named: first, with its full allowance (today's behaviour).
- Device with at least one always-on sibling named: placed after the always-on siblings' addresses and before any device sibling's, with one address (`rankForPhone(own)[0]`). That slot is held inside the total cap. With empty own addresses, nothing is held.

**Evidence** is gathered in `CadreNode.resolveInvitationSiblings`, which now returns `InvitationSibling[]` (the separate `connected` set is gone):

- `alwaysOn` comes from `resolvePeerRecord`, which now also returns `decodeAlwaysOn(record.profile) === true`.
- `reachability` comes from `invitationReachability(connections)` (pure, in `invitation-bootstrap.ts`). It returns 2 when some connection is `outbound`, has no `limits`, and `addrKind(remoteAddr) === 'direct'`. A WebRTC connection's dialer-side `remoteAddr` is the dialled `/p2p-circuit/webrtc` address, which reads as `webrtc`; I checked this in `@libp2p/webrtc`'s `initiate-connection.js`. Otherwise it returns 1 when connected, else 0.
- `tenureMs` comes from `fretPeerTenureMs(controlNode, peerId)` in `strand-fret-addrs.ts`, through a structural guard. It returns 0 when there is no FRET service or no entry.
- Connections and tenure are read once, after every record has resolved. Any throw (including `getPeerTenure`) lands in the existing try/catch, which logs it and names the minting machine alone.

`selectInvitationSiblingAddrs` and `CadreNode.siblingInvitationAddrs` are removed. `index.ts` now also exports the `InvitationSelf`, `InvitationSibling` and `InvitationReachability` types, because the public `selectCadreInvitationMembers` takes them. This is a breaking signature change, which the no-backwards-compat rule allows.

## Tests

In `packages/cadre-core/test/invitation-bootstrap.spec.ts`:

- The 3 existing `selectCadreInvitationMembers` tests were moved to the new signature with an always-on minter, so their expected output is unchanged.
- Added: "names a phone that is its party's only machine first, with its usual four addresses". Covers the phone-only branch, including `reach` = `issuer-only`.
- Added: "names a phone behind its party's always-on machines and ahead of its other devices, with one address held inside the cap". Two always-on siblings plus one device sibling give `A A B B phone laptop`. The device sibling is cut to 1 because of the held slot. The same siblings with empty own addresses give `A A B B laptop laptop`, which covers the "relay down" guarantee.
- Added: "names a phone first when every other machine named is a device too". Covers the all-device branch.
- Added: "ranks the other machines by always on, then reachability now, then tenure, then the newest record". This one was **not** in the ticket's test list. It pins the lexicographic order, the core of the spec, through `selectOpenInvitationBootstrap`. Reviewer: keep or cut.

No test for `invitationReachability` (the ticket said inspection suffices for three checks) or for `fretPeerTenureMs` (structural guard, verified by inspection).

Integration: `cadre-invite-row-unreplicated` asserted the device minter A's address first. M there is server-class, so the assertion now expects M first and exactly A's one best address. It passes.

## Validation run

- `yarn lint`: passes, including `check-docs`.
- cadre-core specs `invitation-bootstrap`, `cadre-node-cadre-invitation`, `cadre-node-owner-grant`, `cadre-node-formation-membership`, `membership-connection-gater`, `rent-node`, `strand-fret-addrs` and `strand-solicitation`: all pass (9 + 9 + 94 tests).
- Integration: `cadre-invite-row-unreplicated` passes, `enrollment-e2e` passes 6 of 7, `cadre-invite-any-member` fails 1 of 1, and `cadre-host-join-by-invitation` fails 3 of 3. Every failure traces to the pre-existing environment break below, not to this change. In each failing case the invitation's member list is identical before and after, because the minter is alone or has no address of its own.

## Known gaps

- **The environment is broken before this change.** `yarn build` and typecheck fail in `control-write-retry.ts` (untouched here). Sereus uses `PeersIncompleteError` from `@optimystic/db-core`, but the local `../optimystic` checkout is behind its `origin/main` and does not export it. At runtime `instanceof undefined` throws inside the control retry classifiers, so members answer refusable redemptions with retryable `internal` refusals. This is reported in `tickets/.pre-existing-error.md`. tsc still emits `dist`, which is how the tests above ran. Once the sibling is updated, re-run the four integration scenarios (`cadre-invite-row-unreplicated`, `enrollment-e2e`, `cadre-invite-any-member`, `cadre-host-join-by-invitation`) and the full cadre-core suite. I did not run the full 196-file suite, because this break would swamp it.
- **Choices where the ticket's wording left room:**
  - In the open invitation, a demoted device minter also contributes only `rankForPhone(own)[0]`, which applies "the same rule for the minting machine".
  - When the open-invitation minter is first, its own addresses stay in `getMultiaddrs()` order, as before. Only the cadre invitation ranks them.
  - In the mixed case (always-on and device siblings) the phone sits between the two groups, so a device sibling may lose a slot to it.
- **No new tripwire `NOTE:`s.** The always-on misdeclaration tradeoff is recorded in `docs/strands/formation.md` → "Limits and accepted tradeoffs".

## Docs changed

- `docs/strands/formation.md`: "What the inviter puts in the list" now carries a one-line Order bullet. A new section, "The order of the machines", holds the sibling evidence and the minter placement. A new limit, "An always-on declaration is not checked", was added.
- `docs/cadre/membership.md` → "The bundle": the member addresses and the cap now say where the issuer's allowance goes.
- `docs/cadre/owner-keys.md`: the `members` bullet links to "The bundle".
- `docs/network/relay.md`: the per-machine ranking limit is restated against the new order.
- `docs/cadre/apps.md` → "Whether another machine could redeem it": checked and still true, so unchanged.
