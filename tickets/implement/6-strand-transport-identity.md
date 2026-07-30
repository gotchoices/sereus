description: A device's group-chat connection and its main connection currently announce themselves under the same name, so a shared relay server cannot tell them apart and delivers messages to the wrong one. Give each group its own network name so both stay reachable through one relay.
prereq:
files: packages/cadre-core/src/cadre-node.ts (launchStrand ~L2747-2772 — `privateKey: this.identityKey`), packages/cadre-core/src/strand-instance-manager.ts (buildStrandRuntime ~L238-281 — `...(config.privateKey && { privateKey: config.privateKey })`), packages/cadre-core/src/ed25519-key.ts (Ed25519 seed/keypair bridge helpers), packages/cadre-core/src/strand-addr-protocol.ts (L1-27 doc comment asserts the shared peerId — must be rewritten), packages/cadre-core/src/strand-cohort.ts (L44-49 doc — "dialing it reaches the remote's control instance"), packages/cadre-core/src/membership-connection-gater.ts (why control-only gating is correct), docs/architecture.md (L491, L670), docs/strands.md (L85), tickets/backlog/strand-network-nat-relay-reachability.md
difficulty: hard
----

# Give every strand node its own libp2p transport identity

Closes the externally-reported bug **https://github.com/gotchoices/sereus/issues/1**.

## The bug, reproduced

A `CadreNode` runs its control node (`control-<partyId>`) and **every** strand node
(`strand-<strandId>`) as separate libp2p instances that are handed the *same* private key —
`launchStrand` passes `privateKey: this.identityKey` (`cadre-node.ts` ~L2764) and
`buildStrandRuntime` forwards it verbatim to `createLibp2pNode`
(`strand-instance-manager.ts` ~L277). Same key ⇒ same peerId.

`@libp2p/circuit-relay-v2` keys everything about a client by peerId:

- `server/reservation-store.js` `reserve()` — one entry per peer; a second reservation for the
  same peerId **refreshes** the first rather than adding a second.
- `server/index.js:230,236` — a hop-connect does
  `connectionManager.getConnections(dstPeer)` then takes `connections[0]`.

So when both nodes reserve through one relay, the relay holds *two* connections under *one*
peerId and always hands relayed streams to the first. Verified on loopback (no NAT) with
`libp2p@3.1.3` / `@libp2p/circuit-relay-v2@4.1.3` as installed here — one relay, two nodes
sharing one generated Ed25519 key, each handling its own protocol, a third node dialing the
shared circuit address:

```
relay connections for shared peerId: 2
  control protocol -> OK
  strand  protocol -> UnsupportedProtocolError: Protocol selection failed - could not negotiate /repro/strand/1.0.0
```

That is the reporter's exact symptom class. Downstream in a real cadre it surfaces as
`UnsupportedProtocolError: … /optimystic/strand-<id>/fret/1.0.0/*`, then
`NoValidAddressesError`, then `strandPeers=0`.

Worse than "one of the two loses": both nodes advertise the **byte-identical** circuit
multiaddr (`<relay>/p2p-circuit/p2p/<sharedPeerId>`), so the strand-address RPC's answer is
indistinguishable from a control address. The careful separation `strand-cohort.ts` L44-49 and
`docs/architecture.md` L491 describe — "never seed the strand mesh from `CadrePeer.Multiaddr`,
dialing it reaches the control instance" — is defeated at the relay regardless of which address
the RPC returns.

Reachable today, not hypothetical: `reference-app-web/src/lib/cadre-web.ts:308` sets
`listenAddrs: ['/p2p-circuit', '/webrtc']` whenever a relay is configured, and both node types
receive that same `network` config.

## Decision: per-strand transport identity (deterministically derived)

Three options were weighed.

**(a) An additive `strandNetwork` override on `CadreNodeConfig`** — the fix the issue proposes.
Rejected as the primary fix: it only helps a consumer who owns a *second* relay to point at, and
the collision returns the moment both nodes reserve through the same one. It is a mitigation for
one deployment shape, not a cure, and it adds permanent config surface. Once (b) lands there is
nothing left for it to mitigate, so **do not add it**.

**(b) Give each strand node its own transport peerId, derived from the identity key + strandId.**
Chosen. See "Why this is safe" below.

