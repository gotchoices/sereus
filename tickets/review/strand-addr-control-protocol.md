description: Review a newly-added control-network request/response protocol that lets one of a party's own nodes ask a sibling "what's your current network address for strand X?", so nodes can find each other on a strand's separate network.
prereq:
files: packages/cadre-core/src/strand-addr-protocol.ts, packages/cadre-core/src/types.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-addr-protocol.spec.ts, packages/cadre-core/test/wake-stream-helpers.ts, packages/cadre-core/src/strand-wake-protocol.ts, packages/cadre-core/src/control-stream.ts, packages/cadre-core/src/seed-bootstrap.ts, packages/cadre-core/src/peer-record.ts
difficulty: medium
----

## What was built

The control-network **strand-address RPC** primitive — a new module
`packages/cadre-core/src/strand-addr-protocol.ts` modeled directly on
`strand-wake-protocol.ts`. It lets one of a party's own cadre nodes ask a
connected co-cadre sibling "give me your live multiaddrs for strand `X`'s
separate network", and use the union of answers to seed that strand's mesh. This
is the protocol primitive **only**; wiring it into seed derivation is the
follow-up (see "Out of scope / known gaps").

### Surface added

- **Wire types** (`src/types.ts`, next to `WakeRequest`/`WakeAck`):
  - `StrandAddrRequest { strandId: string }`
  - `StrandAddrResponse { strandId: string; multiaddrs: string[] }`
  - Exported automatically via `export * from './types.js'` in `index.ts` (same
    as the wake types — they are intentionally **not** re-listed in the explicit
    export block; re-listing would be a duplicate-export conflict).
- **Protocol id**: `STRAND_ADDR_PROTOCOL = '/sereus/strand-addr/1.0.0'`.
- **Receiver** `StrandAddrService`:
  - Constructor deps: `isMember(remotePeerId): Promise<boolean>` and
    `getStrandMultiaddrs(strandId): string[]` (injected, so the decision logic is
    unit-testable without a node — mirrors wake).
  - `initialize(node)` registers the handler with `runOnLimitedConnection: true`.
  - `processAddrRequest(request, remotePeerId)` is **non-private** (the unit-test
    seam, mirroring wake's `processWakeRequest`): non-member → empty `multiaddrs`;
    member + running → the strand's addrs; member + not running → empty (the
    injected `getStrandMultiaddrs` returns `[]`).
  - `handleStream` applies the same three hardening layers as wake — concurrency
    cap, read timeout, malformed/oversized-frame guard — each reported as an
    **empty** `StrandAddrResponse`, never a hung/dropped stream.
  - `shutdown()` `unhandle`s the protocol (so stop→start does not throw
    `DuplicateProtocolHandlerError`).
- **Client** `collectStrandAddrs(node, peers, strandId, options?)`:
  - `peers: StrandAddrPeer[]` where `StrandAddrPeer = { peerId: string; addrs?: Multiaddr[] }`.
  - Dials each candidate concurrently (`Promise.all` over per-peer best-effort
    dials), **preferring the peerId target** (reuses an already-open control
    connection) and falling back to explicit `addrs`; both `dialProtocol` and the
    handler set `runOnLimitedConnection: true`.
  - Returns the **deduplicated union** of all returned addrs in candidate order,
    then `orderSignalingFirst` (reused from `peer-record.ts`) so `/p2p-circuit`
    addrs lead. Excludes self (`node.peerId`). A failed/timed-out/empty sibling is
    logged and skipped; no sibling answering → `[]`.
- **Exports** (`src/index.ts`): `StrandAddrService`, `collectStrandAddrs`,
  `STRAND_ADDR_PROTOCOL`, `StrandAddrServiceOptions`, `StrandAddrPeer`,
  `CollectStrandAddrsOptions`.

## How to validate

Build + tests + lint all pass on this branch:

```
yarn workspace @serfab/cadre-core build
cd packages/cadre-core && yarn vitest run strand-addr-protocol strand-wake-protocol seed-bootstrap
yarn eslint packages/cadre-core/src/strand-addr-protocol.ts packages/cadre-core/test/strand-addr-protocol.spec.ts
```

- Targeted run: 3 files / 88 tests pass.
- Full cadre-core suite: 45 files, 609 passed, 1 pre-existing skip (`yarn test`).
- Lint: exit 0 on all changed files.

