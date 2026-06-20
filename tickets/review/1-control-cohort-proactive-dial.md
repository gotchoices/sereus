description: Cadre nodes in a party now automatically find and connect to each other so their shared membership database can sync in production, instead of relying on a manual connection step that only existed in tests.
prereq:
files: packages/cadre-core/src/control-cohort.ts (NEW — pure dial-selection policy + defaults), packages/cadre-core/src/cadre-node.ts (reconcileControlCohort + dialControlSibling/resolveControlDialAddrs/peerStoreAddrs ~822-960; eager pass in scheduleSelfRegistration; interval + self:peer:update in startRecordRefresh; teardown in stopRecordRefresh; new timer/single-flight fields), packages/cadre-core/src/types.ts (NetworkConfig.controlCohort), packages/cadre-core/src/index.ts (exports), packages/cadre-core/test/control-cohort.spec.ts (NEW), packages/cadre-core/test/cadre-node-control-cohort.spec.ts (NEW), packages/integration-tests/src/scenarios/control-cohort-auto-convergence.integration.ts (NEW), docs/architecture.md (Control Network status ~169-174)
difficulty: hard
----

## What was built

Productionized what `control-db-two-node-convergence.integration.ts` did by hand (its test-only `connectControlNodes` manual `dial()`): each `CadreNode` now runs an in-node **`reconcileControlCohort()`** routine that proactively dials its cadre siblings so the `CadreControl` collections form a connected (≥2) FRET cohort and replicate.

### Routine (`cadre-node.ts`, public `async reconcileControlCohort()`)
Each pass:
1. **Enumerate siblings** — `listMembers()` (`queryCadrePeers`), excluding `controlNode.peerId`. This read is itself the pull-on-read that converges the membership table (a reader-only node converges purely by these reads).
2. **Select a bounded dial set** — `selectControlCohortDials` (new `control-cohort.ts`, pure + unit-tested): always dial every **backbone (authority) member** (key derived via `ed25519PublicKeyB64FromPeerId` ∈ `getAuthorityKeys()`); fill the remainder up to `targetDegree` (default **6**) with non-authority members in deterministic peerId order; log what the cap dropped.
3. **Skip already-connected** — diff against `controlNode.getConnections()` remote peerIds.
4. **Resolve + dial best-effort** — `resolvePeerAddrs` (signed/fresh/trust-gated `CadrePeer` record) with a libp2p **peerStore cold-start fallback**; per-peer try/catch (a dial failure logs and the pass continues; a failed dial retries next pass).

Concurrent triggers collapse into one in-flight pass (`reconcileControlCohortInFlight`, mirrors `registerSelfInFlight`). Guards on `_running`/`controlNode`/`controlDatabase` (re-checked after each await) make a post-`stop()` pass a no-op.

### Lifecycle wiring
- **Eager pass** once, ~1s after start (folded into `scheduleSelfRegistration`'s timer body, after `registerSelf` + `startRecordRefresh`).
- **Recurring `.unref()`'d interval** (`DEFAULT_CONTROL_COHORT_RECONCILE_MS = 15_000`, override `NetworkConfig.controlCohort.reconcileMs`) wired in `startRecordRefresh`, torn down in `stopRecordRefresh` (symmetric with `recordRefreshTimer`).
- **`self:peer:update`** now triggers a reconcile in addition to the self-republish (address/relay churn may have dropped a sibling).

### Config / exports
`NetworkConfig.controlCohort?: { targetDegree?; reconcileMs? }` (types.ts). Exported from index: `selectControlCohortDials`, `DEFAULT_CONTROL_COHORT_RECONCILE_MS`, `DEFAULT_CONTROL_COHORT_TARGET_DEGREE`, `ControlCohortSelection`.

## Validation performed (all green)
- `yarn workspace @serfab/cadre-core typecheck` — clean.
- `yarn workspace @serfab/cadre-core test` — **574 passed, 1 skipped** (43 files), incl. the 18 new unit tests.
- Integration: `control-cohort-auto-convergence.integration.ts` ✅ (converged ~1.5s, zero manual dials) and the pre-existing `control-db-two-node-convergence.integration.ts` ✅ (still passes, ~0.7s).
- `eslint` on all touched files — clean.

### Test coverage map (use cases)
- **Pure selection (`control-cohort.spec.ts`):** no-op when alone; all backbone dialed regardless of cap; non-authority fill capped at `targetDegree` with `cappedNonAuthority` remainder; full-mesh degeneration for small parties; determinism across input orderings; empty-authority fill; negative degree → backbone-only.
- **Orchestration (`cadre-node-control-cohort.spec.ts`):** no-op alone / no rows; dial a not-connected sibling; skip already-connected (no resolve, no dial); never dial self; skip on unresolvable address (no peerStore either); tolerate dial failure + continue; single-flight collapse of concurrent passes; early-return when `!_running` / null control node; targetDegree cap honored end-to-end.
- **Acceptance (`control-cohort-auto-convergence.integration.ts`):** B (reader, short 2s cadence) converges on an authority-written `CadrePeer` row using only the production cold-start path (`applySeed` + pinned-key trust) — **no** test-side `getControlNode().dial()`.

## Known gaps / honest flags for the reviewer
- **2-node test does not isolate the reconcile *dial* as sole load-bearing.** By design the routine cannot bootstrap from nothing — it only dials siblings already in the converged `CadrePeer` table — so in a 2-node party the FIRST connection necessarily comes from the cold-start path (`applySeed`'s authority dial). The acceptance test therefore proves *end-to-end auto-convergence via production APIs only* and that the recurring reconcile maintains/re-dials (every 2s), but a scenario where the reconcile dial is the SOLE connector needs a **≥3-node topology** (B learns sibling C via A, then dials C). Worth a follow-up test ticket if stronger isolation is wanted; the unit tests fully cover the dial/select/skip logic in isolation.
- **Write-while-alone durability is still open** (intentionally out of scope) — `control-write-ensure-replicated` (downstream, prereq = this ticket) builds the re-issue-on-cohort-growth remedy on top of this routine. Auto-connect shrinks but does not close that window.
- **NAT/relay sufficiency / WebRTC upgrade out of scope** — relayed control connections are accepted (they seat a peer in FRET); sustained relay-only edge↔edge is deferred to `rn-webrtc-transport`.
- **Shutdown-race robustness is guard-based, not AbortController-based** — an in-flight pass that races `cleanup()` re-checks `_running`/null handles between awaits and early-returns; a `getAuthorityKeys()` landing exactly as the DB closes would throw, but it is caught by the reconcile wrapper's `.catch` (logged, not crashed). Reviewer may want to confirm this is acceptable vs. a hard abort signal.
- **Backbone identification pre-AuthorityKey-convergence** — if `getAuthorityKeys()` is empty/partial, no member classifies as backbone yet and the bounded fill still dials up to `targetDegree` (progress made, preference sharpens later). Covered by the empty-authority unit test, not by an integration test.
