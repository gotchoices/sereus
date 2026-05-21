---
description: Tier 2 specs fail on `cluster-tx:supermajority-failed` because the default `superMajorityThreshold: 0.67` × `clusterSize: 3` rounds (via `ceil`) to a 3-of-3 unanimity requirement — zero slack on a 3-peer cluster. Thread a `superMajorityThreshold` knob through the browser `StartNodeOptions` and the `reference-peer` CLI so the e2e fixture + browser run with `0.51` (rounds to 2-of-3), while leaving the global default untouched. Add a focused unit test in `@optimystic/db-p2p` that captures the threshold math so the next regression is obvious.
files: ../optimystic/packages/db-p2p/src/repo/cluster-coordinator.ts, ../optimystic/packages/db-p2p/src/libp2p-node-base.ts, ../optimystic/packages/reference-peer/src/cli.ts, ../optimystic/packages/reference-peer/README.md, packages/reference-app-web/src/lib/optimystic.ts, packages/reference-app-web/e2e/fixtures/reference-peer.ts, packages/reference-app-web/e2e/distributed/_helpers.ts, packages/reference-app-web/README.md
---

## Root cause

`cluster-coordinator.ts` computes the super-majority as:

```ts
const superMajority = Math.ceil(peerCount * this.cfg.superMajorityThreshold);
```

With the `libp2p-node-base.ts` defaults of
`superMajorityThreshold: 0.67` and the e2e mesh's `clusterSize: 3`:

| peerCount | threshold | `ceil(N*t)` | slack |
| --- | --- | --- | --- |
| 3 | 0.67 | **3** | 0 |
| 3 | 0.51 | 2 | 1 |
| 5 | 0.67 | 4 | 1 |
| 10 | 0.67 | 7 | 3 |

So the picked 3-peer cluster requires **unanimity** to approve. Any
single peer that returns a record without its own `promises[ourId]`
signature — most commonly because `getTransactionPhase` lands in
`Promising` (not `OurPromiseNeeded`) due to a leftover conflicting
transaction within the 2-second stale window, or because the dial
hops via circuit-relay and the coordinator's `Promise.all` resolves
on a record snapshot taken before `handlePromiseNeeded` ran — sinks
the whole consensus pass. The browser's local optimistic commit
still completes, but no block lands on the cluster peers tab B
queries.

This is **option 1** from the source ticket. The merge step
(`record.promises = { ...record.promises, ...result.promises }`)
is structurally correct on inspection — it keys by `peerId.toString()`
and the local-vs-remote paths both add their signature under that
key — so option 2 (counting bug) is not the operative cause. A
defensive unit test in `@optimystic/db-p2p` still belongs in this
ticket per the source acceptance, to lock the threshold math in
place and to make the next "ceil rounds away my slack" regression
loud.

## Strategy

Two knobs already exist in the codebase but neither is reachable
from where the e2e needs them:

- `NodeOptions.clusterPolicy.superMajorityThreshold` is honored in
  `libp2p-node-base.ts:321` (and propagated to `ClusterMember` via
  `consensusConfig`) — but the **browser** (`packages/reference-app-web/src/lib/optimystic.ts`)
  doesn't accept the value from `StartNodeOptions` so it always
  picks up the `0.67` default; the **`reference-peer` CLI**
  (`../optimystic/packages/reference-peer/src/cli.ts`) doesn't
  expose it as a flag so spawned mesh peers also default to `0.67`.
- The e2e fixture has no way to make the browser and the spawned
  mesh agree on a lower threshold even though both halves of the
  config are reachable in principle.

Path:

1. **Browser** — thread `superMajorityThreshold?: number` through
   `StartNodeOptions` in `optimystic.ts`, forward via
   `clusterPolicy: { superMajorityThreshold }` to `createLibp2pNode`.
   Distributed-mode default becomes `0.51` paired with the
   distributed-mode default `clusterSize: 3` (matches the existing
   asymmetric defaulting at `optimystic.ts:136`). Solo mode keeps
   the libp2p-node-base default — it doesn't matter for a 1-peer
   cluster.
