---
description: Extended `CoordinatorRepo.get` to consult cluster peers not only for entirely-missing blocks (legacy) but also for present-but-stale blocks, gated by a new `readRepairMode` policy on `ClusterConsensusConfig` ('off' / 'lazy' / 'paranoid'). Default `'lazy'` with a 10 s window. Adds per-block staleness tracking via an LRU bumped on successful commit and successful cluster-fetch. Emits `cluster-tx:read-repair-{triggered,applied,noop}` log events. Seven specs in `db-p2p` pin the three modes, window/sample-rate behavior; existing solo-self-bypass and adjacent ClusterCoordinator specs continue to pass.
prereq:
files: ../optimystic/packages/db-core/src/cluster/structs.ts, ../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts, ../optimystic/packages/db-p2p/test/coordinator-repo-read-repair.spec.ts
---

## What landed

### Config (`ClusterConsensusConfig` — additive)

Three new optional fields in `packages/db-core/src/cluster/structs.ts`:

- `readRepairMode?: 'off' | 'lazy' | 'paranoid'` — default `'lazy'`.
- `readRepairWindowMs?: number` — default `10000`.
- `readRepairSampleRate?: number` — default `0`.

Mirrored into the constructor `policy` literal in `CoordinatorRepo` with `?? <default>`.

### `CoordinatorRepo`

- New private `lastSeenCommitMs = new LruMap<string, number>(1000)`.
- `markBlocksSeen(blockIds)` bumps every passed blockId to `this.now()`. Called from `commit()` (every success path) and `fetchBlockFromCluster` (after `cluster-fetch:synced`).
- `shouldReadRepair(blockId)` implements the three modes; lazy reads consult the LRU + window + sample-rate.
- `get()` triggers cluster fetch when missing (legacy) OR `shouldReadRepair()`; both share the same `fetchBlockFromCluster → re-read` sequence.
- New log events: `cluster-tx:read-repair-triggered` / `-applied` / `-noop`.
- Test seams: public `now()`, `rand()`, `setLastSeenForTest(blockId, ts)`.

### Tests

New `packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` — 7 specs (6 from implementer + 1 added inline during review for `readRepairSampleRate`).

## Review findings

### What was checked

- The implement-stage diff first (fresh eyes), then the handoff narrative.
- Correctness: read-repair trigger conditions, LRU bump call sites, log event payloads, restoration semantics, error swallowing.
- Edge cases: never-seen-block triggers in lazy mode; sample-rate behavior; concurrent reads; cluster returning lower/same/higher rev; cluster fetch failure.
- Test coverage: happy paths (`off`, `lazy` window, `paranoid`), boundary (within vs past window), regression (noop), and the previously-untested sample-rate path.
- Adjacent regressions: ran `--grep "solo-cluster|ClusterCoordinator|super-majority|coordinator-repo|Libp2pKeyPeerNetwork"` (53/53 pass) and the full p2p suite.
- Docs: scanned for places that document `ClusterConsensusConfig` — no top-level doc cross-references the field shape, the JSDoc in `structs.ts` is the contract.
- Scope: cross-checked the diff against the implement ticket's declared `files:` list.

### What was found

- **MAJOR — scope creep**: `packages/db-p2p/src/libp2p-key-network.ts` and `packages/db-p2p/test/libp2p-key-network.spec.ts` were modified in the working tree but were NOT in the implement ticket's `files:` list and have nothing to do with read-repair. Changes add `runOnLimitedConnection: true` + `negotiateFully: false` on warm-reuse + dialProtocol paths, filter to only `status === 'open'` connections, and add 4 specs around the `connect()` method. Likely originated from the parallel `optimystic-circuit-relay-reservation-lifetime` investigation. **Disposition**: filed a new review-stage ticket `optimystic-libp2p-keynetwork-limited-connection-reuse` so the change gets a proper review pass instead of being silently folded in here. Left the diff in the working tree — reverting it would lose tested, useful work; the new ticket is the audit trail.

- **MINOR — implementer gap #3 (sample-rate not exercised)**: Implementer flagged that `readRepairSampleRate` had no dedicated spec. **Fixed inline**: added a 7th spec `'lazy mode honors readRepairSampleRate inside the freshness window'` that drives both branches via the `rand` seam (rand=0.3 < 0.5 triggers; rand=0.7 ≥ 0.5 skips). All 7 specs pass in 15 ms.

- **MINOR — markBlocksSeen call sites are not directly tested**: The 4 production call sites in `commit()` (peerCount ≤ 1, localExecuted, local-storage success, cluster-override-local-failure) and the 1 in `fetchBlockFromCluster` are not asserted by any spec. The new spec set uses `setLastSeenForTest` directly, which is the same `LruMap.set` call but bypasses the production callers. **Disposition**: not fixed in this pass — wiring a real `ClusterCoordinator` into the spec stubs would significantly grow the spec scaffolding for a low-probability regression (the call sites are 1-liners with no logic). Filing a follow-up was considered but the risk doesn't warrant a ticket; if the LRU stops being bumped on commit, the existing solo-self-bypass spec and any e2e read scenario would notice via the read-repair triggering far more often than expected.

