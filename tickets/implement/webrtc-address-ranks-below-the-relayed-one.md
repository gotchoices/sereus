description: A machine that can be reached two ways through one relay publishes both addresses, and several places treat them as equally good — so the slower one, which often connects to nothing at all, can take the place of the one that would have worked. Rank it below the plain relay address everywhere, so it is only tried once the reliable addresses have failed.
architecture: docs/network/relay.md#direct-connections-over-webrtc
files: packages/cadre-core/src/peer-dial.ts (`addrKind`), packages/cadre-core/src/peer-record.ts (`isSignalingAddr`, `orderSignalingFirst`), packages/cadre-core/src/node-claim-payload.ts (`classifyDialAddress`, `DialAddressKind`, `selectNodeClaimAddresses`), packages/cadre-core/src/invitation-bootstrap.ts (`rankForPhone`, `selectCadreInvitationMembers`, `cadreInvitationReach`), packages/cadre-core/src/cadre-node.ts (`getRelayAddress`, `collectSelfAddrs`, `resolvePeerAddrs`, `getStrandMultiaddrs`), packages/cadre-core/src/seed-bootstrap.ts (`getRelayAddress`), packages/cadre-core/src/strand-wake-protocol.ts (`dialWake`), packages/cadre-core/src/strand-addr-protocol.ts (`collectStrandAddrs`), packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/invitation-bootstrap.spec.ts, packages/cadre-core/test/node-claim-addresses.spec.ts, docs/network/relay.md
difficulty: medium
repro: verified
----
# A WebRTC address ranks below the plain relayed address beside it

A machine that listens on `/webrtc` and holds a relay reservation publishes two addresses per relay: the plain relayed one (`…/p2p-circuit/p2p/<self>`), which connects or fails quickly, and a WebRTC one (`…/p2p-circuit/webrtc/p2p/<self>`), which opens only if ICE finds a path between the two networks and otherwise answers nothing for about 23 s. `docs/network/relay.md` → "Direct connections over WebRTC" already states the rule: a dial something waits on goes relayed, and WebRTC is an extra. `peer-dial.ts` → `addrKind` already answers which shape an address is, and `directBeforeRelayed` already applies the rule for dials by address.

Two other predicates classify an address and cannot tell the two apart, because both contain a `p2p-circuit` component and neither looks at what follows it. Everything built on them ranks a WebRTC address level with the relayed address published beside it.

## Confirmed by running the exported functions

Run against `packages/cadre-core/src` on 2026-11-21 (`vitest` in `@serfab/cadre-core`, a scratch spec since deleted), with a two-relay list in the order a node that listens on `/webrtc` reports it — `webrtcListenAddrs` puts `/webrtc` ahead of the relay's own `/p2p-circuit` entry in `resolveListenAddrs`, so the WebRTC address is reported first:

```
classifyDialAddress('…/p2p-circuit/p2p/<peer>')        -> 'relay'   isSignalingAddr -> true   addrKind -> 'relayed'
classifyDialAddress('…/p2p-circuit/webrtc/p2p/<peer>') -> 'relay'   isSignalingAddr -> true   addrKind -> 'webrtc'

orderSignalingFirst([wrtc1, direct, rel1])               -> [wrtc1, rel1, direct]
selectCadreInvitationMembers([wrtc1, rel1, wrtc2, rel2]) -> [wrtc1, rel1, wrtc2, rel2]
  (with one sibling publishing the same four: six addresses, three of them WebRTC)
directBeforeRelayed([wrtc1, direct, rel1])               -> [direct, rel1, wrtc1]   // already correct
```

So `orderSignalingFirst` does not merely leave the order alone: it keeps the WebRTC address ahead of the plain relayed one, and that order is what the published `CadrePeer` record carries and what four call sites hand to a dial.

## What it costs, arm by arm

Each arm costs a retry, a slot in an invitation, or wall-clock time. Nothing that worked before is broken.

**A wake can run out of attempts.** `CadreNode.pushWake` resolves the target's addresses through `resolvePeerAddrs` (which orders with `orderSignalingFirst`) and hands them to `dialWake`, which budgets two whole attempts (`WAKE_DIAL_ATTEMPTS`) so that a stale first address still leaves a genuine try at a working one. With the WebRTC address first, attempt one spends about 23 s reaching nothing, and the one remaining attempt is the only real try — so a target whose first relay reservation has rotated is never reached at its second relay.

**A cadre invitation and an owner-grant bundle lose reach.** Both are built by `CadreNode.selectInvitationMembers` → `selectCadreInvitationMembers`, which names at most six addresses (`CADRE_INVITATION_MAX_ADDRS`, the figure that keeps the text inside one QR code). `rankForPhone` ranks on `classifyDialAddress`, which answers `'relay'` for both shapes, so a machine that offers WebRTC fills half its slots with addresses that cannot connect between two networks with no direct path — the case the invitation exists to cover. The cap itself is an accepted tradeoff recorded on `selectCadreInvitationMembers` and is not being re-opened; this changes the arithmetic behind it.

