---
description: Fixed `Libp2pKeyPeerNetwork.connect` to pass `runOnLimitedConnection: true` (and `negotiateFully: false`) on the warm-connection `newStream` reuse path, plus a `status === 'open'` filter. This eliminates the commit-succeeds-then-broadcast-fails pattern over circuit-relay (limited) connections: the first RPC went through `dialProtocol` (which already passed the flag), but every subsequent RPC took the reuse branch and was rejected by libp2p before reaching the relay.
prereq:
files: ../optimystic/packages/db-p2p/src/libp2p-key-network.ts, ../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts
---

## Summary

`Libp2pKeyPeerNetwork.connect()` previously had asymmetric behavior between its two branches: the `dialProtocol` fallback passed `{ runOnLimitedConnection: true, negotiateFully: false }`, but the warm-connection reuse branch only passed `{ signal }`. Per `@libp2p/interface` `NewStreamOptions`, `runOnLimitedConnection` defaults to `false`, which causes libp2p to reject any `newStream` over a circuit-relay (limited) connection before it reaches the relay. Browsers and NATed peers always reach their cluster peers via `/p2p-circuit/...` limited connections, so this was the steady-state failure mode behind the `cluster-tx:commit-majority-reached` → `consensus-broadcast-error` ~5 ms gap trace.

The fix is a small change to that single method:

- Filter to `status === 'open'` connections (defensive against closing/closed entries libp2p hasn't evicted from its index yet).
- Pass the same `runOnLimitedConnection: true, negotiateFully: false` options the dial fallback already passes.

Four unit tests in `test/libp2p-key-network.spec.ts` cover: limited-connection reuse path (rejects without flag, resolves with it), non-open connection skip + dial fallback, no-connection dial fallback, and `AbortSignal` forwarding on the reuse path.

## Review findings

### Code-level review

**Correctness / SPP / behavior** — Fix is correct. The reuse-path options now mirror the dial-fallback options. The `status === 'open'` filter correctly excludes the other four states (`'closing' | 'closed' | 'aborted' | 'reset'` — verified against `@libp2p/interface` `MessageStreamStatus` in `node_modules/@libp2p/interface/dist/src/message-stream.d.ts:10`). The implement-stage ticket described the state machine as `opening | open | closing | closed`, which is slightly inaccurate (no `'opening'`; missing `'aborted' | 'reset'`), but the implementation's `=== 'open'` filter is unaffected by that documentation slip.

**Type / cast hygiene** — *Minor finding, fixed inline.* The implementer kept the reuse-path expression cast as `as unknown as Promise<Stream>`. With `open` properly typed as `Connection`, `Connection.newStream(string[], NewStreamOptions)` already returns `Promise<Stream>` where `Stream` resolves to the same `@libp2p/interface` import used in the method's return type. The double cast was unnecessary noise — removed. Build (`yarn workspace @optimystic/db-p2p build`) still exits 0 after the cleanup, and the 4 new `connect()` tests still pass.

**DRY** — The two option objects share `runOnLimitedConnection: true, negotiateFully: false, signal`. Could be factored into a single named constant, but it's only used twice and the surrounding code shape differs slightly between branches (the dial branch uses `as const` to narrow). Not worth extracting; current form is readable.

**Modular / maintainable** — `connect()` stays small (~12 lines after the change). The inline comment block explains *why* the flag is needed, which is the non-obvious part. No surrounding refactor needed.

**Resource cleanup** — No new resources allocated by this method. The returned `Stream` is closed by the single caller (`protocol-client.ts:124-125` — `finally { await stream.close() }`). `AbortSignal` is forwarded on both branches.

**Error handling** — No new error paths. If `newStream` rejects on the reuse path (genuinely dead connection that libp2p hasn't yet removed from `getConnections`), the existing `commitBroadcastImmediateRetries` loop in `cluster-coordinator.ts:580-595` retries; by the second attempt libp2p has removed the dead entry and the call falls into `dialProtocol`. This is the intended behavior, called out by the implement ticket, and verified by reading the loop — no code change needed.

**Pre-existing defensive cast** — Untouched and out of scope: `(this.libp2p as any).getConnections?.(peerId) ?? []` is overly defensive (`Libp2p.getConnections(peerId?)` is part of the `@libp2p/interface` contract — see `node_modules/@libp2p/interface/dist/src/index.d.ts`). Pre-existed before this change; leaving for a future cleanup if desired.

**Single caller verified** — `Libp2pKeyPeerNetwork.connect` has exactly one in-tree caller: `protocol-client.ts:63`. Pattern there is dial → use → close. The `status === 'open'` filter does not regress that flow — when the dial-fallback path runs, libp2p itself decides whether to reuse or fresh-dial inside `dialProtocol`. The filter only changes behavior when `getConnections(peerId)` returns a stale closing/closed entry, in which case the dial fallback (which would have been needed anyway) takes over.

### Test review

**Coverage** — The 4 new tests cover the four meaningful branches: reuse with limited-conn semantics, non-open skip, empty-conns fallback, signal forwarding. Each test isolates a single behavior. Mocks mirror the real libp2p semantic (reject without flag) rather than just asserting on call arguments, which is the stronger pattern.

**Missing micro-cases** — Considered:

- *Mixed-status array (`[closing, open, closed]` — picks the open one).* The `.find` predicate is straightforward and TypeScript-typechecked; the closing-only and open-only tests together exercise both predicate outcomes. Marginal value. **Not added.**
- *Signal forwarding on dial-fallback path.* `protocol-client.ts` already exercises this end-to-end (the existing dial-timeout test in the file context). Marginal value at unit level. **Not added.**

These would be nice-to-haves; not regressions or gaps in fault coverage.

### Validation

- `yarn workspace @optimystic/db-p2p test` (after cast cleanup): 449 passing, 7 pending, 1 failing. The single failure is `Fresh-node DDL (multi-node, real production stack) → Scenario B`, **confirmed pre-existing** by stashing the change and re-running on the unchanged tree — same single failure (445 passing baseline + 4 new = 449). Unrelated to this fix.
- `yarn workspace @optimystic/db-p2p build`: exit 0 after cast cleanup.
- `--grep "connect()"`: 4 passing.
- No lint script defined for `@optimystic/db-p2p`; nothing to run.

### Deferred / not in scope

- **Tier 2 e2e (`web-e2e-tier2-consensus-broadcast-race`)** — Deferred per the ticket's explicit instruction ("the full e2e is too long for a single agent turn"). The unit test mirrors the relay-limited rejection behavior so the code-level fix is exercised, but the end-to-end disappearance of `cluster-tx:consensus-broadcast-error` events following `cluster-tx:commit-majority-reached` is unverified at integration level. **Human or CI should run Tier 2 to confirm.**
- **`docs/cadre-consistency.md`** — Searched for relay / circuit / libp2p / cluster-coordinator-RPC-path content; no section currently describes the cluster coordinator's RPC path. The implement ticket suggested updating "if it has a section describing the cluster coordinator's RPC path"; no such section exists, so no update made. A from-scratch addition would be out of scope for this fix.
- **Relay reservation lifetime** — Tracked separately under `circuit-relay-long-lived-spec-never-publishes` (pending in `fix/`) and the merged `optimystic-circuit-relay-reservation-lifetime`.

### Disposition

- **Minor (fixed in this pass):** Removed the unnecessary `as unknown as Promise<Stream>` double cast on the reuse path.
- **Major:** None.
- **New tickets filed:** None.
