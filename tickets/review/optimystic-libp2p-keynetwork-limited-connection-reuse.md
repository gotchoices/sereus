---
description: Spawned by review of `optimystic-coordinator-read-repair`. Independent of read-repair but landed in the same working tree: `Libp2pKeyPeerNetwork.connect()` now (a) filters cluster-connection-cache hits to only `status === 'open'` connections to avoid reusing a closing/closed entry that libp2p hasn't yet evicted, and (b) passes `runOnLimitedConnection: true` + `negotiateFully: false` on BOTH the warm-reuse `newStream` path and the `dialProtocol` fallback so the steady-state circuit-relay (limited) connection used by browsers and NATed peers can actually carry RPC streams. New `connect()` describe block in `libp2p-key-network.spec.ts` covers warm-reuse, closing-skip-then-fallback, no-connection fallback, and AbortSignal forwarding (4 specs). Needs its own review-stage pass because the changes were committed under the read-repair ticket without being declared in that ticket's `files:` list or scope.
prereq:
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts
---

## Why this is its own ticket

The read-repair ticket's `files:` list named `coordinator-repo.ts`, `cluster-coordinator.ts`, `structs.ts`, `coordinator-repo-solo-self-bypass.spec.ts`, and `libp2p-node-base.ts`. The `libp2p-key-network.ts` change is unrelated to read-repair plumbing — it's a circuit-relay/limited-connection fix that likely originated from the parallel investigation referenced in the read-repair ticket's Phase 5 ("the underlying dial-fail rate is the dominant cause … reference the sibling `optimystic-circuit-relay-reservation-lifetime` ticket"). It rode along in the working tree because the implementer needed it to make the dev loop work, but it deserves its own review pass instead of being silently folded into a different ticket's commit.

## What landed (in the read-repair commit)

In `packages/db-p2p/src/libp2p-key-network.ts` `connect()` (around lines 294-316):

- Imports `Connection` from `@libp2p/interface`.
- Warm-connection reuse now requires `c?.status === 'open'`, filtering closing/closed entries libp2p hasn't yet evicted from its index. Previously the cache picked `conns[0]` blindly.
- Warm-reuse `newStream()` call now passes `runOnLimitedConnection: true, negotiateFully: false` alongside the caller's `signal`. Without `runOnLimitedConnection: true`, opening a stream over a circuit-relay (limited) connection fails — which is the steady-state path for browsers and NATed peers reusing a warm relay-mediated connection.
- The `dialProtocol` fallback (when no open connection exists) now also passes `runOnLimitedConnection: true, negotiateFully: false` (previously only the signal was forwarded).

In `packages/db-p2p/test/libp2p-key-network.spec.ts`:

- New `describe('connect()', …)` block with 4 specs:
  - **runOnLimitedConnection: true on warm-reuse**: mock connection rejects unless `runOnLimitedConnection: true`; asserts both flags appear on `newStream` opts.
  - **closing-connection skip + dialProtocol fallback**: closing connection's `newStream` must not be called; fallback `dialProtocol` is called with `runOnLimitedConnection: true, negotiateFully: false`.
  - **no-connection fallback**: empty connections array → fallback dial with limited-connection flags.
  - **AbortSignal forwarding on reuse path**: caller's `AbortController.signal` is passed through to `newStream`.

## What to review

- Whether `runOnLimitedConnection: true` is appropriate on every protocol/stream we open through `connect()`, or whether some protocols should refuse to run over limited connections (relay-traffic budget considerations).
- Whether `negotiateFully: false` is the right call for protocol negotiation latency on every stream (e.g. whether stream-multiplexer protocols want the round-trip).
- Whether the `status === 'open'` filter correctly handles all libp2p `Connection.status` values (`open`, `closing`, `closed`) — the spec only exercises `open` and `closing`.
- Whether the existing 4 specs are sufficient or there are missing edge cases (e.g. multiple open connections to the same peer — which one wins?).
- Pre-existing `(this.libp2p as any).getConnections?.(peerId)` cast — does the libp2p interface now expose `getConnections` properly so the `any` can go away?

## Verification done in the parent ticket's review

- `yarn workspace @optimystic/db-p2p build` → exit 0.
- The new 4 `connect()` specs were not run in isolation by the parent review (the parent only re-ran read-repair + adjacent regression specs), but they're part of the standard `libp2p-key-network.spec.ts` describe block and would have run on any full suite invocation.
