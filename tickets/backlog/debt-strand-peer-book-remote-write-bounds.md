description: Any machine connected to one of ours on a shared workspace can, with one message, replace every address we remember for the workspace's real members with addresses for made-up ones, and can repeat that message as often as it likes. Bound what a remote message may change in the address book and how often it may arrive.
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-peer-book.ts (evictPastCap, strandPeerFreshness), packages/cadre-core/src/strand-peer-book-protocol.ts (StrandPeerBookService.handleStream), packages/cadre-core/src/strand-peer-book-swap.ts (accept), packages/cadre-core/test/strand-peer-book.spec.ts
repro: static
severity: wrong-result
likelihood: contrived
tradeoffs: The book was deliberately declared "nothing here is trust-bearing" because an address grants no authority, and on a closed strand only a member can reach the receiver at all, so a maintainer may accept that a hostile member costs the others a slow launch until they reconnect, and defer this until open strands, where any connected machine can do it, are actually deployed.

# Remote writes to the strand peer book are unbounded in two ways

## What is true today

The strand peer book (`strand-peer-book.ts`) holds at most 16 peers per strand. When a 17th arrives, `evictPastCap` drops the entry with the smallest freshness, where freshness is `max(issuedAt, lastSeenAt)`: the greater of "when the peer itself stamped its statement" and "when this node last held a connection to it".

The signed book swap (`strand-peer-book-protocol.ts`, `/sereus/strand-peers/1.0.0`) lets a connected strand peer send up to 16 self-signed entries, each verified against the peer id it names, with `issuedAt` accepted up to five minutes ahead of the receiver's clock. A forwarded entry is filed with `lastSeenAt: 0`, so its freshness is the signer's stamp alone.

Two consequences, both static reading, neither reproduced against a live node:

- **Eviction of every met peer.** A sender generates 16 throwaway Ed25519 keys, signs an entry for each with `issuedAt` four minutes ahead and any address it likes, and sends the frame once. Each entry verifies (the signer really is the key it names). Each has freshness greater than any real entry, whose freshness is at most "now". The receiver's book now holds the 16 fakes and none of the real members. On its next launch it dials 16 dead addresses, each a relayed dial of up to 14 seconds at the default link, and has no real peer to dial. The book heals only as real peers reconnect, and for the first five minutes even a reconnecting real peer (freshness "now") is the stalest entry and is evicted on arrival. The sender can repeat every few minutes. The module comment's stated worst case, "a junk address costs one failed dial per launch until it ages out", assumed junk is added beside the real entries, not in place of them.
- **No inbound rate bound.** The ten-minute throttle is applied by the client before it dials. The receiver has a concurrency cap (100 streams in flight) and nothing else, so one connected peer can send a frame per round trip indefinitely. Every verified frame costs 16 signature checks and, on the persistent backend, one full snapshot write of the party's whole book per merged entry.

Who can send: on a closed strand, the revocation gate admits only unrevoked members' machines, so the sender is a member of the workspace. On an open strand, anyone who learns the strand node's address and connects.

## What should hold

Proposed invariants, for a maintainer to accept, adjust or decline:

1. **A remote frame never evicts a peer this node has itself connected to.** Eviction should rank entries with `lastSeenAt > 0` (met by this node) above entries with `lastSeenAt === 0` (only ever forwarded), and only then by freshness. Forwarded entries then compete only for the slots met peers do not hold. This is a change to `evictPastCap` in `strand-peer-book.ts` plus one table row in `strand-peer-book.spec.ts`; it does not change what the seed dials, only what survives the cap.
2. **The receiver accepts at most one frame per sender per throttle window, except a fresher statement by the sender about itself.** The client-side throttle has a legitimate exemption (a re-sign after an address change), so the receiver should mirror it: within the window, merge the sender's own entry if its `issuedAt` is greater than the one held, and ignore the rest of the frame. The state is a per-peer timestamp in `StrandPeerBookSwap.accept`, the same shape as the client's `exchangedAt`.
3. Optionally, tighten the forward-skew allowance from five minutes to something that still covers honest clocks, so a forwarded entry cannot outrank a live connection by much even before rule 1. Rule 1 makes this a refinement rather than a fix.

The eviction ordering in `entries()` (freshest first, which is the seed's dial order) is a separate question and should stay as is: a signed statement from an hour ago is a better first dial than a connection from three days ago.

## Notes at the sites

`evictPastCap` in `strand-peer-book.ts` and `StrandPeerBookService.handleStream` in `strand-peer-book-protocol.ts` each carry a `NOTE:` pointing here.