**A seed can name an address that connects to nothing.** `SeedBootstrapService.getRelayAddress` and `CadreNode.getRelayAddress` both take the first address containing `/p2p-circuit/`, which on a machine reporting the WebRTC address first is the WebRTC one. `addPhoneWithRelay` puts that single address in the seed it hands a new phone, and `CadreNode.collectSelfAddrs` folds it into the published record when the embedder has pushed its own invite addresses. This arm was not named in the fix ticket; it is the same root cause and belongs in the same change.

**A join pays for it in wall-clock time.** `member-redemption.ts` → `dialOnce` dials every address the bundle names in the bundle's order, each under its own deadline, so each WebRTC address reached before a working one costs the person joining about 23 s. Fixing `rankForPhone` fixes this; `dialOnce` itself must keep its given order (see non-scope).

**A sibling's strand-address request spends an attempt.** `strand-addr-protocol.ts` → `dialTargets` tries the peer id, then the addresses in the order given, which for a cadre sibling is `resolvePeerAddrs` order. `collectStrandAddrs` orders its union the same way.

## The change

One rule, answered once: **an address that needs ICE after its relay hop ranks below the plain relayed address published beside it.** `addrKind` stays the single answer to "what kind of address is this"; the two predicates above stop asking the question themselves and ask it instead.

### `peer-dial.ts` — expose the classification at the layer each caller already has

`addrKind(addr: Multiaddr)` keeps its signature and delegates to a new exported `addrKindOfComponents(components: readonly Component[]): AddrKind` holding the component walk. `Component` is already imported there as a type. `node-claim-payload.ts` already has components in hand, so it can ask without re-parsing.

### `peer-record.ts` — the ordering used by the published record and every resolve

- A module-local `addrKindOf(addr: string): AddrKind | undefined`: parse with this package's own `multiaddr` in a try/catch, hand the components to `addrKindOfComponents`, and answer `undefined` when the string does not parse.
- `isSignalingAddr` keeps its meaning — any address with a relay hop, either shape — and answers from `addrKindOf` instead of a substring test, so `SIGNALING_PREFIX` goes away. An address that does not parse is no longer "signaling"; its only reader is the `signalingOnly` option of `resolvePeerAddrs`, which parses the survivors on the very next line and drops it anyway, so no caller sees a difference.
- `orderSignalingFirst` becomes three groups, each keeping its given order: `relayed`, then `direct` (and anything that does not parse, which every call site drops or ignores downstream), then `webrtc`. Rename it `orderRelayedFirst`: after this change "signaling first" is actively wrong, because a WebRTC address is a signaling address and goes last. Callers are `cadre-node.ts` (`collectSelfAddrs`, `resolvePeerAddrs`, `getStrandMultiaddrs`, plus two doc comments), `strand-addr-protocol.ts` (`collectStrandAddrs` and its comments), the `index.ts` re-export and `peer-record.spec.ts` — grep the name, prose included.
- Add `firstRelayedAddr(addrs: readonly string[]): string | null`: the first entry that `isSignalingAddr` accepts, taken in `orderRelayedFirst` order, so a plain relayed address wins and a WebRTC one is returned only when there is no plain relayed address at all. Keep the existing `/p2p-circuit/` test that both `getRelayAddress` copies apply, so an address naming no destination is still skipped exactly as today; only which of the matching addresses wins changes. Both `CadreNode.getRelayAddress` and `SeedBootstrapService.getRelayAddress` call it, which also removes one of the two duplicated substring tests.

### `node-claim-payload.ts` — the classification an invitation's ranking reads

- `DialAddressKind` gains `'webrtc'`: a relay hop carrying WebRTC signalling. It is not restricted to the phone's own network, but it connects only if ICE finds a path.
- `classifyComponents` answers it from `addrKindOfComponents` rather than its own `CODE_P2P_CIRCUIT` test (that constant is still used by `destinationIn`, so the import stays).
- `selectNodeClaimAddresses` gains a bucket for the new kind, after `relay`, since a phone dials a node code's addresses in turn. Keep the address rather than dropping it: a `cadre-host` node offers no WebRTC address today, so this path is dormant, but dropping it would lose the only address of a machine that published nothing else.

### `invitation-bootstrap.ts` — what survives the QR-code cap

- `PHONE_DIAL_RANK` gains `webrtc`, between the kinds that reach from anywhere and the LAN-only ones: `{ relay: 0, name: 0, public: 0, webrtc: 1, private: 2, loopback: 3 }`, with an address no phone can dial still last. The existing axis — how widely a phone can reach the address — already orders it there: a WebRTC address reaches from any network when ICE finds a path, which is less than always and more than one network only. Update the comment to say so.
- `cadreInvitationReach` counts `'webrtc'` with `relay`, `name` and `public` in its `anywhere` answer. The three answers are about network scope, and a WebRTC address is not a local-network address. Say in the doc comment that whether ICE connects is a separate matter, and that after the ranking change a WebRTC address only takes a slot once every relayed address of that machine already has one.
- Update the `CADRE_INVITATION_MAX_ADDRS` doc and the accepted-tradeoff `NOTE:` on `selectCadreInvitationMembers` to state that the cap now drops a WebRTC address before a relayed one. Leave the tradeoff itself declined — this changes its arithmetic, not the decision.

