description: A machine that offers both a WebRTC address and a plain relayed one used to make joins fail outright wherever WebRTC could not connect. Dials that something waits on now go through the relay, and WebRTC is only ever an extra.
architecture: docs/network/relay.md
files: packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/peer-dial.spec.ts, packages/integration-tests/src/scenarios/webrtc-ice-failure-falls-back-to-relay.integration.ts, packages/integration-tests/src/harness/node-fixtures.ts, docs/network/relay.md, ops/docs/ice-servers.md, docs/contributing/topology-coverage.md
----
# A WebRTC address never holds up a dial that something is waiting on

Closes GitHub issue #61.

## What landed

One three-way address classification in `peer-dial.ts` (`addrKind` / `AddrKind`): `direct` (no relay hop — `/webrtc-direct` is here), `relayed` (a relay hop with nothing negotiated after it), `webrtc` (a relay hop followed by `webrtc`, so the connection waits on ICE). Three sites read it instead of their own substring test:

- `directBeforeRelayed` orders direct, then relayed, then WebRTC, keeping a WebRTC address in the list so a peer that published only one is still dialed.
- `reusableConnection` no longer hands an open relayed connection to a dial of a WebRTC address, which is the answer libp2p gives and what lets a later upgrade dial replace the link.
- `dialFormationChannel` leaves WebRTC addresses out of the list it gives `node.dial`, unless they are all the responder published. Filtered rather than reordered, because libp2p re-sorts any list given to one dial.

`dialControlBootstrapPeers` got a `NOTE:` and no behaviour change: it dials by peer id, so libp2p's sorter picks, and nothing waits on that pass.

Docs: a "Direct connections over WebRTC" section in `docs/network/relay.md` stating the rule and naming the dial sites, a sentence in `ops/docs/ice-servers.md`, and the new scenario in the topology coverage map.

The regression test is `webrtc-ice-failure-falls-back-to-relay.integration.ts`: two relay-only parties on one loopback relay, each also listening on `/webrtc` with ICE that can never connect. It was confirmed to fail without the fix (`FormationUnreachableError` at 25 s) and takes 218-344 ms with it. The ordering contract is a table test in `peer-dial.spec.ts`.

## Review findings

**Read first, then the handoff.** The implement diff (`ticket(implement): webrtc-addresses-never-hold-a-dial`) was read before its summary, then every file it touched and the dial sites it did not.

**Verified, and found sound.** The deviation the handoff asked a reviewer to weigh — walking the multiaddr components rather than using `@multiformats/multiaddr-matcher`'s `Circuit` / `WebRTC` — was checked against 3.0.2 in the tree. Its table is exactly right: a relay leg over `/memory` and a two-hop circuit match neither matcher, so the matchers would classify a relayed address as `direct` and dial it first. Walking the components is also what `relaysThrough` in the same file already does. Choice upheld, no change. `addrKind`'s explicit loop rather than `findLastIndex` is likewise correct and not an oversight: the package's `lib` is ES2022, which does not type `findLastIndex`.

Also confirmed by reading: `withoutSelfRelayed` still drops a WebRTC address that relays through this node (`relaysThrough` reads the `p2p` component before each `p2p-circuit`, which such an address carries); the `@libp2p/webrtc` pin at exactly `6.0.33` matches every other workspace that depends on it; `diagnostics/connection-path.ts` → `classifyTransport` is not a duplicate of `addrKind` — it answers what an established connection's data path is (where `/p2p-circuit/webrtc` is `direct`), not whether reaching a peer needs a relay hop.

**Gates.** `yarn lint` (ESLint plus `check:docs`) and `yarn typecheck` across every workspace pass. `peer-dial` (28 tests), the formation specs (12 files, 223 tests), the wake, redemption, invitation and peer-record specs (66 tests) and the new integration scenario all pass; the scenario reproduced the handoff's timings (formation 218 ms, the row reaching A 134 ms). No pre-existing failure surfaced, so nothing was written to `tickets/.pre-existing-error.md`.

**Tests.** None cut and none added. The ordering table pins the rule the fix exists for over the shapes that trap it (`/webrtc-direct`, a relay hop with its destination missing, two relays interleaved), and the scenario is the issue's own reproduction with an anti-vacuity guard that the address really would be dialed over WebRTC. The defect found below is filed with the test that would confirm it, rather than landing a failing test here.

**Major finding, filed: `webrtc-address-can-displace-a-working-one` (in `fix/`).** The rule was applied at the two sites that order a peer's whole address list, but the two predicates that make the two address shapes indistinguishable were left alone — `peer-record.ts` → `isSignalingAddr` / `orderSignalingFirst`, and `node-claim-payload.ts` → `classifyDialAddress`, both of which answer "relay" for either shape. So a WebRTC address still consumes something finite that a working address needed: one of a wake's two attempts (`dialWake`), a full per-address deadline in a cadre-invitation or owner-grant redemption (`member-redemption.ts` → `dialOnce`), an attempt in a sibling's strand-address request, and a slot in the six-address cap that keeps an invitation inside one QR code. Confirmed by running the real exported predicates, not by a failing join, so the ticket is marked `repro: static` and names the scenario for each arm. It is filed in `fix/`, which is worked before `3-phone-listens-on-webrtc` makes every phone publish these addresses.

**Fixed in this pass.** Both docs overstated the rule as holding wherever the dial order is ours to choose. `docs/network/relay.md` now says it holds at the sites that order a peer's whole list, carries the limit for the sites that keep their caller's order (citing the ticket above), and names the strand-address request as a third by-peer-id dial path; `ops/docs/ice-servers.md`'s claim that "nothing a caller waits for is ever dialed at a WebRTC address while another address is untried" is corrected. Two comments left describing the old two-way order were updated (`strand-peer-redial.ts`, and `seed-bootstrap.ts` → `connectForDelivery`).

**Tripwire, parked at its site.** `reusableConnection`'s docstring now records that the change costs nothing only because a WebRTC address is always published beside the plain relayed address of the same relay: if a peer whose only address is a WebRTC one ever appears, a dial of it will no longer reuse an open relayed connection and will pay the ICE timeout instead. Not reachable today — a reservation publishes both shapes — so a `NOTE:` at the site, not a ticket.

**Considered and not pursued.** `directBeforeRelayed` now implements a three-way order under a two-way name; the name states a true but partial fact, the docstring is explicit, and it is exported, so the rename was judged more churn than clarity. `addrKind` is still not exported from the package index, which the handoff flagged — correctly left as is, since `relayed-connections-try-a-webrtc-upgrade`, the only thing that needs it, is inside cadre-core. The handoff's remaining gaps (no test for the `reusableConnection` change alone, formation's all-WebRTC fallback verified by inspection, one loopback arm with no link delay, a WebRTC dial still in flight at teardown) were each weighed and accepted as stated: the first belongs to the upgrade ticket that will exercise it, and the rest would cost a scenario to assert something no caller depends on.

**Nothing found** on resource cleanup (no new resources; the scenario stops both nodes and the relay in a `finally`), error handling (no exception eaten; the formation filter logs what it drops), type safety (no `any`, the kind is a union), or file size (`peer-dial.ts` is 667 lines).
