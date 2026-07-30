----
description: When a node has other known members that are currently switched off or unreachable, reading or writing its own settings must answer from local data and never freeze. The test code proving it is now written; this continuation runs and stabilizes it, then closes out docs and the review handoff.
prereq:
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, packages/cadre-core/src/cadre-node.ts, docs/STATUS.md
difficulty: hard
----

# Coverage: control-DB reads/writes with known-but-offline peers must not hang (continuation)

<!-- resume-note -->
A prior implement run wrote ALL the code (2026-07-30) and hit its token budget before running
anything. Working tree contains three uncommitted test-file changes; **no validation has run — not
even a typecheck**. Start at "Remaining work" below. The full original specification (operation
table, harness rules, edge cases) is in the git history of this file at commit `e1bfba1`
(`tickets/implement/9-debt-control-db-offline-peer-no-hang-coverage.md`) — consult it if an
assertion's intent is unclear, but the code now embodies it.
<!-- /resume-note -->

## What is already done (uncommitted, in the working tree)

- **`packages/cadre-core/test/control-db-node-helpers.ts`** (new) — shared harness:
  `withinOp(scope, label, ms, op)` (delegates to cadre-core's `withTimeout`, fails as
  `<scope> control op <label> timed out after <ms>ms`), `expectNotListening`, `readColumn`,
  `freshPartyId(fullTag)`, `controlNodeConfig(opts)` (WebSockets-only, `listenAddrs: []`,
  empty bootstrap, injectable `transports`/`listenAddrs`). Not collected by vitest
  (`test/**/*.spec.ts` glob), same pattern as `membership-gate-helpers.ts`.
- **`control-database-solo.spec.ts`** (rewritten) — now imports the five helpers; assertions,
  budgets (15 s op / 30 s lifecycle / 120 s + 180 s test), and the `solo control op` timeout label
  are bit-for-bit preserved (spec passes `solo-…` tags to the shared `freshPartyId`). Trailing
  "not covered here" comment now points at the new offline-peers spec.
- **`control-database-offline-peers.spec.ts`** (new) — the whole ticket matrix in one file:
  - departed × {transaction, storage} and blackhole × {transaction, storage}: full operation table
    (hasOwnerKey, getOwnerKeys, queryCadrePeers, queryPeerRecord, resolvePeerAddrs, isMember,
    listMembers, listAuthorizedMembers incl. self-exclusion, registerSelf 'inserted'/'refreshed',
    authorizePeer + separate read-back + `pendingPeerWrites` queue peek, awaited
    reconcileControlCohort resolves, post-pass rows intact + queue undrained, stop bounded);
  - transaction-only: three-blackhole sequential-dial case (60 s pass budget — js-libp2p's ~10 s
    default per-dial timeout × 3 sequential dials busts 30 s); concurrent dial-storm case
    (unawaited pass + full op set + awaited pass); stop()-with-dial-in-flight case (polls
    `getControlNode().getDialQueue()` until the dial is armed); circuit-relay transport variant.
  - Anti-vacuity enforced in `insertResolvableOfflinePeer`: every offline sibling is minted with a
    valid self-signed fresh record (`signPeerRecord`, `updatedAt: Date.now()`, inserted via
    `getSeedBootstrapService().insertSelfPeerRecord`) and `resolvePeerAddrs` is asserted to return
    exactly its addrs before anything else runs.
  - The authorizePeer target deliberately gets `[]` addrs + null Sig, so no reconcile pass ever
    dials it (`resolvePeerAddrs` → `[]`, peerStore miss) — keeps every case's dial-budget math
    exact.

## Remaining work

- Run the two specs, streamed (runner idle-timeout rule — never redirect silently):
  `yarn workspace @serfab/cadre-core vitest run test/control-database-offline-peers.spec.ts test/control-database-solo.spec.ts 2>&1 | tee /tmp/offline-peers.log`
- Fix what falls out. Known risks, in likely order:
  - `getDialQueue()` on the libp2p instance — verify it exists in the pinned libp2p version; if
    not, replace the stop-mid-dial poll with a short fixed delay (~750 ms) plus a comment.
  - Solo spec asserts genesis `registerSelf()` returns `'inserted'` (proven pattern); the offline
    spec repeats it and then asserts `'refreshed'` on the op-set re-run — if a background
    heartbeat interferes, the single-flight join returns the same outcome, so this should hold.
  - `storage` profile enables relay (`enableRelay ?? profile === 'storage'`) with `listenAddrs: []`
    — the one combination where bring-up/teardown could brush the 30 s lifecycle budget.
  - Departed-sibling `getMultiaddrs()` string shape (with/without `/p2p/…` suffix) — the spec is
    self-consistent (Set-compares captured strings), but confirm resolve round-trips them.
  - Blackhole dial duration on win32: budgets assume js-libp2p's ~10 s default outbound dial
    timeout (db-p2p's `libp2p-node-base` sets no override); Windows' own ~21 s TCP connect timeout
    is irrelevant while libp2p aborts first — if a pass busts its budget anyway, measure before
    widening.
  - Awaited reconcile calls may JOIN an in-flight background pass (single-flight guard; eager pass
    + ~15 s interval wired at start). Fine for liveness assertions; do not assert dial counts.
- **A real hang is a finding, not a test bug** (original ticket's rule): bounded local fix → land
  it here; root cause outside this repo → land the rest green, file `tickets/fix/bug-<slug>.md`
  with the failing case, say so in the handoff. `it.skip` / weakened assertions forbidden.
- Full close-out:
  `yarn workspace @serfab/cadre-core test 2>&1 | tee /tmp/cadre-core.log`, then
  `yarn workspace @serfab/cadre-core typecheck`, then `yarn lint`.
  Known pre-existing: one win32 `skipIf` in `key-store.spec.ts:231` (`tickets/.pre-existing-known.md`).
  If the stale-build guard (`test/global-setup.ts`) trips, rebuild linked workspaces.
- Update `docs/STATUS.md` where it describes control-DB liveness coverage.
- Review handoff into `tickets/review/`: which operations were asserted, measured worst-case
  reconcile pass cost, whether any hang was found and its disposition, and that WebRTC transport
  coverage is deferred to the already-filed `backlog/debt-webrtc-transport-control-liveness-coverage`.

## TODO

- Run the two specs; iterate to green without weakening assertions
- Full cadre-core suite + typecheck + lint
- docs/STATUS.md update
- Review handoff ticket; delete this one
