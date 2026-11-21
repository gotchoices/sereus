description: A machine reachable two ways through one relay used to publish both addresses as equals, so the slower one — which often connects to nothing — could take the place of the one that would have worked. It now ranks below the plain relay address everywhere, and is only tried once the reliable addresses have failed.
architecture: docs/network/relay.md#direct-connections-over-webrtc
files:
  - packages/cadre-core/src/peer-dial.ts (`addrKindOfComponents`, `webrtcLast`)
  - packages/cadre-core/src/peer-record.ts (`addrKindOf`, `isSignalingAddr`, `orderRelayedFirst`, `firstRelayedAddr`, `continuesPastItsHop`)
  - packages/cadre-core/src/node-claim-payload.ts (`DialAddressKind`, `classifyComponents`, `selectNodeClaimAddresses`)
  - packages/cadre-core/src/invitation-bootstrap.ts (`PHONE_DIAL_RANK`, `cadreInvitationReach`, two `NOTE:`s on `selectCadreInvitationMembers`)
  - packages/cadre-core/src/cadre-node.ts (`collectSelfAddrs`, `resolvePeerAddrs`, `getStrandMultiaddrs`, `getRelayAddress`)
  - packages/cadre-core/src/seed-bootstrap.ts (`getRelayAddress`)
  - packages/cadre-core/src/strand-wake-protocol.ts (`dialWake`, `WAKE_DIAL_ATTEMPTS`)
  - packages/cadre-core/src/strand-addr-protocol.ts (`collectStrandAddrs`), packages/cadre-core/src/strand-formation-protocol.ts (prose)
  - packages/cadre-core/src/types.ts (`PeerAddressRecord.addrs`, `StrandAddrResponse.multiaddrs`, `ResolveOpts.signalingOnly`, `CadreInvitationReach`)
  - packages/cadre-core/src/control-schema.ts + schemas/control.qsql (the `CadrePeer.Multiaddr` column comment)
  - docs/network/relay.md ("Direct connections over WebRTC"; one new "Limits and accepted tradeoffs" bullet)
  - packages/cadre-core/test/{peer-record,invitation-bootstrap,node-claim-addresses,strand-wake-protocol}.spec.ts
----

# What landed

One rule, answered in one place: **an address that needs ICE after its relay hop ranks below the plain relayed address published beside it.** A machine listening on `/webrtc` that holds a relay reservation publishes two addresses per relay — the plain relayed one, which connects or fails quickly, and a WebRTC one, which opens only if ICE finds a path between the two networks and otherwise answers nothing for about 23 s. Two predicates could not tell the shapes apart, because both contain a `p2p-circuit` component and neither looked past it.

`peer-dial.ts`'s component walk is now an exported `addrKindOfComponents`, and the predicates ask it instead of testing for a relay hop themselves: `isSignalingAddr` (unchanged meaning — any address reaching through a relay, either shape), `orderSignalingFirst` → `orderRelayedFirst` (three groups: relayed, then direct, then WebRTC), `classifyComponents` (a new `'webrtc'` `DialAddressKind`), and a new `firstRelayedAddr` that both `getRelayAddress` copies now share instead of each applying its own substring test. Built on those: the order a machine publishes its own `CadrePeer` addresses in and so the order every resolve hands a dial, the single relayed address a seed carries, the `selectNodeClaimAddresses` bucket order, and `PHONE_DIAL_RANK` — which decides what survives the six-address cap that keeps a cadre invitation inside one QR code.

The implement stage deviated from its ticket on one arm and said so. The ticket asked for `directBeforeRelayed` in `dialWake`, claiming it changed nothing; it would have inverted the wake path's deliberate relayed-first order, which an existing spec case pins. A new `webrtcLast` was added instead — WebRTC addresses to the end, everything else in the caller's order — which is the arm's stated intent without the second effect. That call was reviewed and kept; see below.

# Review findings

## Checked

Read the implement diff (`ticket(implement): webrtc-address-ranks-below-the-relayed-one`) before the handoff summary. Traced every consumer of the two changed classifications: `classifyDialAddress` / `DialAddressKind` have exactly two readers in the repo (`invitation-bootstrap.ts`, `node-claim-payload.ts`), both updated, and the `Exclude<DialAddressKind, 'loopback'>` return of `classifyClaimAddress` makes `selectNodeClaimAddresses`'s new bucket exhaustive at the type level. `isSignalingAddr` and `orderRelayedFirst` are exported from the package index; nothing outside the package uses either, and `orderSignalingFirst` left the index with no external caller (`yarn typecheck` across all workspaces covers that).

