description: Machines in a shared workspace keep only the addresses they happened to learn, so a machine whose address changes, or a third person who joined later, cannot be found. When two workspace members connect, have them exchange signed, time-stamped address books and keep whichever entry is fresher.
prereq: strand-peer-book-local
architecture: docs/architecture.md#strand-address-resolution
files: packages/cadre-core/src/strand-peer-book.ts, packages/cadre-core/src/strand-peer-book-protocol.ts, packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-peer-book-protocol.spec.ts, packages/cadre-core/test/strand-peer-book.spec.ts, docs/strands.md, docs/architecture.md
difficulty: hard
----

## Why

Maintainer decision (2026-09-27), item 2. With `strand-peer-book-local` a machine remembers the peers it connected to. That still leaves two gaps: **rotation** (a party whose relay reservation or address changes is known to others only by its old address until they happen to reconnect) and **third parties** (in a strand with three or more parties, a late joiner has addresses only for the party that invited it). Swapping books when two members connect closes both: every member carries its own current address, signed, and forwards the freshest signed entry it holds for everyone else.

## Design

### Whose signature, and why

Each entry is signed by **the peer's own strand transport key** (`strand-transport-key.ts`; the strand libp2p node's `privateKey`), over the canonical JSON (`canonical-json.ts`) of `{ v: 1, strandId, peerId, addrs, issuedAt }`. Verification needs no key exchange: an Ed25519 libp2p peer id embeds its public key (`peerIdFromString(peerId).publicKey`), so any receiver checks that the entry for peer X was signed by X.

Not the strand member key, for four reasons, all of which go in the module comment: (1) open strands have no shared member key, and the book must work for them; (2) a member-key signature proves only "some member said this", so any member could forge another member's address and cost every peer a 14 s relayed dial per launch, while a self-signature is a claim only the named peer can make; (3) on a closed strand the member key is shared by every machine of a party, so it cannot identify a machine anyway; (4) membership is a separate question, judged at the connection by the revocation gate today and the future allowlist (`feat-strand-member-allowlist-admission`), and this protocol rides that gate. The book therefore proves "this peer's own claim about where it is", never "this peer is a member"; write that sentence down.

### Own entry

Each running strand node keeps its own signed entry current: built from `getStrandMultiaddrs(strandId)` (already bound and signaling-first), `issuedAt: Date.now()`, signed with the transport key; stored in the book under its own peer id (exempt from aging and from the seed flattening, which already skips self). Re-signed when the address set changes: subscribe to the strand node's `self:peer:update` (the same trigger `CadreNode.registerSelf` uses on the control node) with a short debounce, since a relay reservation landing fires it more than once; and on launch/resume once the first relay attempts have settled. An unchanged address set is not re-signed on a timer. Freshness is about change, and a periodic re-sign would only make every peer rewrite its slot.

### Protocol

