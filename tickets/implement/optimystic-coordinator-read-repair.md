---
description: Extend `CoordinatorRepo.get` to detect stale local views and reconcile against cluster peers, so a peer that missed the post-majority commit broadcast can catch up on the next read instead of returning indefinitely stale data. The existing `fetchBlockFromCluster` / `queryClusterForLatest` infrastructure already does the network half of this — it just only triggers when the block is *missing entirely*. Expand the trigger to also cover stale-but-present rows, gated by a new `readRepair*` policy on `ClusterConsensusConfig`, and emit log events so the Tier 2 e2e debug log can verify the path runs.
files: ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-solo-self-bypass.spec.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts
---

## Architecture

### Trigger location

`CoordinatorRepo.get` (`coordinator-repo.ts:156-189`) already has the right shape:

```
local read → if missing → fetchBlockFromCluster → re-fetch local
```

We extend this to:

```
local read → if missing OR stale-by-policy → fetchBlockFromCluster → re-fetch local
```

The "missing" branch is unchanged. The new "stale-by-policy" branch reuses the same fetch path (`fetchBlockFromCluster`) but enters it for blocks that *are* present locally.

### Staleness policy (new config)

Add to `ClusterConsensusConfig` in `db-core/src/cluster/structs.ts`:

```ts
/** Read-repair behavior: 'off' (legacy: only fetch on missing), 'lazy' (fetch when local age > window), 'paranoid' (always verify against cluster on read). Default 'lazy'. */
readRepairMode?: 'off' | 'lazy' | 'paranoid';
/** For 'lazy' mode: read-repair triggers when (now - localEntry.lastSeenCommitMs) > this. Default 10000. */
readRepairWindowMs?: number;
/** Per-read probability of triggering in 'lazy' mode even within the window. Default 0 (no random check). Useful for keeping cluster views fresh under steady read traffic. */
readRepairSampleRate?: number;
```

These are mirrored into the `policy` literal in `coordinator-repo.ts` constructor with `?? <default>`, same pattern as the existing `commitBroadcast*` knobs.

### Tracking local "last seen commit" age

`CoordinatorRepo` does not currently track when each block was last written by *this* peer. The simplest hook: maintain a small per-instance LRU `lastSeenCommitMs: LruMap<BlockId, number>` and bump it from two paths:

1. After a successful local `commit` (storageRepo.commit returns success) — block is up-to-date.
2. After a successful `fetchBlockFromCluster` sync.

When a `get` arrives with a `BlockId` whose `lastSeenCommitMs` entry is missing or older than `readRepairWindowMs` (in 'lazy' mode), we trigger read-repair. In 'paranoid' mode we always trigger. In 'off' mode we do nothing extra (preserves legacy behavior).

Reuse `RESPONSIBILITY_TTL_MS`-style LRU sizing (1000 entries) — read-repair only needs a coarse "have I touched this block recently" signal, not a strict log.

### The read-repair fetch

`fetchBlockFromCluster(blockId, context)` already does the right thing — it queries all cluster peers via `queryClusterForLatest` and, if the max remote rev exceeds local, calls `storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } })` to trigger sync/restore.

For the stale-but-present case, the same call works: if the remote `maxLatest.rev` ≤ local rev, the restore is a no-op (the local store already has it); if it's higher, the restore pulls in the missing commits. We can short-circuit by passing the local rev into `queryClusterForLatest` so peers that match are skipped from the merge — but the simpler implementation is to just always run the existing fetch path and let the storage layer's idempotency handle the no-op case.

Decision: do the simple thing first (always invoke the existing fetch). If profiling shows the no-op case is hot, we can later thread the local rev through.

### Logging events

Per the source ticket's spec — emit from inside the new `maybeReadRepair` step in `coordinator-repo.ts`:

