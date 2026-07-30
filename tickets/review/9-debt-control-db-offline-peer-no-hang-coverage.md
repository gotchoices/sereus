----
description: When a node knows about other members that are switched off or unreachable, reading or writing its own settings must answer from local data and never freeze. Test coverage proving this now exists and passes; review the new specs and shared harness.
prereq:
files: packages/cadre-core/test/control-database-offline-peers.spec.ts, packages/cadre-core/test/control-database-solo.spec.ts, packages/cadre-core/test/control-db-node-helpers.ts, docs/STATUS.md
difficulty: medium
----

# Review: control-DB reads/writes with known-but-offline peers must not hang

## What landed

Three test-side files (no production code changed — this is pure coverage):

- **`packages/cadre-core/test/control-db-node-helpers.ts`** (new) — shared harness for the two
  liveness specs: `withinOp` (labelled per-operation deadline via cadre-core's own `withTimeout`,
  failing as `<scope> control op <label> timed out after <ms>ms`), `expectNotListening`,
  `readColumn`, `freshPartyId`, `controlNodeConfig` (mobile/browser posture: WebSockets-only,
  `listenAddrs: []`, empty bootstrap; injectable transports/listenAddrs). Not a `*.spec.ts`, so
  vitest never collects it as a suite.
- **`control-database-solo.spec.ts`** (refactor only) — now imports the harness; every assertion,
  budget, and the `solo control op` timeout label preserved bit-for-bit.
- **`control-database-offline-peers.spec.ts`** (new) — the whole matrix, 8 tests.

Plus `docs/STATUS.md`: the "Gap: cadre of more than one …" bullet replaced with the coverage
entry; section renamed to cover both shapes.

## What is asserted (per test)

Two offline flavours, each × {transaction, storage} profiles:
- **departed** — a real second `CadreNode` started on loopback WebSocket, its genuinely-published
  address captured, then stopped (OS refuses connection immediately).
- **blackhole** — RFC 5737 TEST-NET-1 address (never answers; where a freeze would live).

Each of those four runs the full operation table under 15 s per-op deadlines with **contents
asserted** (an empty read where local rows exist = same failure class as hang): `hasOwnerKey`,
`getOwnerKeys`, `queryCadrePeers`, `queryPeerRecord`, `resolvePeerAddrs`, `isMember`,
`listMembers`, `listAuthorizedMembers` (incl. self-exclusion), `registerSelf`
('inserted' genesis / 'refreshed' re-run), `authorizePeer` + separate read-back + write-while-alone
queue peek (`pendingPeerWrites`), then an **awaited `reconcileControlCohort()`** that must resolve
(30 s budget), post-pass rows intact + queue undrained, bounded `stop()`.

Transaction-only stress/transport cases:
- **three blackhole siblings** — sequential dial loop accumulates ~10 s per dial (js-libp2p
  default, no override in db-p2p); pass budget 60 s.
- **concurrent dial storm** — pass kicked unawaited, full op set runs to completion under normal
  deadlines while dead dials grind; pass then awaited within budget.
- **stop() with a blackhole dial in flight** — polls `getControlNode().getDialQueue()` until the
  dial is armed, then asserts `stop()` bounded and the abandoned pass still resolves.
- **circuit-relay in the transport set** — same single-blackhole matrix with
  `[webSockets(), circuitRelayTransport()]`.

Anti-vacuity guard: every offline sibling is minted with a valid self-signed fresh peer record
(`signPeerRecord`, inserted via `insertSelfPeerRecord`) and `resolvePeerAddrs` is asserted to
return exactly its addrs **before** anything else runs — so the dial path is provably armed, not
silently skipped. The `authorizePeer` target deliberately gets `[]` addrs + no signature so no
reconcile pass ever dials it, keeping each case's dial-budget math exact.

## Findings

- **No hang found.** Every operation answered locally, every reconcile pass resolved, every
  `stop()` was bounded. Green on the first run and stable on a second run.
- Measured costs (win32, second run): departed cases ~0.4–0.6 s; single blackhole ~10.3 s (one
  default dial timeout); three-blackhole 30.4 s (3 × ~10 s sequential — confirms the sequential
  dial-loop model and sits well inside the 60 s budget); dial storm 30.3 s; **stop-mid-dial
  185 ms** — `stop()` aborts the in-flight dial promptly and the abandoned pass resolves fast.
- `getDialQueue()` exists on the pinned libp2p (ticket flagged it as a risk) — no fallback delay
  needed.
- Worst risk from the ticket's list (storage profile + relay + `listenAddrs: []` brushing the
  lifecycle budget) did not materialize; storage-profile lifecycle stayed well under 30 s.

## Validation run

- `yarn workspace @serfab/cadre-core vitest run test/control-database-offline-peers.spec.ts
  test/control-database-solo.spec.ts` — 11 passed, ~102 s.
- Offline-peers spec re-run with `--reporter=verbose` — 8 passed again (stability + timings above).
- Full `yarn workspace @serfab/cadre-core test` — 78 files, 1213 passed, 1 skipped (the known
  win32 `skipIf` in `key-store.spec.ts:231`, listed in `tickets/.pre-existing-known.md`).
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn lint` — clean.

## Known gaps (honest — reviewer's floor, not ceiling)

- **WebRTC in the transport set is NOT covered** — deferred to the already-filed
  `backlog/debt-webrtc-transport-control-liveness-coverage` (WebRTC transport pulls in native/
  platform baggage unsuited to this suite).
- **Connected-but-slow peers not covered** — they DO enter the write cohort; that is a different
  question from unreachable peers and was explicitly out of scope (noted in the spec header).
- Blackhole timing rests on js-libp2p's ~10 s default outbound dial timeout; if a future libp2p
  bump changes that default, the three-blackhole test's 60 s budget is the first thing to re-check
  (comment in the spec explains the math).
- Awaited reconcile calls may JOIN an in-flight background pass (single-flight guard). The specs
  therefore assert liveness and row-integrity, never dial counts — do not "strengthen" them that
  way.
- Validated on win32 only in this run; budgets are generous multiples of measured cost, so CI/Linux
  should have ample headroom.
- Only `MemoryRawStorage` is exercised (same as the solo spec — its `NOTE:` about backend-specific
  hydrate bugs applies here too).
