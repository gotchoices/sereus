description: Add a small control-network request/response protocol that lets one of a party's own nodes ask another "what's your current network address for strand X?", so nodes can actually find each other on a strand's separate network.
prereq:
files: packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-wake-protocol.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts
difficulty: medium
----

## Background — the design decision

A strand runs as its **own** libp2p node (`strand-<id>`, random port) that is
*separate* from the control node (`control-<partyId>`), even though both share
the node's peerId (same `config.privateKey`). The cohort seed that bootstraps a
strand node was being derived from `CadrePeer.Multiaddr`, but those rows hold the
**control** node's listen addresses — dialing one reaches the remote's control
libp2p instance, not its strand instance, so the seed never joins the strand
mesh. (See the originating plan ticket `strand-cohort-seed-uses-control-network-addresses`.)

**Key constraint that shapes the fix:** the control network is *single-party* —
`CadrePeer` only ever lists **this party's own cadre nodes** (`docs/architecture.md`
§ "Control Network"). So a CadrePeer-derived strand seed can only ever bootstrap
*your own co-cadre nodes* onto a strand. Cross-party strand bootstrap is a
different mechanism (strand formation / `MemberPeer`) and is **out of scope** here.

**Chosen approach (control-network RPC).** Rather than replicate a new signed
per-strand address table, resolve strand addresses **on demand** over the control
mesh that already connects the party's nodes: a node asks its connected co-cadre
siblings "give me your live strand-`X` multiaddrs" and uses the answers as the
seed. This mirrors the existing push-wake protocol (`/sereus/strand-wake/1.0.0`)
exactly, needs no new schema or signing machinery, and is always fresh.

Alternatives considered and rejected for v1 (documented so the reviewer/human can
revisit): a replicated signed `StrandPeer` table (heavy — duplicates all of
CadrePeer's authority/self-sign/freshness machinery for a same-party concern, and
goes stale); a single multiplexed libp2p node (contradicts the committed
per-strand-node isolation + hibernation model where quiesce == stop the strand's
node); and deferring entirely to a future strand-overlay DHT (leaves the mesh
unseeded today, and the DHT is absent upstream in optimystic `db-p2p`).

**This ticket is the protocol primitive only.** Wiring it into seed derivation is
the follow-up `strand-seed-from-strand-addr-rpc` (which has this as a `prereq:`).

## What to build

A new module `packages/cadre-core/src/strand-addr-protocol.ts`, modeled
**directly** on `strand-wake-protocol.ts` (same file shape, same imports from
`control-stream.ts` and the shared `decodeLengthPrefixedFrame` guard in
`seed-bootstrap.ts`, same 4-byte big-endian length-prefixed JSON framing, same
read-timeout / concurrency-cap hardening).

### Wire types (add to `types.ts`, next to `WakeRequest`/`WakeAck`)

```ts
/** Control-network request: "what are your live multiaddrs for this strand?" */
export interface StrandAddrRequest {
  /** The strand whose strand-network address the requester wants to seed from. */
  strandId: string;
}

/** Control-network response carrying the responder's strand-node multiaddrs. */
export interface StrandAddrResponse {
  strandId: string;
  /** Dialable strand-network multiaddr strings (signaling/`p2p-circuit` first);
   *  empty when the responder does not currently run that strand. */
  multiaddrs: string[];
}
```

### Protocol id

```ts
export const STRAND_ADDR_PROTOCOL = '/sereus/strand-addr/1.0.0';
```

### Receiver — `StrandAddrService`

Mirror `StrandWakeService`:
- Constructor takes injected deps: `isMember(remotePeerId): Promise<boolean>`,
  and `getStrandMultiaddrs(strandId): string[]` (returns the local strand
  instance's `libp2pNode.getMultiaddrs()` ordered signaling-first, or `[]` when
  the strand is not running / has no live node). Keep the seam injectable so the
  decision logic is unit-testable without a full node (as wake does).
- `initialize(node)` registers the handler with **`runOnLimitedConnection: true`**
  (a NAT'd sibling is reached over a circuit-relay "limited" connection — same
  reasoning as wake; without it the inbound stream is refused on exactly the
  connection we need).