- `cluster-tx:read-repair-triggered` — `{ blockId, mode, ageMs, localRev }` — fires when the policy decides to invoke `fetchBlockFromCluster`.
- `cluster-tx:read-repair-applied` — `{ blockId, oldRev, newRev }` — fires when the post-fetch re-read shows a higher rev than before.
- `cluster-tx:read-repair-noop` — `{ blockId }` — fires when post-fetch rev is unchanged (cluster confirmed we were current).

Use the existing `createLogger('coordinator-repo')` channel.

### Defaults — browser vs service

Source ticket says: "Default should be on for browser peers (high broadcast-failure rate) and probably off / lazy for service peers." We are not going to thread a runtime-environment flag into `ClusterConsensusConfig` for this — instead default `readRepairMode: 'lazy'` for everyone with a 10 s window. That's strictly safer than the current behavior (which is effectively `'off'` for present-but-stale rows) and the window is short enough that browser peers polling every 4 s will trigger it after one missed broadcast cycle.

If we later need service peers to be cheaper, the config knob exists and can be flipped to `'off'` at the `libp2p-node-base.ts` callsite based on `options.role` or similar — out of scope here, just leave the default sane.

### Interfaces

`ClusterConsensusConfig` (additive — no breakage):
```ts
readRepairMode?: 'off' | 'lazy' | 'paranoid';
readRepairWindowMs?: number;
readRepairSampleRate?: number;
```

`CoordinatorRepo` (private):
```ts
private readonly lastSeenCommitMs: LruMap<BlockId, number>;
private readonly readRepairMode: 'off' | 'lazy' | 'paranoid';
private readonly readRepairWindowMs: number;
private readonly readRepairSampleRate: number;

private shouldReadRepair(blockId: BlockId): boolean;
private async maybeReadRepair(blockId: BlockId, context?: ActionContext, localRev?: number): Promise<void>;
private markBlockSeen(blockId: BlockId): void;
```

`get` becomes (sketch):
```ts
const localResult = await this.storageRepo.get(blockGets, options);
const skipClusterFetch = (options as any)?.skipClusterFetch;
if (this.clusterLatestCallback && !skipClusterFetch) {
  for (const blockId of blockGets.blockIds) {
    const localEntry = localResult[blockId];
    const localRev = localEntry?.state?.latest?.rev;
    if (!localRev) {
      // existing "missing" branch — unchanged
      await this.fetchBlockFromCluster(blockId, blockGets.context).catch(...);
      // re-read
    } else if (this.shouldReadRepair(blockId)) {
      await this.maybeReadRepair(blockId, blockGets.context, localRev);
      // re-read and replace localResult[blockId] if rev advanced
    }
  }
}
return localResult;
```

`commit` end-of-success and `fetchBlockFromCluster` end-of-success both call `markBlockSeen(blockId)` for all coordinating block ids.

## TODO

Phase 1 — config plumbing

- Add `readRepairMode`, `readRepairWindowMs`, `readRepairSampleRate` to `ClusterConsensusConfig` in `../optimystic/packages/db-core/src/cluster/structs.ts`. Document each with a JSDoc one-liner matching the style of the existing `commitBroadcast*` knobs.
- Mirror the three fields into the `policy` literal in `CoordinatorRepo` constructor (`coordinator-repo.ts:82-95`) with `?? <default>` (defaults: `'lazy'`, `10000`, `0`).
- Capture the resolved values onto `this.readRepairMode` / `this.readRepairWindowMs` / `this.readRepairSampleRate` private fields.

Phase 2 — staleness tracking

- Add `private readonly lastSeenCommitMs = new LruMap<string, number>(1000)` to `CoordinatorRepo`.
- Add `private markBlockSeen(blockId: BlockId): void { this.lastSeenCommitMs.set(blockId, Date.now()); }`.
- Call `markBlockSeen` for each `blockId` after a successful `commit` (just before the `return { success: true }` paths in `commit()`).
- Call `markBlockSeen` after a successful `fetchBlockFromCluster` sync (at the `cluster-fetch:synced` log line).

