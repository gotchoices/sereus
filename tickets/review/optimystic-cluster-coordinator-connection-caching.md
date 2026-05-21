---
description: Review the fix to `Libp2pKeyPeerNetwork.connect` — pass `runOnLimitedConnection: true` (and `negotiateFully: false`) on the warm-connection `newStream` reuse path so RPCs against circuit-relay (limited) connections don't fail with the commit-succeeds-then-broadcast-fails pattern. Also filters to only-open connections so a closing entry isn't reused.
prereq:
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts
---

## What changed

`packages/db-p2p/src/libp2p-key-network.ts` — `Libp2pKeyPeerNetwork.connect()`:

```typescript
connect(peerId: PeerId, protocol: string, options?: AbortOptions): Promise<Stream> {
    const conns = ((this.libp2p as any).getConnections?.(peerId) ?? []) as Connection[]
    // Filter to only-open connections so a closing/closed entry that libp2p
    // hasn't yet evicted from its index doesn't get picked up here.
    const open = conns.find(c => c?.status === 'open' && typeof c?.newStream === 'function')
    if (open) {
        // runOnLimitedConnection: true is required to open a stream over a
        // circuit-relay (limited) connection — the steady-state path for
        // browsers and NATed peers. Without it, the warm relay connection
        // from a prior dialProtocol cannot be reused on subsequent RPCs.
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

Added `Connection` to the import from `@libp2p/interface` (line 1).

Before: the reuse branch only passed `{ signal }` — libp2p's `NewStreamOptions.runOnLimitedConnection` defaults to `false`, so any `newStream` over a circuit-relay (limited) connection was rejected before reaching the relay. This produced the `commit-majority-reached` → `consensus-broadcast-error` ~5 ms gap trace: commit went through `dialProtocol` (which passes the flag), then the connection landed in `getConnections`, then broadcast hit the reuse branch without the flag and failed.

After: reuse path passes the same `runOnLimitedConnection: true, negotiateFully: false` options as the dial fallback, plus filters to `status === 'open'` so a closing/closed connection that libp2p hasn't yet evicted doesn't get picked up.

## Tests added

`packages/db-p2p/test/libp2p-key-network.spec.ts` — new `describe('connect()')` block with four cases:

- `passes runOnLimitedConnection: true on warm-connection reuse (limited-connection path)` — fake connection whose `newStream` rejects without the flag and resolves with it; asserts `connect` resolves with the stream and that `runOnLimitedConnection: true, negotiateFully: false` were passed.
- `skips non-open connections and falls back to dialProtocol` — `status: 'closing'` connection is present; asserts the connection's `newStream` is never called and the dial fallback fires with the limited-connection flag.
- `falls back to dialProtocol when no connections exist` — empty `getConnections` result; asserts dial fallback with the flag.
- `forwards the caller AbortSignal on the reuse path` — asserts the `signal` is propagated to `newStream`.

## Validation status

- **Unit test suite**: `yarn workspace @optimystic/db-p2p test` → **450 passing, 7 pending, 0 failing** (~20s). No regressions; the four new cases pass.
- **Typecheck/build**: `yarn build` in `packages/db-p2p` exits 0.
- **Tier 2 e2e** (`web-e2e-tier2-consensus-broadcast-race`): **deferred**. The ticket explicitly notes the full e2e is too long for a single agent turn ("document the deferral in the review ticket if so, and leave it for a human or CI"). The unit test mirrors the relay-limited rejection behavior, so the code-level fix is exercised, but the end-to-end claim — that the `cluster-tx:consensus-broadcast-error` events following `cluster-tx:commit-majority-reached` against the same peer actually disappear — is unverified at the integration level here. Human or CI should run Tier 2 to confirm.
- **`docs/cadre-consistency.md`**: searched for relay / circuit / libp2p / cluster-coordinator-RPC-path content; no section currently describes the cluster coordinator's RPC path. No doc update made (would be a from-scratch addition, out of scope here).

## What this does NOT cover (per ticket)

- A connection that genuinely died between commit and broadcast (relay reservation actually expired, not just per-stream limit). `newStream` still fails in that case; the existing `commitBroadcastImmediateRetries` loop in `cluster-coordinator.ts:580-595` falls back to `dialProtocol` on retry — correct, no code change needed.
- The relay reservation lifetime problem itself (separate tickets: `circuit-relay-long-lived-spec-never-publishes` pending in `fix/`, and the merged `optimystic-circuit-relay-reservation-lifetime`).

## Reviewer focus

- Confirm the `status === 'open'` filter doesn't regress the existing dial-once-then-reuse pattern in non-relay scenarios. The unit test covers it but a manual eye on `cluster-coordinator.ts` callers of `connect`/`processMessage` is worth doing.
- Confirm `Connection.status === 'open'` is the right comparison for the libp2p version pinned in `db-p2p/package.json` (`@libp2p/interface ^3.1.0`). The connection state machine is `opening | open | closing | closed`; using `=== 'open'` excludes the other three (correct intent).
- Consider whether the `as unknown as Promise<Stream>` cast is necessary. With `Connection` properly typed, it likely is not — but `newStream`'s return type may be `Promise<Stream<Uint8Array>>` vs the imported `Stream`, so the cast was kept conservative.
