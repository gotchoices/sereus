---
description: `Libp2pKeyPeerNetwork.connect` already reuses warm libp2p connections via `getConnections(peerId)[0].newStream(...)`, but it omits `runOnLimitedConnection: true` on the `newStream` call. For relay-via (limited) connections — the common case for browsers and NATed peers — libp2p's default rejects opening a stream, so the commit-phase RPC (which succeeded via the dial fallback that *does* pass the flag) cannot be followed by a broadcast-phase RPC over the same warm connection. The result matches the trace exactly: commit succeeds, broadcast fails ~5 ms later against the same peer.
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/src/protocol-client.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts
---

## Root cause

`Libp2pKeyPeerNetwork.connect` at `libp2p-key-network.ts:294-305`:

```typescript
connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
    const conns = (this.libp2p as any).getConnections?.(peerId) ?? []
    if (Array.isArray(conns) && conns.length > 0 && typeof conns[0]?.newStream === 'function') {
        return conns[0].newStream([protocol], { signal: options?.signal }) as Promise<Stream>
    }
    const dialOptions = { runOnLimitedConnection: true, negotiateFully: false, signal: options?.signal } as const
    return this.libp2p.dialProtocol(peerId, [protocol], dialOptions)
}
```

The reuse-connection branch only passes `{ signal }`. Per `@libp2p/interface` `NewStreamOptions`, `runOnLimitedConnection` defaults to `false`, and "these limits are typically enforced by a relay server" — meaning any stream open over a circuit-relay connection without that flag is rejected by libp2p before it reaches the relay. Browsers (and any NATed peer) reach their cluster peers via `/p2p-circuit/...` connections that are marked `limited`, so this is the steady-state path for the Tier 2 e2e fleet.

The dial fallback path passes the flag (and `negotiateFully: false` for first-byte latency), so the *first* RPC against a peer succeeds — it goes through `dialProtocol`, which either dials or, if libp2p already has a connection, uses it with the flag honored. But once that first call completes and the connection is in `libp2p.getConnections(peerId)`, every subsequent RPC takes the reuse branch and fails immediately for limited connections.

Why the trace shows commit-then-broadcast failing rather than promise-then-commit failing: the promise + commit phases for a single peer go through `Promise.all` over fresh `ClusterClient` instances. Either both calls hit the reuse branch (and both fail) or both hit the dial branch (and both succeed). The 5 ms gap to broadcast is plenty of time for libp2p's `getConnections` index to register the connection from the commit-phase dial, so the broadcast call hits the reuse branch and fails. The `circuit-relay-long-lived-spec-never-publishes` ticket is independent: that's about relays not advertising long-lived reservations, this is about clients failing to *use* the limited reservations they do hold.

## Fix

Pass the same `runOnLimitedConnection: true, negotiateFully: false` options on the `newStream` reuse path that the dial fallback uses, and filter to only-open connections so a closing/closed connection isn't picked up by `conns[0]`.

```typescript
connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
    const conns = ((this.libp2p as any).getConnections?.(peerId) ?? []) as Connection[]
    const open = conns.find(c => c?.status === 'open' && typeof c?.newStream === 'function')
    if (open) {
        return open.newStream([protocol], {
            signal: options?.signal,
            runOnLimitedConnection: true,
            negotiateFully: false
        }) as unknown as Promise<Stream>
    }
    const dialOptions = { runOnLimitedConnection: true, negotiateFully: false, signal: options?.signal } as const
    return this.libp2p.dialProtocol(peerId, [protocol], dialOptions)
}
```

`Connection` is imported from `@libp2p/interface` (already imported at line 1).

This is sufficient to fix the trace: once `runOnLimitedConnection: true` is passed, the warm relay connection from the commit phase is reusable for the broadcast phase. No coordinator-layer connection-stashing is required — libp2p's connection layer already does what the original ticket hypothesized we needed to add. The `status === 'open'` filter is defense against the unlikely case where libp2p's connection index hasn't yet evicted a closing connection.

## What this does NOT fix

- A connection that genuinely died between commit and broadcast (e.g. relay reservation actually expired, not just the per-stream limit). `newStream` will still fail; the existing `commitBroadcastImmediateRetries` loop in `broadcastMergedRecord` (`cluster-coordinator.ts:580-595`) will retry, and by the second attempt libp2p will have removed the dead connection from `getConnections`, so the retry falls into `dialProtocol` and dials fresh. This is the correct behavior and doesn't need a code change.
- The relay reservation lifetime problem itself — that's `circuit-relay-long-lived-spec-never-publishes` (pending in `fix/`) and the merged `optimystic-circuit-relay-reservation-lifetime`.

## Acceptance

- After the fix, in a fresh Tier 2 e2e run the `cluster-tx:consensus-broadcast-error` events that previously followed `cluster-tx:commit-majority-reached` against the same peer disappear, or are limited to genuine connection-death cases (caught by the existing immediate-retry loop).
- A targeted unit test in `db-p2p` constructs a fake libp2p whose `getConnections(peerId)` returns a `Connection` whose `newStream` rejects when called without `runOnLimitedConnection: true` (mirroring the relay-limited behavior) and resolves when called with it. Assert that `Libp2pKeyPeerNetwork.connect` returns the resolved stream — i.e. the flag is being passed.
- No regression in the non-relay case: a fake connection with `runOnLimitedConnection: true` still works (it's a permissive flag, not a requirement).

## TODO

- Apply the `connect` change in `libp2p-key-network.ts` per the snippet above. Confirm the `Connection` type import exists (line 1 — `@libp2p/interface`).
- Add a `db-p2p` unit test for `Libp2pKeyPeerNetwork.connect` covering: (a) limited-connection reuse path passes `runOnLimitedConnection: true`; (b) `status !== 'open'` connections are skipped and the dial fallback is used; (c) no existing connections → dial fallback.
- Run the existing `db-p2p` test suite to confirm no regression: `cd ../optimystic && yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/db-p2p-test.log`.
- Run the Tier 2 e2e (`web-e2e-tier2-consensus-broadcast-race` was the original observed-failure ticket) headlessly and confirm the broadcast-error events are gone. The full e2e is too long for a single agent turn — document the deferral in the review ticket if so, and leave it for a human or CI.
- Update `docs/cadre-consistency.md` if it has a section describing the cluster coordinator's RPC path — note that limited (relay) connections are now reused across phases.
