description: A phone that joins after a party's always-on machines can go ten minutes without learning where the workspace's other machines are, because the machines only re-ask on a ten-minute timer and treat "the other side failed to answer" the same as "the other side has nothing". Reported as gotchoices/sereus#21 and #22.
files: packages/cadre-core/src/cadre-node.ts (refreshStrandPeerAddrs, strandPeerAddrRefreshAt), packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/strand-formation-protocol.ts, packages/cadre-core/test/cadre-node-strand-addr-refresh.spec.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts
repro: static
severity: wrong-result
likelihood: common
----

# Strand-addr refresh blinds late joiners, and the responder reports failures as "no addresses"

Both filed 2026-09-28 by risavian against cadre-core 1.6.0, from the same run as #19 (`fix/1-bug-party-run-relay-caps-every-relayed-connection`). Verified still present in 1.7.0. They change the same code (the throttle stamp and what `collectStrandAddrs` returns), so fix them together.

## #21: the refresh throttle ignores siblings that arrive later

- `strandPeerAddrRefreshAt` is a `Map<strandId, number>` in `cadre-node.ts`. "Due" is time-only, the stamp is written after every pass whatever the answers were, and it is cleared only when a strand stops or is re-formed.
- A phone that enrols after the always-on nodes' pass is not asked for its strand address, and is not sent this node's `delegatePeerId`, for up to `STRAND_PEER_ADDR_REFRESH_MS` (10 min). The report shows the book at `peers=0` for the whole run and 21 `NoValidAddressesError`.
- **1.7.0 made it wider.** `contactAddrs` now comes from the strand peer book, which is persisted and nearly always non-empty, so a pass with no sibling to ask still stamps, including the first tick after a restart before any control connection exists. Peer-book entries reach the libp2p peerStore only on these passes, so swap-forwarded entries wait on the same throttle.

## #22: the responder turns its own failures into an empty answer

- `strand-addr-protocol.ts` replies with `emptyResponse('')` when the concurrency cap is hit and when the request can't be read, and `processAddrRequest` returns empty when its control-DB read fails (e.g. `peers-unreachable`, which a relay reset from #19 can cause). The asker reads only `multiaddrs`, so all of these look like "this sibling has nothing".
- `initialize()` registers its handler with `void node.handle(...)`: a failed registration becomes an unhandled rejection, which kills a Node process. The same pattern is in `strand-wake-protocol.ts`, `seed-bootstrap.ts` and `strand-formation-protocol.ts`. `strand-peer-book-protocol.ts` already does `await node.handle`; copy that.

## Fix

- **Responder:** distinguish "unavailable" from "empty". No backwards compatibility is owed, so make it a required `status` on the response (or abort the stream); don't add an optional field for old readers.
- **Asker:** `collectStrandAddrs` returns which siblings answered, answered empty, or failed.
- **Throttle:** merge the local peer book into the peerStore every tick (local, no RPC). Throttle the RPC per (strand, sibling) rather than per strand, so a newly connected sibling is asked on the next tick. Retry sooner (about a minute) for siblings that failed or answered unavailable.
- **Registration:** await all four `handle` calls, and let a failure reach `start()`.
- Rework `cadre-node-strand-addr-refresh.spec.ts` "keeps the book's cross-party addrs alive when there is no sibling to ask", which pins the old zero-target stamp.

The reporter attached `node:test` files that load `dist/` and pass while the defect exists. Keep their scenarios but write them as vitest cases that pass once fixed, in the two specs named above.

## Tests that matter

- A sibling that connects after a pass is asked on the next tick, not after 10 minutes.
- A responder whose control read throws answers "unavailable", and the asker retries it within the short interval.
- A handler registration that rejects fails `start()` instead of raising an unhandled rejection.

Reply on #21 and #22 after release (maintainer approves the posts).
