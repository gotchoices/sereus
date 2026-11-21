description: A machine reachable two ways through one relay used to publish both addresses as equals, so the slower one — which often connects to nothing — could take the place of the one that would have worked. It now ranks below the plain relay address everywhere, and is only tried once the reliable addresses have failed.
architecture: docs/network/relay.md#direct-connections-over-webrtc
files: packages/cadre-core/src/peer-dial.ts (`addrKindOfComponents`, `webrtcLast`), packages/cadre-core/src/peer-record.ts (`addrKindOf`, `isSignalingAddr`, `orderRelayedFirst`, `firstRelayedAddr`), packages/cadre-core/src/node-claim-payload.ts (`DialAddressKind`, `classifyComponents`, `selectNodeClaimAddresses`), packages/cadre-core/src/invitation-bootstrap.ts (`PHONE_DIAL_RANK`, `cadreInvitationReach`), packages/cadre-core/src/cadre-node.ts (`collectSelfAddrs`, `resolvePeerAddrs`, `getStrandMultiaddrs`, `getRelayAddress`), packages/cadre-core/src/seed-bootstrap.ts (`getRelayAddress`), packages/cadre-core/src/strand-wake-protocol.ts (`dialWake`, `WAKE_DIAL_ATTEMPTS`), packages/cadre-core/src/strand-addr-protocol.ts (`collectStrandAddrs`), packages/cadre-core/src/types.ts (`ResolveOpts.signalingOnly`), packages/cadre-core/src/index.ts, packages/cadre-core/test/peer-record.spec.ts, packages/cadre-core/test/invitation-bootstrap.spec.ts, packages/cadre-core/test/node-claim-addresses.spec.ts, docs/network/relay.md
difficulty: medium
----
# Review: a WebRTC address ranks below the plain relayed address beside it

## What the change is

A machine that listens on `/webrtc` and holds a relay reservation publishes two addresses per relay: the plain relayed one (`…/p2p-circuit/p2p/<self>`), which connects or fails quickly, and a WebRTC one (`…/p2p-circuit/webrtc/p2p/<self>`), which opens only if ICE finds a path between the two networks and otherwise answers nothing for about 23 s.

Two predicates could not tell the two shapes apart, because both contain a `p2p-circuit` component and neither looked past it. Everything built on them ranked a WebRTC address level with — in practice ahead of — the relayed address published beside it. One rule now answers it in one place: **an address that needs ICE after its relay hop ranks below the plain relayed address published beside it.**

### The classification

- `peer-dial.ts`: the component walk inside `addrKind` moved to a new exported `addrKindOfComponents(components)`, so a caller that already holds components can ask without re-parsing. `addrKind(addr)` delegates to it and keeps its signature.
- `peer-record.ts`: a module-local `addrKindOf(addr: string)` parses with this package's own `multiaddr` and answers `undefined` when the string does not parse.

### What now asks it

- **`isSignalingAddr`** keeps its meaning (any address with a relay hop, either shape) but answers from `addrKindOf` instead of a substring test. `SIGNALING_PREFIX` is gone. An address that does not parse is no longer "signaling"; its only reader is `resolvePeerAddrs`'s `signalingOnly`, which parses the survivors on the next line and would drop it anyway.
- **`orderSignalingFirst` → `orderRelayedFirst`** — three groups, each keeping its given order: `relayed`, then `direct` (and anything that does not parse), then `webrtc`. Renamed because "signaling first" became actively wrong: a WebRTC address *is* a signaling address and now goes last. Every reference updated, prose included (`cadre-node.ts`, `strand-addr-protocol.ts`, `index.ts`, the spec).
- **`firstRelayedAddr`** — new: the first address reaching through a relay, taken in `orderRelayedFirst` order, so a WebRTC address is named only when there is no plain relayed one. Both duplicated `getRelayAddress` substring tests (`cadre-node.ts`, `seed-bootstrap.ts`) now call it.
- **`DialAddressKind`** gained `'webrtc'`, answered from `addrKindOfComponents` in `classifyComponents`. `selectNodeClaimAddresses` gained a bucket for it, after `relay` — kept rather than dropped, since a machine that published nothing else would otherwise lose its only address.
- **`PHONE_DIAL_RANK`** gained `webrtc: 1`, between the kinds that reach from anywhere and the LAN-only ones, with an unreachable address still last (now derived from the rank table rather than a hand-written `3`). `cadreInvitationReach` counts `'webrtc'` as `anywhere`: the answers are about network scope, and the relay carries its signalling from any network.
- **`dialWake`** orders its input so no address needing ICE can take one of its two whole attempts.

## Deviation from the implement ticket — read this one first

The ticket said `dialWake` should order its input with **`directBeforeRelayed`**, claiming "this changes nothing today". It does change something, and the change would be a regression: `directBeforeRelayed` hoists direct addresses ahead of relayed ones, while the wake path deliberately wants the **relayed address first** — a hibernating, NAT'd machine is usually reachable at no other address, and its direct LAN addresses blackhole for a full attempt. `dialWake`'s own doc comment says exactly that about libp2p's sorter demoting the relayed address. The existing spec case "names EVERY candidate and its cause when they all fail" asserts the circuit address is tried before the direct one, and `directBeforeRelayed` inverts it.

So a new `webrtcLast(addrs)` was added to `peer-dial.ts` instead: every `webrtc` address moves to the end, everything else keeps the order the caller gave. That is the stated intent of the arm (keep the two-attempt budget off an ICE-dependent address) without the second effect the ticket did not account for. **Worth a reviewer's judgment**: whether `webrtcLast` earns its place beside `directBeforeRelayed`, or whether the wake arm should be dropped entirely — its only in-repo caller (`pushWake`) already passes a `resolvePeerAddrs` list that is correctly ordered, so `webrtcLast` is a seam invariant for future callers, not a fix for a live defect.

