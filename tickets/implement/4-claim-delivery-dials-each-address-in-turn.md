description: When a phone claims a home machine's node from its QR code, one address that never answers can use up the whole time allowed, so the address that would have worked is never tried. Make seed delivery try each address in turn with its own time limit, and report "could not reach the node" as its own kind of failure.
architecture: docs/architecture.md#which-side-dials-the-add-a-node-flows-compared
files: packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-dial.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/cadre-node-dial-past-dead-addresses.spec.ts, packages/cadre-core/test/silent-server.ts, docs/architecture.md, docs/api.md
difficulty: medium
----

# Seed delivery dials each address in turn

## The problem

`CadreNode.claimNode` (`cadre-node.ts`, near line 8251) hands the node's whole address list from the QR code to `SeedBootstrapService.deliverSeed` (`seed-bootstrap.ts`, near line 1033). For the `{ peerId, multiaddrs }` form, `resolveDeliveryTarget` (near line 187) merges the addresses into the peer store and `sendSeed` calls `node.dialProtocol(peerId, SEED_PROTOCOL)` under one deadline, `seedDeliverTimeoutMs` (28.5 s at the default declared link round trip, `relayedRequestBudgetMs`).

That is the one-big-dial shape `one-dead-address-starves-the-peer-dial` removed from every other control dial: libp2p tries the addresses one after another and its per-address limit (`addressDialTimeout`, 39 s at the default, `optimysticDialLimits`) is longer than the whole delivery deadline. So the first address that silently drops the connection attempt spends the deadline, and nothing after it is tried.

The QR payload lists the node's public addresses first, then its LAN addresses (`packages/cadre-host/src/hosted/claim-details.ts`). A phone at home whose router does not loop a connection to its own public address back inside the network (many home routers drop it without answering) therefore never reaches the LAN address, and the claim fails after 28.5 s. Read from the code (`repro: static`); not yet seen on a device, because no phone app claims yet (`rn-app-joins-host-node-by-qr` is next).

## The change

In `SeedBootstrapService.deliverSeed`, for the `{ peerId, multiaddrs }` form:

1. **Open the connection first, outside the request deadline.** If the control node already holds an open connection to `peerId`, use it. Otherwise, with a non-empty address list, parse the addresses and call `dialPeerAddrs(node, addrs, this.dialBudget, \`Seed delivery to ${peerId}\`)` (`peer-dial.ts`): each address gets its own limit (21.5 s at the default), the whole peer gets `dialBudget.totalMs` (86 s), direct addresses go before relayed ones and the given order is otherwise kept, so the payload's public-then-LAN order is the order tried. Keep the peer-store merge, so identify and later dials still see the addresses.
2. **Then the request under `seedDeliverTimeoutMs`,** on a stream opened from that connection (`connection.newStream(SEED_PROTOCOL, { signal })`), not a second `dialProtocol(peerId)`. `exchangeFrame` and the ack read stay as they are.
3. **Empty address list:** keep today's behaviour (dial by peer id, which uses an existing connection or the peer store's addresses).
4. **The single-multiaddr string form is unchanged:** one address cannot starve another.

**A typed failure for "never reached".** When the connection phase fails (every address failed, the total budget ran out, or `SelfRelayOnlyError`), throw a new `PeerUnreachableError` with `peerId` and `cause` set to the error `dialPeerAddrs` threw (it already names every address and why each failed). Export it from the package root beside `ClaimRefusedError`. A phone needs this to tell "this phone could not reach the node at all" from "the node was reached and then something else failed"; parsing libp2p's error text for that would be guesswork. Put the class in `peer-dial.ts` if it reads naturally there, since it describes a peer dial, not a seed.

`claimNode` then has three outcomes its callers can tell apart, and its doc comment says so: `ClaimRefusedError` (reached, refused, with the node's code), `PeerUnreachableError` (never reached; nothing was sent), anything else (reached, the exchange or a local step failed; repeating the claim with the same code is safe because the claim is idempotent for the same owner).

**Time.** A delivery can now take up to `dialBudget.totalMs` plus `seedDeliverTimeoutMs` (114.5 s at the defaults) when every address is dead, instead of 28.5 s. The callers of the object form are `claimNode` and `CadreNode.deliverSeed`'s pass-through; no cadre-cli, cadre-host or provider code calls either in `src/` (checked with `grep -rn "deliverSeed(" packages/*/src`). The integration harness's `cadre-invite.ts` and the cross-network scenario use the string form, which is unchanged.

## Edge cases & interactions

- **An already-open connection to the node** (a re-claim after a lost answer, while the first connection is still up): used as is, no dial. By inspection.
- **The connection closes between the dial and `newStream`** (a node restarting): `newStream` throws, which is the "anything else" outcome, not `PeerUnreachableError`, because the node was reached. By inspection.
- **Addresses that do not parse:** `decodeNodeClaimPayload` already refuses them before a phone gets here; for other callers, a parse failure is a caller error and should throw plainly (not `PeerUnreachableError`). By inspection.
- **Addresses for a transport the phone lacks** (the payload's TCP addresses on a WebSocket-only phone): `dialPeerAddrs` rejects each at once without touching the network (its own doc comment says so). No filtering needed here.
- **The delivery's `signal` and the dial's limits are separate:** the connection phase has no caller signal today (`deliverSeed` takes none); do not add one in this ticket.
- **Inbound side unchanged:** `handleSeedStream` and the claim trust policy are not touched.

## Test

One real-libp2p case in `test/cadre-node-dial-past-dead-addresses.spec.ts` (it already has the silent loopback servers from `silent-server.ts` and small per-address and per-peer budgets): a `deliverSeed` (or `claimNode`) to a target whose address list starts with two silent addresses and ends with the working one gets its answer, within roughly two per-address limits; and a second case where every address is silent rejects with `PeerUnreachableError` naming the peer. The first is the reproduction of the defect; the second pins the error type the phone app branches on. The receiving side needs to answer the seed protocol: a `CadreNode` started with a claim secret (see `cadre-node-claim.spec.ts` for how one is built) and a real `claimNode` call is the closest to the real use; a plain libp2p node with a hand-written seed handler that writes an ack is acceptable if the `CadreNode` setup is much heavier. Whichever, do not mock `SeedBootstrapService`.

## Docs

- `docs/architecture.md` → "Dial limits, and why addresses are dialed one at a time" (near line 301) lists where `dialPeerAddrs` is used; add seed delivery to a peer id with addresses. The link-budget paragraph near line 1604 says the seed-delivery deadline covers "a relayed dial plus one request"; it now covers the request on an open connection, with the dial bounded by the per-peer dial budget. Fix that sentence.
- `docs/api.md`: wherever `claimNode` / `deliverSeed` are described, name `PeerUnreachableError`.

## TODO

- Split `deliverSeed`'s object form into a connection phase (`dialPeerAddrs`, or an existing connection) and a request phase (`newStream` under `seedDeliverTimeoutMs`).
- Add and export `PeerUnreachableError`; wrap connection-phase failures in it.
- Update `claimNode`'s and `deliverSeed`'s doc comments with the three outcomes and the new worst-case time.
- Add the two spec cases above.
- Update docs/architecture.md and docs/api.md.
- `yarn workspace @serfab/cadre-core typecheck`, `test` (the touched specs, then the full suite), `build`; `yarn lint`; then `yarn workspace @serfab/integration-tests test cadre-host-join-by-qr` and `node-claim-by-phone` against the rebuilt cadre-core.