**(c) Stop running a libp2p node per strand; multiplex strand protocols onto the control node.**
Rejected. Protocol strings are already namespaced so it would *work*, but it merges two
deliberately separate security domains — the control node composes the fail-closed membership
connection gater plus `authorizeInboundControlStream`, while strand nodes intentionally keep the
raw configured gater because their peers are legitimately cross-party
(`cadre-node.ts` L795-808, `membership-connection-gater.ts` header). It also destroys per-strand
hibernation, which is implemented as "stop that strand's libp2p node"
(`handleStrandHibernate` → `quiesceStrand`). Far larger blast radius for the same outcome.

### Why (b) is safe — the issue's objection does not hold on the strand side

The issue argues a distinct strand key is "semantically incorrect" because a peerId *is* the
cadre's authority identity. That is true **on the control side only**, and it was checked
symbol-by-symbol here:

- `ed25519PublicKeyB64FromPeerId` — the peerId → authority-key derivation — is called from
  `cadre-node.ts` L1173/L1342/L2171 (`CadrePeer` row acceptance and self-signing),
  `control-cohort.ts` L85, and `seed-bootstrap.ts` L302/L957. **Every one is a control-network
  path.** No strand-side code derives authority from a peerId.
- Strand-level authority is the **member key**, not the node key: `StrandDatabase` signs with
  the keypair derived from `StrandRow.MemberPrivateKey` (`strand-database.ts` L145-169,
  `strand-member-key.ts`). `strand-database.ts` never reads `libp2pNode.peerId` at all.
- `schemas/strand.qsql` `MemberPeer` (L279+) stores `PeerId` as opaque text and verifies only a
  signature *by the member key* over `digest('Strand.MemberPeer','add',MemberKey,PeerId,StampId)`.
  It never requires `PeerId` to equal anything.
- Nothing in the repo asserts control-peerId equals strand-peerId (grep across all packages).

So the strand node's peerId is already **pure transport**. Changing it removes an implicit,
unverified coupling; it does not weaken an enforced one. The control node keeps the identity key
untouched, so cadre authority, `CadrePeer` rows, owner-key genesis, seed/enrolment and formation
are all unaffected.

Dialability also needs **no** protocol or schema change: `CadreNode.getStrandMultiaddrs`
(`cadre-node.ts` L2817-2822) returns the strand node's own `getMultiaddrs()`, and a multiaddr
already carries the peerId it belongs to. The strand-address RPC therefore starts returning
genuinely distinct, directly-dialable addresses with no wire change.

### Derive, don't randomize

Use a deterministic derivation rather than a fresh random key per launch, so a strand's transport
peerId is stable across process restarts (a random key would churn the strand's identity on every
boot, invalidating any peer-store or `MemberPeer` record that ever names it):

```
strandTransportKey(identityKey, strandId) =
    generateKeyPairFromSeed('Ed25519',
        digest(['sereus.strand-transport-key.v1', <identity 32-byte seed, base64url>, strandId],
               'sha256', 'bytes'))
```

`generateKeyPairFromSeed` comes from `@libp2p/crypto/keys`; `digest` from
`@optimystic/quereus-plugin-crypto` (both already direct dependencies of `cadre-core`). The
identity *private* seed is an input, so no third party can enumerate a member's strand peerIds
from public data. Extract the seed with the existing `ed25519KeyPairFromLibp2p` idiom in
`ed25519-key.ts` (libp2p Ed25519 `raw` is `seed(32) || public(32)`).

Validated on loopback against the same relay topology as the bug repro:

```
derivation stable across calls   : true
distinct per strandId            : true
distinct from control peerId     : true
control via control addr -> OK
strand  via strand  addr -> OK
VERDICT: FIX SHAPE WORKS — both nodes reachable through ONE shared relay
```

## Where the derivation belongs

Derive in `CadreNode.launchStrand`, where both the identity key and the strand id are in hand,
and pass the derived key as `startStrand({ privateKey })`. `StrandInstanceManager` then needs no
change — it already forwards `config.privateKey`, and `resumeStrand` rebuilds from the retained
`launchConfig`, so a hibernate→wake cycle reuses the same derived key automatically
(`strand-instance-manager.ts` L378-410). Keep the derivation helper in its own small module so it
is unit-testable without a node.

