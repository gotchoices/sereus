description: A machine that offers a WebRTC address publishes it beside a plain relayed one, and several places treat the two as equally good. The WebRTC one can take the place of an address that would have worked — wasting a retry when waking a sleeping machine, and taking a slot in the invitation a QR code carries.
architecture: docs/network/relay.md#direct-connections-over-webrtc
files: packages/cadre-core/src/peer-record.ts (`isSignalingAddr`, `orderSignalingFirst`), packages/cadre-core/src/node-claim-payload.ts (`classifyDialAddress`, `DialAddressKind`), packages/cadre-core/src/invitation-bootstrap.ts (`rankForPhone`, `selectCadreInvitationMembers`), packages/cadre-core/src/strand-wake-protocol.ts (`dialWake`), packages/cadre-core/src/member-redemption.ts (`dialOnce`), packages/cadre-core/src/strand-addr-protocol.ts (`dialTargets`), packages/cadre-core/src/peer-dial.ts (`addrKind`), docs/network/relay.md
difficulty: medium
repro: static
----
# A WebRTC address can displace an address that would have worked

`webrtc-addresses-never-hold-a-dial` (commit `ticket(implement): webrtc-addresses-never-hold-a-dial`) introduced one classification of an address — `peer-dial.ts` → `addrKind`: `direct`, `relayed`, or `webrtc` — and the rule in `docs/network/relay.md` → "Direct connections over WebRTC": **a dial something waits on goes through the relay; WebRTC is an extra.** It applied that rule at the two sites that choose the order of a peer's whole address list (`dialPeerAddrs`, which orders direct → relayed → WebRTC, and strand formation, which filters WebRTC out).

Everywhere else, a WebRTC address is still treated as being as good as the plain relayed address published beside it. Nothing is reordered, so no dial is cut off; what happens instead is that a WebRTC address consumes something finite that an address capable of connecting needed.

## What treats the two as equal

Both predicates that sort or classify an address for dialing answer "relay" for either shape, because both contain a `p2p-circuit` component and neither looks at what follows it:

- `peer-record.ts` → `isSignalingAddr` / `orderSignalingFirst`, which every published address record passes through.
- `node-claim-payload.ts` → `classifyDialAddress`, whose `DialAddressKind` has no value for "needs ICE after the relay hop". `invitation-bootstrap.ts` → `rankForPhone` ranks on it.

Run against the real exported functions, with a two-relay address list in the order a node reports it:

```
classifyDialAddress('…/p2p-circuit/p2p/<peer>')         -> 'relay'   isSignalingAddr -> true
classifyDialAddress('…/p2p-circuit/webrtc/p2p/<peer>')  -> 'relay'   isSignalingAddr -> true
selectCadreInvitationMembers([wrtc1, rel1, wrtc2, rel2]) -> [wrtc1, rel1, wrtc2, rel2]
```

## Where that costs something

**A cadre invitation loses reach.** An invitation names at most six addresses (`CADRE_INVITATION_MAX_ADDRS`, the figure that keeps its text inside one QR code), at most four from the minting machine and two from each other machine. Every machine that offers WebRTC publishes two addresses per relay instead of one, and both rank equally, so up to half the invitation's addresses cannot connect between two networks with no direct path — the case the invitation exists to cover. The cap is already an accepted tradeoff (the `NOTE:` on `selectCadreInvitationMembers`, declined on size grounds, "revisit if redemptions are seen failing for want of a sibling address the record held"); this changes the arithmetic behind that decision rather than re-opening it.

**A wake can run out of attempts.** `dialWake` budgets two whole attempts for a peer (`WAKE_DIAL_ATTEMPTS`), on the reasoning that a stale first address should still leave a genuine try at a working one. It dials the list in the order it was handed. Where a machine's first relayed address no longer works — a rotated or dead relay reservation, the case the second attempt is for — the second attempt can land on the WebRTC address of that same relay and spend about 23 s reaching nothing, and the wake fails with a reachable relayed address never tried.

**A join pays for it in wall-clock time.** `member-redemption.ts` → `dialOnce` (cadre invitations and owner grants) dials every address the bundle names in the bundle's order, each under its own deadline. Each WebRTC address it reaches before a working one costs the person joining about 23 s with nothing to show.

**A sibling's strand-address request spends an attempt.** `strand-addr-protocol.ts` → `dialTargets` tries the peer id, then the addresses in the order given; libp2p's own sorter puts the WebRTC address first, and the fallback addresses are tried in the order they arrived.

## What this should come to

One rule, held where it cannot be forgotten by the next dial site: **an address that needs ICE after its relay hop ranks below the plain relayed address published beside it.** The two classifying predicates above are where the two shapes become indistinguishable, so they are the natural place to settle it — a dial loop should not have to know what WebRTC is. Expected results:

- Every ordering built from those predicates puts a WebRTC address after the plain relayed addresses, and the capped invitation selection drops a WebRTC address before it drops a relayed one.
- A WebRTC address is still kept and still dialable when it is all a machine published; nothing is filtered away where filtering would leave nothing.
- `addrKind` stays the one answer to "what kind of address is this", rather than a fourth substring test appearing somewhere.

Reachable today for a browser tab (`reference-app-web` listens on `/webrtc` whenever it has a relay) and for any `CadreNode` configured with the WebRTC transport.

**It also reaches every phone already: `3-phone-listens-on-webrtc` landed first (`ticket(implement): phone-listens-on-webrtc`), not after this.** The earlier expectation that this ticket would be worked ahead of it did not hold — nothing on the board expressed the dependency, since `3-phone-listens-on-webrtc` named only `webrtc-addresses-never-hold-a-dial` as its prereq. So the invitation arithmetic above now applies to the ordinary two-phone case, and the wake and redemption arms apply to a phone's own addresses, rather than only to a browser tab and a hand-configured node. Nothing is broken that worked before — each arm costs a retry, a slot or wall-clock time, not correctness — but the exposure is the full phone population rather than the reference web app.

## Confirming it

Static: read from the code and from running the exported predicates above, not from a failing join. What would confirm each arm end to end, in the shape of `webrtc-ice-failure-falls-back-to-relay.integration.ts` (two parties listening on `/webrtc` with ICE that cannot connect):

- A wake to a party whose first relay is gone, asserting the ack arrives and that the wake did not exhaust its budget.
- A cadre-invitation redemption against a party whose first relayed address is dead, timed.
- The invitation's address list for a two-relay machine, asserting it names no more WebRTC addresses than relayed ones.