Verified the three sites the ticket ruled out are correctly left alone: `classifyTransport` (`diagnostics/connection-path.ts`) checks `/webrtc` **before** `/p2p-circuit`, so an open `…/p2p-circuit/webrtc` connection reads `direct` — the opposite answer to `addrKind`'s, on purpose and already right; `circuitMultiaddrs` (`relay-reservation.ts`) answers "is a reservation held", which a WebRTC address also evidences; `dialOnce` (`member-redemption.ts`) must keep its caller's order. Also confirmed `strand-formation-protocol.ts` already drops WebRTC addresses when a machine published anything else, and `cadre-provider`'s two acknowledged copies of cadre-core logic (`multiaddr-destination.ts`, `node-code.ts`) rank nothing, so they needed no change.

Checked the new import edges for the platform claim they touch: `peer-dial.ts` reaches `@optimystic/db-p2p` through `link-budget.ts`, and both `node-claim-payload.ts` and `peer-record.ts` now import it. Neither module has an `exports` subpath, nothing outside the package deep-imports either, and `./edge-node` — the one other light entry point — imports neither, so the package index loads that graph regardless. The edge is sound and the rewritten header comment is accurate.

Re-derived the invitation arithmetic by hand against the new ranking and confirmed the test's expectation: six slots now spend four on the minting machine (two relayed, two WebRTC) and both of the sibling's two on relayed addresses, against three WebRTC addresses of six before.

`yarn workspace @serfab/cadre-core build`, `yarn typecheck` (all workspaces), `yarn lint` (ESLint + `yarn check:docs`): all clean. `yarn workspace @serfab/cadre-core test`: **200 files, 2,687 passed, 1 skipped** (the pre-existing skip) on the final run.

## Found and fixed in this pass

**The rename's own reason was not applied to the prose.** `orderSignalingFirst` was renamed because "signaling first" became actively wrong — a WebRTC address *is* a signaling address and now goes last — but about a dozen comments still stated the old order, including three that are contract documentation for published shapes: `PeerAddressRecord.addrs` ("Current dialable multiaddrs, signaling (`/p2p-circuit`) first"), `StrandAddrResponse.multiaddrs`, and `CadreNode.resolvePeerAddrs`'s own doc ("Survivors are returned signaling (`/p2p-circuit`) first"). Also stale: `collectSelfAddrs`'s caller in `registerSelf`, `unionAddrs`, three sites in `strand-addr-protocol.ts`, `strand-formation-protocol.ts`'s wire normalizer, three in `strand-wake-protocol.ts` (one of which the implementer fixed in its sibling copy and missed here), and the `CadrePeer.Multiaddr` column comment in **both** hand-maintained schema copies (`control-schema.ts` and `schemas/control.qsql` — `control-schema-drift.spec.ts` compares them textually, and Quereus hashes the declaration with comments stripped, so the shipped v4 fixture is unaffected and stays frozen). All now say "relayed first, WebRTC last". Test prose carrying the same stale vocabulary was brought to one wording too, in `cadre-core` and in `push-wake-e2e.integration.ts`.

**`CadreInvitationReach`'s `'anywhere'` doc did not mention the kind the change added to it.** The change makes a WebRTC address count as `anywhere`, which is a real widening of a public, UI-facing enum (`reference-app-rn`, `reference-app-web` and `cadre-cli` all render warnings off it). The enum member now says a WebRTC address counts, why (its relay carries the signalling from any network), and that whether ICE then finds a path is a separate matter — the caveat the implementer put only on `cadreInvitationReach` itself. The classification is right: these three answers are about network scope, and the ranking means a WebRTC address takes a slot only once every relayed address of its machine has one.

**`docs/network/relay.md` overclaimed the wake.** "A wake applies it at its own dial too, so neither of its two attempts can go to a WebRTC address" is false for a target that published nothing else — `webrtcLast` reorders, it does not drop. Now: "so a WebRTC address takes one of its two attempts only when the target published nothing else."