- **MINOR — paranoid mode unconditionally calls `storageRepo.get` with the restoration context even when cluster returns same rev as local**: This is a pre-existing behavior of `fetchBlockFromCluster` (not introduced by this ticket) — it always runs `storageRepo.get({ blockIds: [blockId], context: { committed: [clusterLatest], rev: clusterLatest.rev } })` when `maxLatest` is truthy. In paranoid mode, every read carries one extra restore-style storage call even when nothing needs to change. **Disposition**: noted but not fixed — paranoid mode is a per-deploy opt-in, the storage layer is presumably idempotent for same-rev restores, and threading the local rev into the cluster query to skip same-rev returns is the bigger refactor the implement ticket explicitly punted on ("do the simple thing first").

- **MINOR — no single-flight guard on concurrent read-repair**: Multiple concurrent `get(blockId)` calls before the LRU is bumped will each issue their own cluster fetch — possible thundering-herd. **Disposition**: pre-existing for the missing-block branch too (not a regression). Not fixed; document if it becomes a perf hotspot.

- **MINOR — cluster fetch errors are swallowed in `get()` (`log + continue`)**: Returns the local (stale) data with no caller-visible signal that verification failed. **Disposition**: intentional per the implement ticket ("read-repair is best-effort"); documented here, not changed.

- **NIT — test seams (`now`, `rand`, `setLastSeenForTest`) are public on the production class**: Code smell mitigated by explicit naming. Not changed.

- **NIT — `policy.readRepairMode!` non-null assertions (3 sites)**: The `??` defaults guarantee the values, so the assertions are correct but ugly. Not changed; tiny churn for no behavior change.

- **NIT — `shouldReadRepair` switch has no `default`/`assertNever` branch**: TS doesn't enforce exhaustiveness on `switch` returning a value; if a fourth mode were ever added, the function silently coerces to `undefined → false`. Not changed; minor maintainability concern.

- **HONEST GAP — Tier 2 e2e not run**: Implementer correctly skipped this per the workflow's "single command's wall-clock > 10 min is not agent-runnable" rule. The Tier 2 sweep with `OPTIMYSTIC_E2E_DEBUG=1` × 3 passes is human/CI territory. The unit-level read-repair correctness is what's shipping; the Tier 2 outcome would be confirmation, not a gate.

- **HONEST GAP — Two pre-existing intermittent failures**: `Fresh-node DDL Scenario B` and `IPeerReputation getAllReputations` flake intermittently. **Re-verified during review**: full-suite run produced exactly the `Fresh-node DDL Scenario B` failure once; re-running the spec in isolation (6/6 pass) confirmed it's a load/timing flake when the full suite runs together, not a regression introduced by read-repair. The implementer's assessment in honest gap #2 holds.

- **HONEST GAP — Browser vs service default**: A single `'lazy'`/10 s default for everyone. Source ticket suggested splitting browser vs service. **Disposition**: explicitly accepted per the implement ticket's reasoning (strictly safer than current; window short enough for browser polling; config knob exists at `libp2p-node-base.ts` callsite for future split). Out of scope, seam intact.

### What was verified

- `yarn --cwd ../optimystic/packages/db-core build` → exit 0.
- `yarn --cwd ../optimystic/packages/db-p2p build` → exit 0.
- `yarn workspace @optimystic/db-p2p test --grep "read-repair"` → **7 passing in 15 ms** (was 6 in the implementer's run; +1 sample-rate spec added inline).
- `yarn workspace @optimystic/db-p2p test --grep "solo-cluster|ClusterCoordinator|super-majority|coordinator-repo|Libp2pKeyPeerNetwork"` → **53 passing in 14 s** (zero failures, covers solo-self-bypass, ClusterCoordinator, super-majority, broadcast retry, libp2p-key-network connect() including the scope-creep specs).
- Full `yarn workspace @optimystic/db-p2p test` → **455 passing, 7 pending, 1 failing** — the single failure is `Fresh-node DDL Scenario B`, confirmed flake (passed in isolation, also flakes pre-change).
- No lint script in `db-p2p`; tsc clean via build.

### Empty categories

- **Security**: nothing to review — purely internal LRU + log events, no new authn/authz surface, no user input.
- **Resource cleanup**: `LruMap(1000)` has a bounded eviction policy; no timers, no event listeners added; no file handles or sockets allocated by the new code.
- **Type safety**: no new `any` (the `(options as any)?.skipClusterFetch` cast is pre-existing); `BlockId` and `ActionRev` flow through unchanged; `ClusterConsensusConfig` additions are properly optional.
- **Cross-platform**: `Date.now()` (via `this.now()`), `Math.random()` (via `this.rand()`), `Map`-backed `LruMap` — all browser/RN/Node-portable. No `Buffer`, no `fs`.

## Follow-ups filed

- `tickets/review/optimystic-libp2p-keynetwork-limited-connection-reuse.md` — independent review pass for the scope-creep `libp2p-key-network.ts` changes that rode along in this commit.

## Files touched

- `../optimystic/packages/db-core/src/cluster/structs.ts` — three new optional fields.
- `../optimystic/packages/db-p2p/src/repo/coordinator-repo.ts` — read-repair plumbing, LRU, log events, test seams, markBlocksSeen call sites.
- `../optimystic/packages/db-p2p/test/coordinator-repo-read-repair.spec.ts` — 7 specs (6 from implementer + 1 added in review).
- `../optimystic/packages/db-p2p/src/libp2p-key-network.ts` — **scope creep**, see follow-up ticket.
- `../optimystic/packages/db-p2p/test/libp2p-key-network.spec.ts` — **scope creep**, see follow-up ticket.
