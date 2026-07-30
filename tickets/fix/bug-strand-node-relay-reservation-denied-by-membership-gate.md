----
description: When a machine's private data-sharing session starts up behind a home router, it asks the party's storage machine to forward traffic on its behalf. The storage machine refuses, because the session uses a second network name it has never been told to trust — so the session cannot start at all.
files: packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/membership-connection-gater.ts, packages/cadre-core/src/strand-transport-key.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts, docs/strands.md
difficulty: hard
----

# Strand node's derived transport peerId is denied a circuit-relay reservation by the control node's membership gate

A strand node gets its **own** libp2p transport identity, derived from the cadre identity key +
strandId (`strandTransportKey`, added to fix the shared-relay collision in
[issues/1](https://github.com/gotchoices/sereus/issues/1)). That derived peerId is **unattested** —
nothing in the control DB binds it to the member. When the strand node needs a circuit-relay
reservation, it dials the relay; if the relay is a party **control** node (`enableRelay: true`,
which is the *default for every storage-profile node*), the control node's membership connection
gater sees an unknown peerId and denies the inbound encrypted connection. The reservation stream
dies mid-negotiation and `libp2p.start()` fails outright, so the strand never starts.

`strand-transport-key.ts` already reasons about this and concludes the derived peerId being
unattested "breaks nothing", because *strand-mesh* nodes keep the raw configured gater. That
reasoning misses this path: the reservation is made against a **control** node, which does have the
membership gater.

## Failing test

```
packages/integration-tests/src/scenarios/push-wake-e2e.integration.ts
  > E2E push-wake over the control network
  > delivers a wake to a NAT'd receiver over a circuit-relay (signaling-first) dial
```

Reproduces **deterministically** at HEAD, both alone (`-t "circuit-relay"`) and in whole-file runs.
Not resource contention, not build drift (`src`/`dist` mtimes verified fresh for every `link:`ed
`../optimystic` + `../quereus` package before triage).

## Error output

```
UnsupportedListenAddressesError: Some configured addresses failed to be listened on, ...

  /ip4/127.0.0.1/tcp/<port>/ws/p2p/<L>/p2p-circuit: UnexpectedEOFError: Unexpected EOF - stream closed while reading 0/1 bytes
      at ReservationStore.#createReservation (@libp2p/circuit-relay-v2/dist/src/transport/reservation-store.js:279)
      at DefaultTransportManager.listen (libp2p/src/transport-manager.ts:318)
      at Libp2p.start (libp2p/src/libp2p.ts:236)
      at createLibp2pNodeBase (../optimystic/packages/db-p2p/src/libp2p-node-base.ts:682)
      at StrandInstanceManager.buildStrandRuntime (packages/cadre-core/src/strand-instance-manager.ts:262)
```

Thrown from `Rx.addStrand(...)` at `push-wake-e2e.integration.ts:477`.

## Root cause — confirmed, not hypothesised

Two independent confirmations:

1. **Rx's *control* node reserves on the same relay successfully.** The test's assertion at
   `push-wake-e2e.integration.ts:459-460` ("Rx's circuit-relay reservation appears", matching the
   constructed `rxCircuitAddr`) **passes**. Failure comes later, at `addStrand`. Same relay, same
   transport, same code path — the only difference is that the control node's peerId is an
   authorized `CadrePeer` on L and the strand node's derived peerId is not.

2. **Suspending stranger denial makes the test pass.** Inserting
   `L.openEnrollmentWindow(Date.now() + 120_000)` immediately before `Rx.addStrand(...)` — the one
   in-memory carve-out in `CadreNode.admitInboundControlConnection` that bypasses the
   authorized-member check — turns the failure into a clean pass (verified in a throwaway copy of
   the scenario, since deleted). Nothing else was changed.

So: `admitInboundControlConnection` (`cadre-node.ts:866`) returns false for the strand node's
derived peerId — no unconditional admit (L is running, anchor non-empty, strand peer is not
configured bootstrap infra), no enrollment window, non-empty authorized set that does not contain
it, no outstanding formation invitation — and the gater refuses the connection carrying the relay
`hop` reservation.

## Suspect files

- `packages/cadre-core/src/cadre-node.ts:866` — `admitInboundControlConnection`, the deny decision.
- `packages/cadre-core/src/cadre-node.ts:921` — `admitControlPeerUnconditionally`; also
  `cadre-node.ts:772` where `enableRelay` defaults to `profile === 'storage'`.
- `packages/cadre-core/src/membership-connection-gater.ts` — `STRANGER_OPEN_PROTOCOLS` and the
  module doc explaining why per-protocol admission is *not* expressible at this layer.
- `packages/cadre-core/src/strand-transport-key.ts:38-43` — the "unattested, breaks nothing" note
  that needs correcting either way, plus its own pointer at the `MemberPeer(MemberKey, PeerId)`
  binding.
- `packages/cadre-core/src/strand-instance-manager.ts:280-285` — strand nodes inherit the control
  node's `listenAddrs` verbatim (already carries an "Unverified" NOTE about fixed ports); a
  `/p2p-circuit` listen addr is the second instance of that inheritance being wrong-by-default.

## Design constraints

**This needs a design decision, not a mechanical patch.** `docs/strands.md:76-79` lists exactly
this as an open question — *"Can any sereus relay node serve as a relay for anyone? Can a relay
refuse service to unknown nodes?"* Resolve that first; whichever way it lands, update
`docs/strands.md` and the `strand-transport-key.ts` note.

Candidate directions, with the constraint each carries:

- **A. Admit relay-client connections on relay-enabled control nodes.** Matches the gater module's
  own stated policy ("admit the connection whenever a legitimate stranger interaction could be
  riding it; per-stream gates take over"), and the per-stream gates
  (`authorizeInboundControlStream` fail-closed over the materialized snapshot; wake/strand-addr
  `isAuthorizedMember`) are untouched. **But** a connection gater cannot see protocols, so this
  admits *every* stranger connection on any node with `enableRelay` — which is the default for
  every storage-profile node. That converts a party-private relay into an open one and is a
  deliberate **security-posture widening of layer 2**. Do not land it without explicit human
  sign-off recorded here (approver + reason).
- **B. Attest strand transport peerIds in the control DB**, so a party relay admits its own
  members' strand nodes and no one else. Keeps the gate armed and matches the intent that
  `enableRelay` is party infra. This is the thorough fix and is the follow-up
  `strand-transport-key.ts:38-43` already anticipates: the binding it names is a
  `MemberPeer(MemberKey, PeerId)` row, and the table plus its self-signed `Authorized` constraint
  already exist in `schemas/strand.qsql` — production code simply never writes one. Cost: a new
  publish path, replication, and signature verification, plus the relay-side lookup.
- **C. Do not hand strand nodes the control node's `/p2p-circuit` listen addr.** Rejected as a
  root-cause fix: it makes this test pass while leaving genuinely NAT'd strand meshes unreachable.
  Record it as a non-fix so it is not rediscovered.

**Cross-cutting obligations to check before landing:**
- Option B writes a new replicated, signed row → schema/`schemas/strand.qsql` touch, signed-record
  byte format, and a determinism/edition consideration. Confirm whether an edition bump and a
  byte-format vector are required.
- Either option changes admission semantics → extend
  `packages/integration-tests/src/scenarios/control-stream-authz.integration.ts` (or a sibling) so
  the chosen policy is asserted at the connection layer, not only proven by this scenario passing.
- The fix must keep the layer-2/layer-1 split honest: the per-stream fail-closed gate must still
  deny a relay-admitted stranger's `repo`/`sync`/wake/strand-addr streams. Assert that explicitly.
