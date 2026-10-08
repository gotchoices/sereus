description: When a phone claims a home machine's node from its QR code, seed delivery now tries each of the node's addresses in turn with its own time limit, so one address that never answers no longer uses up the whole time allowed, and "could not reach the node" is reported as its own kind of failure.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/claim-proof.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts, packages/cadre-core/test/seed-bootstrap.spec.ts, docs/architecture.md, docs/api.md
difficulty: medium
----

# Seed delivery dials each address in turn — review handoff

## What was wrong

`SeedBootstrapService.deliverSeed`, given `{ peerId, multiaddrs }` (the form `CadreNode.claimNode` uses for a scanned QR code), merged the addresses into the peer store and called `dialProtocol(peerId)` under the one seed-delivery deadline (28.5 s at the default declared link). libp2p tries those addresses one after another, and its own per-address limit (39 s) is longer than that deadline, so the first address that silently drops the connection attempt spent the whole deadline. The QR payload lists public addresses before LAN ones, so a phone at home behind a router that does not loop its own public address back never reached the LAN address.

## What changed

- **`seed-bootstrap.ts`.** `deliverSeed` now has a connection phase before the deadline and a request phase under it.
  - `seedStreamOpener` decides how the stream will be opened. String form: `dialProtocol(multiaddr)` inside the deadline, unchanged. Peer id with no addresses: `dialProtocol(peerId)` inside the deadline, unchanged. Peer id with addresses: the connection is formed first by `connectForDelivery`, and the stream is `connection.newStream(SEED_PROTOCOL, { signal })` under the deadline.
  - `connectForDelivery` reuses an open, unlimited connection (`openUnlimitedConnection`, the same rule libp2p's `findExistingConnection` applies) or calls `dialPeerAddrs(node, addrs, this.dialBudget, …)`. Any failure there (every address failed, the per-peer budget ran out, or `SelfRelayOnlyError`) is rethrown as `PeerUnreachableError` with the dial error as `cause`.
  - `deliveryDialAddrs` parses each address and binds it to the target peer id (`withTrailingPeerId`). **This goes beyond the ticket:** without it, a bare address handed to `dialPeerAddrs` would connect to whatever peer answers there, and the seed and claim proof would go to it. `dialProtocol(peerId)` used to give that check implicitly. An address that does not parse or names another peer throws a plain `Error` (caller mistake), before anything is merged or dialed.
  - The peer-store merge is kept, so identify and later dials still see the addresses.
- **`peer-dial.ts`.** New `PeerUnreachableError` (`peerId`, `cause`), exported from the package root next to the peer-dial exports. The `index.ts` comment beside `ClaimRefusedError` points to it.
- **`cadre-node.ts`.** The doc comments on `claimNode` and `deliverSeed` now list three outcomes: `ClaimRefusedError` (reached, refused), `PeerUnreachableError` (never reached, nothing sent), and anything else (reached and the exchange failed, or a local step failed, including a malformed secret or address). They also give the new worst case, 114.5 s at the defaults (86 s per-peer dial budget plus the 28.5 s request deadline).
- **Docs.** `docs/architecture.md`:
  - "Other callers of the dial helper" now names seed delivery.
  - The seed-protocol "Sender hardening" item gets a new **Connecting before the deadline** sub-paragraph.
  - The claim "On the node and on the owner" paragraph names `PeerUnreachableError`.
  - The link-budget sentence now says seed delivery's deadline covers only the request when the connection was formed first.

  `docs/api.md` documents `deliverSeed` and `claimNode` with the new error.

## Tests

- `cadre-node-dial-past-dead-addresses.spec.ts` → "reaches the node past two silent addresses and the claim is accepted". A real `CadreNode` started with a claim secret, and a phone-posture owner calling `claimNode` with `[silent, silent, working]`. The test asserts the claim lands, both silent servers were dialed, and the elapsed time is between two per-address limits and two per-address limits plus 2 s of slack. **This is the reproduction:** with the object form temporarily routed back through `dialProtocol(peerId)`, it failed with `Seed delivery … timed out after 28500ms`.
- Same file → "rejects with PeerUnreachableError naming the node when no address answers". It uses a random peer id with two silent addresses and pins the error type and `peerId` that a phone app will branch on. Against the old path it failed too, with a plain timeout `Error`.
- Same file: the existing drone test now shares the new `buildPhoneOwner` / `startAsOwnOwner` helpers. Its assertions are unchanged.
- `seed-bootstrap.spec.ts` → "claims an unclaimed node over the wire". Its fake sender libp2p was written for `dialProtocol(peerId)`, so it now fakes `getConnections` / `dial` / `newStream`. It also asserts that the address dialed is the given one bound to `/p2p/<peerId>`, which pins the peer-id binding.

## Validation run

- `yarn workspace @serfab/cadre-core typecheck`: clean.
- `yarn lint`: exit 0.
- `yarn workspace @serfab/cadre-core test`: 158 files, 2400 passed, 1 skipped.
- `yarn workspace @serfab/cadre-core build`: OK.
- `yarn workspace @serfab/integration-tests test node-claim-by-phone`: 6/6, against the rebuilt cadre-core.
- `yarn workspace @serfab/integration-tests test cadre-host-join-by-qr`: 6/6, against the rebuilt cadre-core.

## Known gaps and judgement calls for the reviewer

- **A limited relayed connection counts as "reached".** Suppose every direct address fails and a `/p2p-circuit` address forms a connection with relay limits. `dialPeerAddrs` returns it, `newStream` then throws libp2p's limited-connection error, and that surfaces as "anything else", not `PeerUnreachableError`, although nothing was sent. QR payloads carry no relay addresses (`claim-details.ts` drops them), so `claimNode` cannot hit this today. It is mentioned in `sendSeed`'s doc comment. Decide whether a limited connection should count as unreachable.
- **Reusing an open connection is not unit-tested.** It was checked by inspection. The re-claim in `node-claim-by-phone` step 5 (56 ms) most likely took that path, but nothing asserts it.
- **The timing assertion covers the whole claim.** The claim test's upper bound includes the work after the ack (`authorizePeer`'s control-database write and the claimed node's acceptance) within 2 s of slack. It is the same pattern as the drone test, and it is the part that could flake on a heavily loaded machine.
- **The default deadline is unchanged.** `seedDeliverTimeoutMs`'s default still budgets a relayed dial plus one request. That is more than the peer-id-with-addresses form now needs, but the string form still dials inside it. The default was kept rather than split.
- **Not seen on a device.** No phone app claims yet (`rn-app-joins-host-node-by-qr` is next), so the home-router case itself has not been observed.