**The doc's "Limits and accepted tradeoffs" section lost a limit that is still real.** The implement ticket said to delete the bullet about callers that fix the dial order and that nothing replaces it, but the implementer then found — and parked as a code `NOTE:` — that an invitation's ranking is per machine, so the minting machine's WebRTC address can still stand ahead of a sibling's relayed one and cost a redeemer about 23 s when the minting machine is down. With the paragraph above it now claiming the rule "holds at every site", the doc needed to say that. One bullet added, stating what was declined, why (the machine order carries information an address-kind sort would discard) and the revisit condition. The code `NOTE:` stays; the doc bullet is where a reader of the model meets it. Both are inside the size budget — that paragraph is now 118 words of its 120, so a reviewer adding to it will need to split it.

**`firstRelayedAddr`'s second condition read as a leftover.** The implementer flagged it for judgment: `addr.includes('/p2p-circuit/') && isSignalingAddr(addr)` reads like a redundant restatement of the predicate beside it, in a module that had just deleted its `SIGNALING_PREFIX` substring test for exactly that reason. It is not redundant — it is what skips an address ending AT its hop, which `addrKindOf` calls `relayed` like any other — so it is now a named `continuesPastItsHop` with a comment saying why the classification cannot answer it. Behaviour unchanged.

**One test restated its own expectation.** The invitation case's `expect(members.filter((addr) => addr.includes('/webrtc/'))).toHaveLength(2)` is strictly implied by the `toEqual` two lines above it. Cut; its sentence moved into the leading comment, where it reads as guidance for the expected array rather than as a second assertion.

## Found, and added one test for

**`webrtcLast` inside `dialWake` — the one arm that deviated from the implement ticket — had no coverage at all**, while `WAKE_DIAL_ATTEMPTS`'s comment and `docs/network/relay.md` both now promise it. `dialWake` is exported from the package index, so the invariant belongs at the budget-owning site rather than relying on its one in-repo caller passing an ordered list; that part of the implementer's judgment is kept. But the deviation has two halves, and both are the kind a later "unification" with `directBeforeRelayed` would silently invert. One case in `strand-wake-protocol.spec.ts` pins both from a recorded dial order: given the addresses in the order a machine listening on `/webrtc` reports them, the WebRTC address is tried last **and** the relayed address stays ahead of the direct one. No other test was added — the rest of the change is in pure predicates the three implement-stage cases already pin directly.

## Found, and recorded rather than ticketed

Nothing. The per-machine invitation residual the implementer parked as a `NOTE:` was re-read and kept as parked, now with the matching doc bullet (above). The pre-existing accepted-tradeoff `NOTE:` about the QR-code cap stays declined: only its arithmetic changed, and its revisit condition (redemptions failing for want of a sibling address the record held) has not tripped.

Two things the handoff asked a reviewer to look at were examined and need nothing: `classifyComponents` keeping its `CODE_P2P_CIRCUIT` import is correct, because `destinationIn` asks a different question (where does this address terminate) of the same components; and `webrtcLast` classifying each address twice is the same shape as `directBeforeRelayed` beside it, over lists of a handful of addresses — not worth a note of its own.

## Not filed, and why

No tickets. Everything found was a comment, a doc sentence, a predicate's name, one redundant assertion, or one missing test — all fixed in this pass. Nothing reached the filing bar: no finding named a class-level invariant that a type, a property test or a boundary check could retire, and no latent defect was found behind a dormant path.

# Pre-existing failure reported

`cadre-node-owner-grant.spec.ts` → "a member redeeming locally while alone is refused by name, before the approval" failed on the first full-package run (`Timed out waiting for the member to be alone`, the 15 s `pollUntil` at line 200), and then failed again **in isolation** — which `tickets/.pre-existing-known.md` had recorded as impossible for this fingerprint ("passed 1 of 1 alone", one-off, 2026-11-21, seen during the `relayed-connections-try-a-webrtc-upgrade` implement pass, i.e. before this ticket's implement commit). It then passed twice, in isolation and in a second full run. Four samples: fail, fail, pass, pass.

It is not this ticket's: the spec exercises FRET cohort settling after a joiner stops, nothing in the implement commit or this review pass touches cohort membership or connection teardown, and this review pass changed only comments, one schema column comment, the doc, test prose and one unit test in another file. The isolated reproduction is new information the known-failures record does not have, so it is written to `tickets/.pre-existing-error.md` for the triage pass, with the four runs and the record's own next step (measure how long "alone" takes to settle before touching the poll). Nothing was skipped, disabled or loosened.