### Test coverage (`test/strand-addr-protocol.spec.ts`, reuses `wake-stream-helpers.ts`)

- **Decision matrix** (`processAddrRequest`): member + running → addrs; non-member
  → empty *before* any strand lookup; member + not-running (`[]`) → empty.
- **Framing round-trip** (`handleStream`): length-prefixed request → framed
  response carrying the addrs; non-member → empty; oversized declared-length frame
  → empty; streamed bytes over the 64KB cap → empty.
- **Hardening**: never-half-closing stream settles within the read timeout (no
  hang), aborts the stream, leaves `activeCount` at 0; concurrency cap returns an
  empty response without invoking `getStrandMultiaddrs`.
- **Client** (`collectStrandAddrs`): unions + dedupes across siblings with
  signaling-first ordering; skips a throwing sibling; excludes self (asserts self
  peerId is never dialed); returns `[]` when no sibling answers / no candidates;
  falls back to explicit `addrs` when a peerId is unparsable.

## Use cases (intended call site)

A node resuming/forming a strand it co-participates in with same-party siblings
calls `collectStrandAddrs(controlNode, connectedSiblings, strandId)` to obtain a
fresh seed of dialable strand-network addresses, then bootstraps the strand
node's libp2p mesh from that union. The receiver side runs on every cadre node so
each can answer for the strands it currently hosts.

## Out of scope / known gaps (reviewer: treat as a floor)

- **Not wired anywhere yet.** This module is the primitive only — no production
  path constructs `StrandAddrService` or calls `collectStrandAddrs`. The wiring
  into strand seed derivation is the **follow-up ticket
  `strand-seed-from-strand-addr-rpc`** (which carries this as a `prereq:`). The
  originating plan is `strand-cohort-seed-uses-control-network-addresses`.
  Consequence: the receiver is never `initialize`d in real code, so the
  `runOnLimitedConnection`/relay behavior is verified **only by parity with wake**,
  not by an integration test.
- **No real-network / integration test.** All tests use the in-memory stream
  doubles from `wake-stream-helpers.ts` and a loopback `dialProtocol`. There is no
  test that dials `STRAND_ADDR_PROTOCOL` over an actual libp2p relay/`p2p-circuit`,
  so the `runOnLimitedConnection: true` claim and the peerId-vs-addr dial
  preference are unproven against a live stack. A cross-package integration test
  belongs with the wiring ticket once a real call site exists.
- **Reject/error responses carry `strandId: ''`.** The concurrency-cap and
  malformed/timeout paths reply before a valid request is decoded, so they emit
  `{ strandId: '', multiaddrs: [] }`. The client ignores the response `strandId`
  (it only reads `multiaddrs`), so this is harmless today, but a reviewer should
  confirm no future caller starts trusting `response.strandId` to match its
  request.
- **`getStrandMultiaddrs` ordering is the injector's responsibility.** The service
  returns whatever the injected function gives, in order; the "signaling-first"
  guarantee for a single responder lives in the (not-yet-written) wiring that
  pulls `libp2pNode.getMultiaddrs()`. `collectStrandAddrs` *does* re-apply
  `orderSignalingFirst` across the union, so the final client result is
  signaling-first regardless.
- **Client has no global concurrency cap.** `collectStrandAddrs` dials all
  candidates at once. Expected sibling counts are small (one party's cadre), so
  this is acceptable, but it is unbounded by design — flag if a caller could pass a
  large peer list.
- **Authorization is membership-only (v1, by design).** No per-request signature;
  parity with wake. The control network is single-party, so this is
  defense-in-depth. Cross-party strand bootstrap is explicitly a different
  mechanism (strand formation / `MemberPeer`) and out of scope.
- **`describeTarget` is a thin `toString()` wrapper** kept for a single log call —
  trivial, but a reviewer may prefer inlining it.

## Files changed

- `packages/cadre-core/src/strand-addr-protocol.ts` — new module.
- `packages/cadre-core/src/types.ts` — added `StrandAddrRequest` / `StrandAddrResponse`.
- `packages/cadre-core/src/index.ts` — exported the new surface.
- `packages/cadre-core/test/strand-addr-protocol.spec.ts` — new spec.
