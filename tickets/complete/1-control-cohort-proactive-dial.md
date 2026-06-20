description: Cadre nodes in a party now automatically find and connect to each other so their shared membership database can sync in production, instead of relying on a manual connection step that only existed in tests.
prereq:
files: packages/cadre-core/src/control-cohort.ts (pure dial-selection policy + defaults), packages/cadre-core/src/cadre-node.ts (reconcileControlCohort + dialControlSibling/resolveControlDialAddrs/peerStoreAddrs; eager pass in scheduleSelfRegistration; interval + self:peer:update in startRecordRefresh; teardown in stopRecordRefresh), packages/cadre-core/src/types.ts (NetworkConfig.controlCohort), packages/cadre-core/src/index.ts (exports), packages/cadre-core/test/control-cohort.spec.ts, packages/cadre-core/test/cadre-node-control-cohort.spec.ts, packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts, packages/integration-tests/src/scenarios/control-db-two-node-convergence.integration.ts (stale-comment fix), docs/architecture.md
----

## What was built

Each `CadreNode` now runs an in-node `reconcileControlCohort()` routine that
proactively dials its cadre siblings so the `CadreControl` collections form a
connected (≥2) FRET cohort and replicate — productionizing what the convergence
integration test previously did by hand with a test-only manual `dial()`.

- **Pure selection policy** (`control-cohort.ts`, `selectControlCohortDials`):
  backbone-preferential, bounded out-degree — always dial every authority
  (backbone) member, fill the remainder up to `targetDegree` (default 6) with
  non-authority members in deterministic peerId order; reports what the cap dropped.
- **Orchestration** (`cadre-node.ts`): enumerate siblings (`listMembers`, itself a
  pull-on-read), select, skip already-connected, resolve (`resolvePeerAddrs` signed
  record + libp2p peerStore cold-start fallback), dial best-effort. Concurrent
  triggers collapse into one in-flight pass; guards make a post-`stop()` pass a no-op.
- **Lifecycle**: eager pass ~1s after start, `.unref()`'d ~15s recurring interval
  (`reconcileMs` override), and a `self:peer:update` trigger; torn down in
  `stopRecordRefresh`.
- **Config/exports**: `NetworkConfig.controlCohort?: { targetDegree?; reconcileMs? }`;
  `selectControlCohortDials` + defaults + `ControlCohortSelection` exported.

## Review findings

### What was checked

- **Read the implement diff (`c700d22`) first, fresh**, before the handoff summary:
  `control-cohort.ts` (selection policy), all of `cadre-node.ts`'s new methods
  (`reconcileControlCohort` / `runReconcileControlCohort` / `dialControlSibling` /
  `resolveControlDialAddrs` / `peerStoreAddrs`), the lifecycle wiring
  (`scheduleSelfRegistration` eager pass, `startRecordRefresh` interval +
  `self:peer:update`, `stopRecordRefresh` / `cleanup` teardown), `types.ts`,
  `index.ts`, both new unit specs, the new integration scenario, and the doc update.
- **Correctness / single-purpose / DRY**: selection policy is pure and well-decomposed;
  orchestration mirrors the established `registerSelfInFlight` single-flight and the
  `applySeed` best-effort-dial patterns; `CohortPeerRow` shape matches
  `queryCadrePeers` / `listMembers`. No DRY violations.
- **Concurrency / single-flight**: `reconcileControlCohort` correctly coalesces
  concurrent callers onto one in-flight promise and clears it in `finally`; verified
  by the single-flight unit test (one membership read, one dial under two concurrent calls).
- **Shutdown / resource cleanup**: timer is `.unref()`'d and torn down symmetrically
  with `recordRefreshTimer`; `_running`/null re-checks between awaits make a racing
  pass a no-op, and any throw lands in the wrapper's `.catch` (logged, not crashed).
  Confirmed acceptable for a best-effort background routine (`stop()` does not await an
  in-flight pass, but the guards + caught errors make that safe) — matches the
  implementer's honest flag.
- **Error handling / type safety**: per-peer try/catch isolates one bad sibling;
  `peerStoreAddrs` swallows lookup/parse failures to `[]`; no `any` in production code.
- **Edge cases**: alone / no rows / self-as-row / unresolvable / dial-failure /
  not-running / null-control-node / targetDegree-cap — all covered.
- **Docs**: re-read `docs/architecture.md` Control Network section (accurate, ✅/open-gap
  framing is honest) and grepped the tree for stale `connectControlNodes` /
  `control-network-cohort-discovery` / "auto-connect" references.
- **Validation**: `yarn workspace @serfab/cadre-core typecheck` clean; full cadre-core
  suite **575 passed / 1 skipped** (was 574 — my +1 test); `eslint` clean on all
  touched files. Did NOT re-run the long network integration suite in review (no
  production code changed; relied on the implementer's reported green runs of
  `control-cohort-auto-convergence` and `control-db-two-node-convergence`).

### Found / done

- **MINOR — stale comment (fixed inline).** `control-db-two-node-convergence.integration.ts`
  header still claimed auto-connect "remains the open prerequisite, tracked by
  `control-network-cohort-discovery`." That is now false — auto-connect landed in this
  ticket. Rewrote the comment to state the scenario deliberately keeps a manual dial to
  isolate *replication-given-a-connected-cohort*, and that production auto-connect is now
  proven by `control-cohort-auto-convergence.integration.ts`.
- **MINOR — test coverage gap (fixed inline).** The unit tests covered the
  `resolvePeerAddrs`-returns-addrs path and the both-empty path, but never the
  **peerStore cold-start fallback *success*** path (`resolvePeerAddrs → []`, peerStore →
  addrs → dial) — which is the load-bearing path in the integration test. Added a unit
  test (`falls back to peerStore addresses when the signed record does not resolve`) to
  `cadre-node-control-cohort.spec.ts` asserting the fallback dials. (12 → covered; suite +1.)
- **MAJOR — missing isolation test (new ticket filed).** No integration test isolates
  the reconcile *dial* as the *sole* connector; in a 2-node party the first connection is
  always the cold-start path, so the "reconcile is load-bearing" scenario is unproven
  end-to-end. The implementer flagged this. Filed
  `tickets/backlog/control-cohort-three-node-reconcile-isolation-test.md` (≥3-node
  topology: B learns sibling C via A, then dials C with no cold-start assist), forcing
  the steady-state signed-record resolve path rather than the peerStore fallback.

### Not changed (reviewed, judged acceptable)

- **Write-while-alone durability** stays open by design — tracked downstream in
  `control-write-ensure-replicated` (already queued in `implement/`); out of scope here.
- **NAT/relay sufficiency & WebRTC upgrade** out of scope — deferred to `rn-webrtc-transport`
  (already in `plan/`).
- **Backbone identification before AuthorityKey convergence** — bounded fill still makes
  progress when `getAuthorityKeys()` is empty/partial; covered by the empty-authority unit test.
- **Bare-multiaddr dial in `peerStoreAddrs`/`resolveControlDialAddrs`** — consistent with
  the existing `wakePeer`/`resolvePeerAddrs` dial pattern already in the codebase, so not a
  new defect; left as-is.
- **`security` / new external surface**: none introduced (trust gating reuses the existing
  signed-record + trust-policy path).