## What cannot be proven in this ticket

The real-network integration scenarios are **all** red at HEAD for an unrelated reason tracked in
`blocked/control-db-convergence-optimystic-p2p` / `bug-control-db-stale-revision-not-retryable`
and registered in `tickets/.pre-existing-known.md`. Do not adopt those failures, and do not treat
a red suite as evidence about this change. Verify at unit level plus a purpose-built loopback
relay test instead, and say plainly in the review handoff that end-to-end strand-over-relay was
not exercised. `packages/integration-tests` imports `@serfab/cadre-core` through `dist/`, so
rebuild before believing any integration result at all.

## Tripwires to record in code, not as tickets

- **Unattested strand transport peerIds.** Nothing on the strand mesh gates admission by peerId
  today (strand nodes keep the raw configured gater by design), so an unbound transport peerId
  breaks nothing. If strand-mesh admission control is ever added, the binding it needs is a
  `MemberPeer(MemberKey, PeerId)` row — the table and its self-signed `Authorized` constraint
  already exist; production code simply never writes one. Note this at the derivation site.
- **Shared fixed listen port.** Both node types receive the same `network.listenAddrs`, and
  `cadre-cli/example.cadre.yaml` ships a fixed `/ip4/0.0.0.0/tcp/4001`. Two nodes binding one
  fixed port look like an `EADDRINUSE` waiting to happen. This is pre-existing, orthogonal to
  peerId, and **was not verified** — flag it as a NOTE where the strand node's listen addrs are
  assembled rather than fixing it here.

## TODO

**Phase 1 — derivation**

- Add a `strandTransportKey(identityKey, strandId)` helper (new small module, or alongside
  `ed25519-key.ts`) implementing the domain-separated derivation above; document why the identity
  seed is an input and why the version tag exists.
- Unit-test it: stable across calls, distinct per `strandId`, distinct from the identity peerId,
  and rejects a non-Ed25519 identity key.

**Phase 2 — wire it in**

- In `CadreNode.launchStrand`, replace `privateKey: this.identityKey` with the derived per-strand
  key. Leave `StrandInstanceManager` alone.
- Confirm by reading (not by guessing) that the hibernate → wake path reuses the retained
  `launchConfig.privateKey` and therefore the same derived peerId.
- Add the two `NOTE:` tripwire comments described above.

**Phase 3 — regression test**

- Add a loopback relay test in `packages/cadre-core/test`: one relay, two libp2p nodes, two
  protocols, third node dials each advertised circuit address. Assert both protocols negotiate.
  Assert the same test fails when both nodes share one key, so the test actually pins the bug.
  `@libp2p/identify` is **not** hoisted to the repo root — it resolves only under
  `node_modules/@optimystic/db-p2p/node_modules`. Either build the test nodes through
  `createLibp2pNode` (which supplies identify itself) or add `@libp2p/identify` as an explicit
  dev dependency; a bare `createLibp2p` with `circuitRelayTransport()` throws
  `UnmetServiceDependenciesError`.
- Run `yarn lint` and the `cadre-core` unit suite; stream output with `tee`.

**Phase 4 — docs (the code must not be left contradicting them)**

- Rewrite `strand-addr-protocol.ts` L1-11: it currently states the shared peerId as settled
  design. It becomes "its own transport peerId, derived from the cadre identity key" — and the
  reason the RPC exists gets *stronger*, since a control address is now not even the same peer.
- `docs/architecture.md` L491 and L670, `docs/strands.md` L85: add that a strand node carries its
  own derived transport identity while cadre authority stays on the control node, and that this is
  what lets control and strand nodes share one circuit relay.
- Update `tickets/backlog/strand-network-nat-relay-reachability.md`: its deferred item 1 asks for
  "its own circuit-relay reservation … separately from the control node's reservation". Record
  that the *identity* half is resolved here, and that what remains is verifying a NAT'd strand
  node actually obtains a usable reservation and dialable `/p2p-circuit` address.
- Close https://github.com/gotchoices/sereus/issues/1 with the chosen approach and why the
  proposed `strandNetwork` knob was not taken. **Ask before posting** — commenting on a public
  issue is outward-facing.