Phase 3 — read-repair trigger

- Add `private shouldReadRepair(blockId: BlockId): boolean` implementing:
  - `'off'` → return false.
  - `'paranoid'` → return true.
  - `'lazy'` → return true iff `lastSeen == null || (now - lastSeen) > readRepairWindowMs || (readRepairSampleRate > 0 && Math.random() < readRepairSampleRate)`.
- Add `private async maybeReadRepair(blockId: BlockId, context?: ActionContext, localRev?: number)` that:
  - Emits `cluster-tx:read-repair-triggered`.
  - Calls `await this.fetchBlockFromCluster(blockId, context)` (existing path).
  - Re-reads via `storageRepo.get({ blockIds: [blockId], context }, { ...options, skipClusterFetch: true })`.
  - Compares `refreshed[blockId]?.state?.latest?.rev` vs `localRev`. Emits `read-repair-applied` (with `oldRev`, `newRev`) or `read-repair-noop`.
  - Returns the refreshed entry so the caller can swap it into `localResult`.
- Modify `get()` to add the stale-branch alongside the existing missing-branch (sketch above). The two branches share the post-fetch re-read; refactor into a small helper if it ends up duplicated.

Phase 4 — tests

- Extend `../optimystic/packages/db-p2p/test/coordinator-repo-solo-self-bypass.spec.ts` (or, if it's getting busy, add a sibling `coordinator-repo-read-repair.spec.ts`) with three specs:
  - **Stale local block triggers read-repair fetch.** Set `readRepairMode: 'paranoid'`. Seed storageRepo with `{ rev: 1 }`. Provide a `clusterLatestCallback` that returns `{ rev: 2 }`. Assert `get()` invokes the callback and the post-call local read returns `rev: 2`.
  - **Read-repair noop when cluster matches.** `paranoid` mode, callback returns same `rev` as local. Assert `cluster-tx:read-repair-noop` emitted (use a log spy or just assert behavior — no exception, callback was called, result unchanged).
  - **Lazy mode honors the window.** `readRepairMode: 'lazy'`, `readRepairWindowMs: 60000`. Mark block seen (via a successful commit or a direct setter exposed for tests). Subsequent `get` within window does NOT invoke the callback. Advance `Date.now()` past window (e.g. mock or use a setter), `get` DOES invoke.
- The existing 14 `cluster-coordinator.spec.ts` specs do not exercise `CoordinatorRepo.get` so they should be unaffected; verify by running `yarn workspace @optimystic/db-p2p test --grep "ClusterCoordinator"`.
- Run the full p2p suite: `yarn workspace @optimystic/db-p2p test 2>&1 | tee /tmp/p2p-suite.log` and confirm no regressions vs the 443 pass / 5 pending / 0 fail baseline noted in the parent ticket.

Phase 5 — e2e validation (best-effort)

- The acceptance criterion in the source ticket asks for a Tier 2 e2e re-run with `OPTIMYSTIC_E2E_DEBUG=1` on the historically-flaky specs from `tickets/complete/web-e2e-tier2-cluster-supermajority.md`. Run them 3 times and report pass count + grep counts of `cluster-tx:read-repair-triggered` / `read-repair-applied` / `read-repair-noop` from the debug log to confirm the path runs.
- If Tier 2 still fails 3-of-3, the underlying dial-fail rate is the dominant cause, not the read-repair gap — note this in the review handoff and reference the sibling `optimystic-circuit-relay-reservation-lifetime` ticket. Do not block this ticket's completion on full Tier 2 green; the unit-level read-repair correctness is what we're shipping.

Phase 6 — handoff

- Build clean: `yarn workspace @optimystic/db-core build` and `yarn workspace @optimystic/db-p2p build`.
- Write the review-stage ticket with: what landed, what was checked, what was verified, and any honest gaps (especially the Tier 2 outcome).
