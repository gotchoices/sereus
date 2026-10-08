description: When a phone claims a home machine's node from its QR code, seed delivery now tries each of the node's addresses in turn with its own time limit, so one address that never answers no longer uses up the whole time allowed, and "could not reach the node" is reported as its own kind of failure.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/claim-proof.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, docs/architecture.md, docs/api.md
----

# Seed delivery dials each address in turn

## What was built

`SeedBootstrapService.deliverSeed` now splits a delivery to a peer id with addresses (the form `CadreNode.claimNode` uses for a scanned QR code) into two phases:

- **Connection phase, before the deadline.** It reuses an open connection that has no relay limits (the rule libp2p's `findExistingConnection` uses). Otherwise it calls `dialPeerAddrs`, which tries each address on its own limit within the per-peer dial budget. Each address is bound to the target peer id (`withTrailingPeerId`), so the dial checks that it reached the intended node. An address that does not parse, or that names another peer, throws a plain `Error` before anything is merged or dialed. Any dial failure is rethrown as the new `PeerUnreachableError` (`peer-dial.ts`, exported from the package root).
- **Request phase, under `seedDeliverTimeoutMs`.** It opens the stream on that connection, writes the seed and reads the ack.

A multiaddr string, or a peer id with no addresses, still goes through `dialProtocol` inside the deadline.

`claimNode` therefore fails in one of three ways a caller can tell apart: `ClaimRefusedError`, `PeerUnreachableError`, or any other error. With the defaults, the worst case when no address answers is 114.5 s (86 s per-peer dial budget plus 28.5 s request deadline). `docs/architecture.md` and `docs/api.md` describe this.

Tests: `cadre-node-dial-past-dead-addresses.spec.ts` claims a real `CadreNode` past two silent addresses and pins the `PeerUnreachableError` outcome. The implementer confirmed that both tests fail against the old `dialProtocol(peerId)` path. `seed-bootstrap.spec.ts`'s wire-level claim test now asserts that the address dialed is bound to the peer id.

## Review findings

The diff was read in full before the handoff. Commit: `ticket(implement): claim-delivery-dials-each-address-in-turn`.

- **Correctness of the two phases.** Checked `seedStreamOpener`, `connectForDelivery`, `deliveryDialAddrs` and `openUnlimitedConnection` against libp2p 3.3.11's `findExistingConnection`. That function also requires `status === 'open'` and no limits; it prefers direct connections, which does not matter here. Address binding goes through `withTrailingPeerId`, so a relay-form address (`…/p2p-circuit/p2p/<peer>`) is kept and a mismatched trailing peer is rejected. The new behaviour of rejecting a malformed address up front is better than before: previously one bad entry made `mergeSeedPeers` drop the whole peer, and the dial then failed with no addresses. No defects found.
- **Error classification.** `SelfRelayOnlyError`, an exhausted budget and a node stopped mid-dial all become `PeerUnreachableError`. In the stopped case the error is accurate (nothing was sent), even if a UI might word it differently. The downstream ticket `rn-app-joins-host-node-by-qr` already maps these three outcomes.
- **Limited relayed connection counted as "reached".** Conditional: claim codes carry no relay addresses, so `claimNode` cannot hit this today. Recorded as a `NOTE:` tripwire in `connectForDelivery` (`seed-bootstrap.ts`). No ticket.
- **Reused-connection path not unit-tested.** It is a one-line filter that matches libp2p's rule and was checked by reading it. No test added, because it would only exercise wiring.
- **Stale reused connection.** If a reused connection is half-dead, `newStream` fails as "anything else" rather than unreachable. Repeating the claim is safe (it is idempotent), so this was accepted without a note.
- **Tests.** The two new real-network tests are a reproduction and an outcome a phone app branches on, so both meet the bar. The `seed-bootstrap.spec.ts` fake was rewritten to the new libp2p surface and pins the peer-id binding. The claim test's upper timing bound (3 s) includes `authorizePeer`'s local write. It follows the same pattern as the existing drone test, so it was left unchanged. If it flakes under load, loosen it to the per-peer limit: the claim succeeding already shows the regression is absent.
- **Docs.** `docs/architecture.md` (dial-helper callers, sender hardening, claim owner paragraph, link-budget derivation) and `docs/api.md` were read and match the code. The doc comments on `claimNode`, `deliverSeed` and `ClaimRefusedError` were also checked. `docs/cadre-host.md` does not describe the owner-side failure modes, so it needs no change.
- **Hygiene.** The new helpers are small, single-purpose and named. Comments explain why, not what. Nothing to change.
- **Not covered here.** No device run: the phone app's claim lands in `rn-app-joins-host-node-by-qr`.

Validation: `yarn workspace @serfab/cadre-core typecheck` clean; `yarn lint` exit 0; `yarn workspace @serfab/cadre-core test` 158 files, 2400 passed, 1 skipped.