- Per inbound `StrandAddrRequest`: gate on `isMember(remotePeerId)` (refuse
  non-members with an empty `multiaddrs`), then reply with the local strand's
  addrs (or `[]`). Apply the same concurrency cap + read timeout + malformed-frame
  guards as wake; report failures as an empty response, never a hung/dropped
  stream.
- Expose the decision step as a non-private `processAddrRequest(request, remotePeerId)`
  so the matrix is unit-testable directly (mirrors wake's `processWakeRequest`).
- `shutdown()` unhandles the protocol.

### Client — `collectStrandAddrs(node, peers, strandId, options?)`

A free function mirroring `dialWake`/`sendStrandAddr`:
- Given the control `node`, a list of candidate sibling peers (peerId +
  pre-resolved control addrs, OR reuse already-open control connections — see
  note), and a `strandId`, open `STRAND_ADDR_PROTOCOL` to each (with
  `runOnLimitedConnection: true`), send the request, read the response under a
  per-dial timeout, and return the **deduplicated union** of all returned
  `multiaddrs`. Best-effort per peer: a failed/timed-out sibling is logged and
  skipped, never fatal. Exclude self.
- Prefer dialing **by peerId over the existing control connection** when one is
  already open (the wiring ticket passes connected siblings), falling back to
  explicit addrs; this avoids re-resolving control addresses for a sibling we're
  already connected to.

### Export

Add the new module's public surface (`STRAND_ADDR_PROTOCOL`, `StrandAddrService`,
`collectStrandAddrs`, the two wire types) to `packages/cadre-core/src/index.ts`
alongside the wake exports.

## Edge cases & interactions

- **Non-member sender** → refuse (empty `multiaddrs`). The control network is
  single-party so this is defense-in-depth, but keep the gate (parity with wake).
- **Strand not running / hibernating / quiescing mid-request** → `getStrandMultiaddrs`
  returns `[]` (no live `libp2pNode`); respond with empty, never throw.
- **Self** must be excluded by the client (don't RPC yourself, don't seed with
  your own strand addr).
- **Relay / limited connections** — both `handle` (receiver) and `dialProtocol`
  (client) MUST set `runOnLimitedConnection: true`, or a NAT'd sibling reachable
  only via `/p2p-circuit` is unreachable for this exchange.
- **Frame hardening** — reuse `decodeLengthPrefixedFrame`; enforce a small max
  frame size (responses are tiny — a strand id + a few multiaddrs; use a 64KB cap
  like wake), a read timeout (a peer that never half-closes is aborted), and a
  concurrency cap on inbound streams.
- **Address dedup** — union across multiple siblings that may return overlapping
  addrs; preserve signaling-first ordering where practical.
- **Empty result** — no siblings online / none running the strand yet → return
  `[]`. The caller (wiring ticket) treats an empty seed as acceptable; it
  self-heals on the next resume/reconcile pass.
- **Shutdown ordering** — `StrandAddrService.shutdown()` must `unhandle` so a
  stop()→start() cycle does not throw `DuplicateProtocolHandlerError`.

## TODO

- Add `StrandAddrRequest` / `StrandAddrResponse` to `types.ts`.
- Create `strand-addr-protocol.ts` (`STRAND_ADDR_PROTOCOL`, `StrandAddrService`,
  `collectStrandAddrs`, helpers) mirroring `strand-wake-protocol.ts`.
- Export the new surface from `index.ts`.
- Unit tests `test/strand-addr-protocol.spec.ts` (reuse the stream doubles in
  `test/wake-stream-helpers.ts`):
  - member sender + running strand → response carries the strand addrs.
  - non-member sender → empty `multiaddrs`.
  - strand not running locally → empty `multiaddrs`.
  - malformed / oversized frame and read-timeout → graceful empty/aborted, no hang.
  - `collectStrandAddrs` unions + dedupes across siblings, skips a throwing
    sibling, excludes self, returns `[]` when no sibling answers.
- `yarn workspace @serfab/cadre-core build` and run the cadre-core test suite
  (stream output with `tee`); confirm the new spec and existing wake/seed specs pass.