`/sereus/strand-peers/1.0.0` on the **strand** libp2p node, modeled on `strand-addr-protocol.ts` (length-prefixed JSON frames, `control-stream.ts` primitives, one request → one response per stream, read timeout and concurrency cap, 64 KiB frame cap). Request `{ strandId, entries: SignedEntry[] }` (the sender's book: its own entry plus every signed entry it holds; unsigned observed or formation entries are never sent); response the same shape from the other side. `SignedEntry` is `StrandPeerEntry` without `lastSeenAt`. Cap entries per frame at `MAX_STRAND_PEERS`; a frame naming a different `strandId` than the network it arrived on is refused.

Receiver: verify each entry (peer id parses and is Ed25519, addrs attribute to that peer id, `issuedAt` not more than 5 minutes ahead of local now, signature valid); drop the rest individually with a debug log, never the whole frame; `merge` the survivors. The store's rule already prefers a signed entry over an unsigned one and the greater `issuedAt` between two signed, and never lowers `lastSeenAt`. Then answer with the local book. Registered through `node.handle`, so on a closed strand it passes through `authorizeInboundStream` (the revocation gate): a revoked machine cannot push addresses into anyone's book.

Client: when a strand peer is identified (the same `peer:identify` + `speaksBlockTransfer` hook `strand-peer-book-local` added), dial the protocol on that connection and merge the response the same way. Both sides do this, so one connection produces two small exchanges; acceptable, and simpler than electing an initiator. Throttle to one exchange per (strand, peer) per 10 minutes, and skip a peer that does not list the protocol in its identify (an older node); a failed exchange is logged, never fatal, and never retried before the throttle expires. Also exchange once on an own-entry re-sign, with every currently connected strand peer, so a rotation propagates while connections are up.

### Reads

No change: the seed and refresh flatten the book freshest-first, so a received signed entry for a third party is dialed like any other, and a rotated peer's newer self-signed addresses displace its stale ones.

## Edge cases & interactions

- **Clock skew.** `issuedAt` is compared only between entries from the same signer, so skew between machines is harmless; a far-future stamp would pin an entry forever, hence the 5-minute ceiling (reject, log). Aging uses `max(issuedAt, lastSeenAt)`, mixing the signer's clock and the receiver's; a signer far in the past ages out fast, which is the right failure. One case in the protocol test.
- **A member forwards a stale entry for peer X while X's fresher entry is already local.** Store rule keeps the fresher; add the row to the merge-rule table in `strand-peer-book.spec.ts`.
- **A peer forwards an entry it fabricated for X.** Signature fails; dropped. Test.
- **A peer forwards its own genuine entry with an empty address list** (it lost its reservation). Accept and store it: an empty list is a truthful "not reachable now" and displaces a stale reachable list, which is what saves the 14 s. The seed simply has nothing for that peer until the next swap. Inspection plus a row in the table.
- **Relayed connection, limited stream.** The strand's data protocols already run over relayed connections; set `runOnLimitedConnection: true` on the handler and the dial like the strand-addr client does over circuits. Verified by `blind-relay-phone-to-phone-e2e` staying green with the swap happening (assert, in that scenario or the restart scenario, that each side's book holds a signed entry for the other after connection).
- **Third party.** A, B, C in one strand; C joined via A, never met B. After the C↔A swap, C holds B's signed entry and dials B. A unit test on two `MemoryStrandPeerBookStore`s exchanging through the protocol handler in-process (`duplexPair` from `wake-stream-helpers.ts`, as `strand-addr-protocol.spec.ts` does) covers the forwarding; the scenario ticket may add a live three-party arm if time allows.
- **Open strands.** No member key involved anywhere; the protocol runs unchanged. Inspection.
- **Revoked peer.** Its inbound streams are denied by `authorizeInboundStream` on a closed strand; our outbound dial to it is prevented by the revocation connection gater. Its last signed entry ages out. Inspection of the gate sites; no test.
- **Hibernation.** No live node, no swap; wake re-arms the handler and the listeners with the rebuilt runtime, released in `releaseRuntime`. Inspection for symmetry.
- **Frame bounds.** 64 KiB and 16 entries × 16 addrs × about 150 bytes is roughly 38 KiB worst case; tighten the entry cap rather than raising the frame cap if the arithmetic changes. Assertion at the encoder.

## Tests

- `strand-peer-book-protocol.spec.ts`: one round trip between two in-process handlers (each side ends up holding the other's signed entry plus a third party's forwarded entry); one verification test covering tampered addrs, wrong signer, and future `issuedAt` (three inputs, one behaviour: dropped individually, siblings kept).
- Extend the merge-rule table in `strand-peer-book.spec.ts` with the signed rows named above.
- Own-entry re-sign on `self:peer:update`: inspection plus the restart scenario if it grows a rotation arm; otherwise state it as unproven in the handoff.

## Docs

- `docs/architecture.md` → "Strand-Address Resolution": a bullet for the swap protocol (id, trigger, throttle, what is signed and by which key, why not the member key, what the book proves and does not).
- `docs/strands.md`: close the "Never refreshed" limit; state that the in-strand registry (`Strand.MemberPeer` carrying addresses) remains a possible later step only if a case needs addresses to reach members that are offline, and record that as the accepted design boundary; update the "remaining open question" paragraph.
- `.release-notes.pending.md` bullet.

## TODO

- Signing/verification helpers and the own-entry lifecycle (build, sign, re-sign on `self:peer:update` with debounce, store under self).
- Protocol module: service (receiver), client, frame caps, timeouts; registration and release with the strand runtime.
- Trigger the exchange on identified strand peers and on own re-sign; throttle.
- Tests; `yarn workspace @serfab/cadre-core test`, `yarn lint`, `yarn typecheck`; integration `strand-formation-cross-party-seed`, `blind-relay-phone-to-phone-e2e`, `strand-circuit-same-party-e2e` in the foreground, with a book assertion added to one of them.
- Docs and release note.