### `strand-wake-protocol.ts` — one invariant at the seam

`dialWake` orders its given `addrs` with `directBeforeRelayed` before handing them to `tryAddrsInTurn`. Its only in-repo caller already passes an ordered list, so this changes nothing today; it is what keeps the two-attempt budget off a WebRTC address whatever order a future caller gives, at the site that owns the budget. `peer-dial.ts` is already imported there. Say in the comment on `WAKE_DIAL_ATTEMPTS` that the two attempts are two relayed or direct attempts.

### Not in scope — do not "unify" these

- `diagnostics/connection-path.ts` → `classifyTransport` asks a different question: the data path of a connection that is already open, where `…/p2p-circuit/webrtc` means ICE succeeded and the path is direct. Its answer for that shape is the opposite of `addrKind`'s on purpose, and its ordered checks are already correct.
- `member-redemption.ts` → `dialOnce` must keep the order its caller gave. The bundle's order carries which machine to try first (the minting machine, then siblings by how likely each is to be up); reordering the whole list by address kind would discard that. The arm is fixed where the bundle is built.
- `relay-reservation.ts` → `circuitMultiaddrs` answers "does this node hold a reservation right now". A WebRTC address exists only because a reservation does, so counting it is correct.

## Tests

The bug is in two pure predicates, so the reproduction belongs at that layer. No integration test: the end-to-end shapes the fix ticket sketched (a wake past a dead first relay, a timed redemption, each in the shape of `webrtc-ice-failure-falls-back-to-relay.integration.ts`) each cost minutes of wall-clock to assert what these three assertions pin directly.

- `test/peer-record.spec.ts` — `orderRelayedFirst` puts a `…/p2p-circuit/webrtc/…` address after the plain relayed and the direct ones. The existing `describe('signaling address ordering')` uses stand-ins (`/p2p-circuit/a`, `/p2p/X`) that do not parse as multiaddrs; now that the ordering parses, rewrite those cases with real addresses, and keep one case asserting that an address that does not parse is still returned (grouped with the direct ones) rather than dropped.
- `test/invitation-bootstrap.spec.ts` — the capped selection for a machine on two relays that also offers WebRTC names no more WebRTC addresses than relayed ones.
- `test/node-claim-addresses.spec.ts` — a WebRTC address in a node's reported set lands last, behind the plain relayed one. One assertion, pinning the new bucket so a later exhaustiveness change cannot put it first.

## Docs

`docs/network/relay.md`:

- "Direct connections over WebRTC": the paragraph ending "a site that keeps the order its caller gave still tries a WebRTC address on the same terms as a relayed one (see the limits below)" — the exception is gone. State instead that the rule holds at every site because one classification answers it, and name what that now covers: the dial order, the order of the addresses a machine publishes, the relay address a seed carries, and the ranking that fills an invitation.
- The "Dials by peer id" bullet stays true — libp2p's sorter still picks, and it still picks the WebRTC address first. Adjust only the strand-address clause: the peer-id attempt is libp2p's pick, and the address fallback behind it is now ordered.
- "Limits and accepted tradeoffs": delete the bullet beginning "Where a caller fixes the dial order", which cites this ticket's predecessor slug. Nothing replaces it.

Keep the doc inside its size budget (`yarn check:docs`); this is a net deletion.

## TODO

- Extract `addrKindOfComponents` in `peer-dial.ts` and delegate `addrKind` to it.
- In `peer-record.ts`: add the module-local `addrKindOf`, reimplement `isSignalingAddr` on it, drop `SIGNALING_PREFIX`, rewrite `orderSignalingFirst` as three groups and rename it `orderRelayedFirst`, add `firstRelayedAddr`.
- Update every `orderSignalingFirst` reference, prose included: `cadre-node.ts`, `strand-addr-protocol.ts`, `index.ts`, `peer-record.spec.ts`. Fix the `collectSelfAddrs` and `getStrandMultiaddrs` doc comments and the `ResolveOpts.signalingOnly` doc in `types.ts`, which all still describe the relay address as "the WebRTC dial input".
- Point both `getRelayAddress` copies (`cadre-node.ts`, `seed-bootstrap.ts`) at `firstRelayedAddr`.
- In `node-claim-payload.ts`: add `'webrtc'` to `DialAddressKind`, answer it from `addrKindOfComponents` in `classifyComponents`, and give `selectNodeClaimAddresses` its bucket after `relay`.
- In `invitation-bootstrap.ts`: rank `webrtc` in `PHONE_DIAL_RANK`, count it in `cadreInvitationReach`'s `anywhere` answer, and update the cap doc and the accepted-tradeoff `NOTE:`.
- Order `dialWake`'s input with `directBeforeRelayed` and update the `WAKE_DIAL_ATTEMPTS` comment.
- Add the three test cases above and rewrite the existing ordering cases onto addresses that parse.
- Update `docs/network/relay.md` as described.
- `yarn workspace @serfab/cadre-core test` and `yarn lint` (which runs `yarn check:docs`).