## Second judgment call: a new import edge

`node-claim-payload.ts` now imports `addrKindOfComponents` from `peer-dial.ts`, as the ticket specified. That module's header advertised itself as importing only `@multiformats/multiaddr`, `@libp2p/peer-id` and `uint8arrays` so it loads on React Native and in the browser. `peer-dial.ts` drags in `control-stream.ts`, `describe-thrown.ts` and `link-budget.ts` — and therefore `@optimystic/db-p2p`. Nothing platform-bound, and the module is reachable only through the package index (there is no `exports` subpath for it, and nothing outside the package deep-imports it), so the index loads that graph regardless. The header comment now says this plainly rather than keeping a claim that had quietly stopped being true. A reviewer who thinks the edge is still wrong has one alternative: move `AddrKind` + `addrKindOfComponents` into a new dependency-free module that `peer-dial.ts` re-exports from.

## Tests added, and what each verifies

- `test/peer-record.spec.ts`, `describe('relayed address ordering')` — the old `describe('signaling address ordering')` used stand-ins (`/p2p-circuit/a`, `/p2p/X`) that do not parse as multiaddrs, and the ordering now parses, so those cases were rewritten onto real addresses:
  - *counts both relayed shapes as signaling, and nothing else* — `isSignalingAddr` accepts a plain relayed and a WebRTC address, rejects a direct one and a string that does not parse.
  - *puts a WebRTC addr behind the relayed and direct ones* — the reproduction: input in the order a machine listening on `/webrtc` reports it (WebRTC first), output with both relayed addresses leading, in their given order.
  - *keeps an addr that does not parse* — grouped with the direct ones rather than dropped.
  - *names the plain relayed addr for a seed* — `firstRelayedAddr` prefers the plain relayed one, falls back to a WebRTC one when there is no other, and still skips an address that ends at its hop.
- `test/invitation-bootstrap.spec.ts`:
  - *fills the cap with a machine's relayed addresses before its WebRTC ones* — a machine on two relays that also offers WebRTC, plus a sibling publishing the same four: the six-address cap now spends four slots on relayed addresses and the sibling's two slots both go to addresses that connect without ICE. Before the change, `[wrtc1, rel1, wrtc2, rel2]` came back unchanged and three of six addresses were WebRTC.
  - *counts a WebRTC address as reaching from anywhere* — pins `cadreInvitationReach`'s scope axis.
- `test/node-claim-addresses.spec.ts`:
  - *puts a WebRTC address behind the plain relayed one, keeping it rather than dropping it* — pins the new `selectNodeClaimAddresses` bucket, so a later exhaustiveness change cannot put it first or drop the address.

No integration test. The defect is in two pure predicates, and the end-to-end shapes (a wake past a dead first relay, a timed redemption) each cost minutes of wall-clock to assert what these pin directly.

## Validation run

- `yarn workspace @serfab/cadre-core build` — clean.
- `yarn workspace @serfab/cadre-core test` — 200 files, 2,686 passed, 1 skipped (pre-existing skip). No pre-existing failures surfaced; `tickets/.pre-existing-error.md` was not written.
- `yarn typecheck` (all workspaces) — clean, including every package that consumes cadre-core's public API. `orderSignalingFirst` left the index and nothing outside the package used it.
- `yarn lint` (ESLint + `yarn check:docs`) — clean. `docs/network/relay.md` is a net deletion and inside its size budget; the rewritten paragraph is 119 words against the 120 limit, so a reviewer adding to it will need to split.

## Where to look hardest

- **`firstRelayedAddr` keeps the `/p2p-circuit/` substring test** (with the trailing slash) alongside `isSignalingAddr`, deliberately, so an address that ends at its hop and names no destination is skipped exactly as both `getRelayAddress` copies skipped it before. Check that reads as intended rather than as a leftover: the substring test is what preserves today's behaviour, and `isSignalingAddr` is what adds the ranking.
- **`classifyComponents` kept its `CODE_P2P_CIRCUIT` import** — still used by `destinationIn`, which asks a different question (where does this address terminate), so the two tests coexisting is correct, not duplication.
- **`webrtcLast` classifies each address twice** (two filter passes). Fine at these list lengths; flagged so it is not mistaken for an oversight.
- **Nothing was unified in three places the ticket ruled out**, and each was left alone: `diagnostics/connection-path.ts` → `classifyTransport` (asks about an *open* connection's data path, where `/p2p-circuit/webrtc` means ICE succeeded — the opposite answer on purpose), `member-redemption.ts` → `dialOnce` (must keep its caller's order; fixed where the bundle is built), `relay-reservation.ts` → `circuitMultiaddrs` (answers "is a reservation held", and a WebRTC address exists only because one is).

## Tripwire parked in code

`selectCadreInvitationMembers` (`invitation-bootstrap.ts`) carries a new `NOTE:`: the ranking is per machine and the machines keep their own order (the minting one, then siblings by how likely each is to be up), so the minting machine's WebRTC address can still sit ahead of a sibling's relayed one. A redeemer dials in order, so when the minting machine is down that costs about 23 s before the siblings are tried. Left as is because the machine order carries information an address-kind sort would discard; the note says what to do if redemptions are seen paying it. The existing accepted-tradeoff `NOTE:` about the QR-code cap stays declined — only its arithmetic changed, and the comment now says which address the cap drops first.