2. **`reference-peer` CLI** — add `--super-majority-threshold <number>`
   on `interactive`, `service`, and `run`. Strict parse: a finite
   number in `(0, 1]` (reject `0`, negatives, NaN, > 1, non-numeric).
   Forward via `clusterPolicy.superMajorityThreshold` to
   `createLibp2pNode`. Mirror `parseClusterSize`'s shape — message
   text: `--super-majority-threshold must be a number in (0, 1]`.
3. **e2e fixture** — append `--super-majority-threshold 0.51` to
   both the bootstrap (`interactive --offline`) and each service
   peer's argv in `packages/reference-app-web/e2e/fixtures/reference-peer.ts`,
   sitting next to the existing `--cluster-size 3` pair.
4. **Defensive unit test** — under `../optimystic/packages/db-p2p/test/`
   (find the existing cluster-coordinator suite if there is one,
   else add `cluster-coordinator-supermajority.test.ts`). Stub
   `keyNetwork.findCluster` to return 3 fake peers, stub
   `createClusterClient` so each returns a record with a synthetic
   approve signature keyed to its peerId, and assert:
   - `threshold: 0.67`, `peerCount: 3` → `executeClusterTransaction`
     rejects with `Failed to get super-majority` even when **all
     three** peers approve (because `ceil(3*0.67) = 3` and one
     peer's approval is missing) **and** passes when all three
     approve and one rejects? — no, with 3 approvals it should
     pass. The crisp invariant to lock in is:
     `peerCount=3, threshold=0.67, approvals=3 → pass`,
     `peerCount=3, threshold=0.67, approvals=2 → fail`,
     `peerCount=3, threshold=0.51, approvals=2 → pass`.
     A 3-row parametric `it.each` over `(threshold, approvals,
     expectedOutcome)` keeps the math obvious.
5. **Docs** — update `packages/reference-app-web/README.md` (the
   local-bootstrap recipe + "reproduce e2e locally" snippet) and
   `../optimystic/packages/reference-peer/README.md` to mention
   the new flag with the same default-fallback wording as
   `--cluster-size`.

## Acceptance

- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2"`
  reports **16/16 passing** locally with the 3-node mesh fixture.
  The three previously-failing specs are:
  - `e2e/distributed/two-tab-convergence.spec.ts`
  - `e2e/distributed/cross-tab-activity.spec.ts`
  - `e2e/distributed/disconnect-mid-session.spec.ts`
- The new `@optimystic/db-p2p` unit test passes and exercises the
  3-peer / threshold-rounding math.
- `reference-peer --help` on `interactive`, `service`, and `run`
  emits the new flag with the documented constraint.
- No change to the global default `superMajorityThreshold: 0.67`
  in `libp2p-node-base.ts`. Existing service-peer test suite
  (4 passing) continues to pass — it doesn't pass the new flag, so
  it exercises the default path unchanged.

## TODO

### Browser threading

- `packages/reference-app-web/src/lib/optimystic.ts`
  - Extend `StartNodeOptions` with `superMajorityThreshold?: number`.
  - In `startNode`, compute the effective threshold as
    `opts.superMajorityThreshold ?? (isDistributed ? 0.51 : undefined)`
    and forward via `clusterPolicy: { superMajorityThreshold }`
    on the `createLibp2pNode` config object. (Leave `undefined`
    in solo mode so the libp2p-node-base default stays in play.)
- Skim the Home / connect UI to see whether the panel needs a
  text field — likely **no**, the distributed-mode default suffices
  for both the UI and the e2e. Don't add a UI control unless
  needed by the spec.

### Reference-peer CLI

- `../optimystic/packages/reference-peer/src/cli.ts`
  - Add `private parseSuperMajorityThreshold(options: { superMajorityThreshold?: string }): number | undefined`
    next to `parseClusterSize`. Reject `parsed <= 0 || parsed > 1
    || !Number.isFinite(parsed)`. Error text per strategy.
  - Add the parsed value to the existing `startNetwork` options
    type alongside `clusterSize`.
  - Forward via `clusterPolicy: { superMajorityThreshold }` on the
    `createLibp2pNode` call in `startNetwork`. (Both `clusterSize`
    and `clusterPolicy.superMajorityThreshold` may need to flow —
    if `clusterPolicy` is already being constructed, extend the
    object; if not, create it conditionally so we don't override
    the library defaults for `allowDownsize` / `sizeTolerance`.)
  - Register the `.option('--super-majority-threshold <number>',
    'Super-majority threshold as a fraction in (0, 1] (default 0.67)')`
    on the three subcommands.
  - Add a console line like `🎯 Super-majority threshold set to 0.51`
    + `logDebug('super-majority threshold override set', { ... })`
    on startup when the flag is present, mirroring `parseClusterSize`'s
    pattern.
- Build the package: `yarn workspace @optimystic/reference-peer build`.

### E2E fixture wiring

- `packages/reference-app-web/e2e/fixtures/reference-peer.ts`
  - Append `'--super-majority-threshold', '0.51'` to the bootstrap
    args and each service peer's args, immediately after
    `'--cluster-size', '3'`.
- No change expected in `_helpers.ts` — the browser picks up the
  distributed-mode default automatically.

### Defensive unit test

- Find or create a colocated unit test in
  `../optimystic/packages/db-p2p/test/` for `ClusterCoordinator`.
  Use the existing testing harness (whatever framework the package
  already runs — `mocha + chai`, `vitest`, etc.; check `package.json`
  scripts before writing).
- Construct a fake `IKeyNetwork` that returns 3 synthetic peers
  from `findCluster`, plus a stub `createClusterClient` that
  returns a `ClusterClient`-shaped object whose `update` resolves
  with a `ClusterRecord` carrying a single `promises[peerId] =
  { type: 'approve', signature: '...' }` entry.
- Stub `localCluster` similarly so the coordinator can run
  end-to-end through `executeTransaction`.
- Parametric assertion across
  `(superMajorityThreshold, approvalsAmong3, expectedResolution)`:
  - `(0.67, 3, 'commit')` — fully unanimous, passes the threshold
  - `(0.67, 2, 'supermajority-failed')` — confirms 3-of-3 strictness
  - `(0.51, 2, 'commit')` — confirms the e2e knob does what we want
- Capture the test under `cluster-coordinator-supermajority.test.ts`
  if no existing suite is appropriate.

### Validation

- `yarn workspace @optimystic/db-p2p build`
- `yarn workspace @optimystic/db-p2p test` (or the suite that owns
  the new test file)
- `yarn workspace @optimystic/reference-peer build && yarn workspace @optimystic/reference-peer test`
- `yarn workspace @serfab/reference-app-web typecheck` (or whatever
  the package calls its TS check)
- `yarn workspace @serfab/reference-app-web test:e2e --grep "Tier 2" 2>&1 | tee /tmp/tier2.log`
  — must show 16/16. If a flake re-appears, capture the actual
  `cluster-tx:supermajority-failed` payload with
  `OPTIMYSTIC_E2E_DEBUG=1` and re-evaluate (the merge-input /
  merge-result trace will reveal whether option 2 is also in play).

### Docs

- `packages/reference-app-web/README.md` — extend the
  local-bootstrap and "reproduce e2e locally" snippets with
  `--super-majority-threshold 0.51` alongside the existing
  `--cluster-size 3`. One sentence on **why** (rounding leaves
  zero slack on a 3-peer cluster).
- `../optimystic/packages/reference-peer/README.md` — document
  `--super-majority-threshold` under the interactive-mode options
  list, same shape as `--cluster-size` was documented in
  `reference-peer-cluster-size-cli`.

## Notes

- Both halves (browser + service peers) need the same threshold
  because **every cluster member independently** computes
  `getTransactionPhase` against `superMajorityThreshold` in
  `cluster-repo.ts:517`. A coordinator with threshold `0.51` but
  service peers stuck at `0.67` would still see the service peers
  hold off on `OurCommitNeeded` until 3 approvals land — likely
  benign for promises (the coordinator drives the round) but a
  divergence we don't want to ship.
- `clusterSize` and `superMajorityThreshold` are conceptually
  paired with `simpleMajorityThreshold` (`0.51`,
  `libp2p-node-base.ts:322`). `simpleMajorityThreshold` is **not**
  threaded here — its rounding works out for 3-peer clusters
  (`floor(3*0.51) + 1 = 2`) so it's not blocking and exposing it
  alongside is scope creep.
- The acceptance log line for `--super-majority-threshold` should
  format the number explicitly (`Number.toString()`) — printing
  `0.51` as `'0.51'`, not `'5.1e-1'` — for human readability.
