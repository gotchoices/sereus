description: Complete — strand hibernation releases libp2p/db resources and rehydrates on wake (reviewed)
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What landed

Hibernation now **releases** strand-network resources and **rehydrates** them on wake, instead of just flipping a status flag.

- `StrandInstanceManager`: shared `buildStrandRuntime` (used by `startStrand` + `resumeStrand`); retained `launchConfigs` map; `quiesceStrand` (release node/db, retain instance + config) and `resumeStrand` (rebuild, re-apply cohort `bootstrapNodes`/`mode`). New `ResumeStrandOverrides` type re-exported from `index.ts`.
- `CadreNode`: `handleStrandHibernate` → `quiesceStrand` + mark `hibernating`; `handleStrandWake` → re-resolve cohort seed/mode and `resumeStrand` (or flip status if still live).
- `HibernationManager`: wake coalescing via `wakePromises` + `beginWake`, so overlapping wakes rebuild the runtime at most once.
- Docs (`architecture.md`, `STATUS.md`) updated: hibernating = released, idle = lightweight flag; check-in/push-wake marked **(planned)**.

See the implement-stage handoff (commit `d3838d4`) for the full original write-up.

## Review findings

Reviewed the implement diff with fresh eyes across SPP/DRY/modularity/scalability/maintainability/performance/resource-cleanup/error-handling/type-safety, then ran lint-equivalent (typecheck) + tests.

### Checked
- **Resource cleanup / lifecycle** — quiesce/resume/stop teardown ordering and idempotency; partial-failure paths during build and during quiesce.
- **Error handling** — propagation from `quiesceStrand`/`resumeStrand` up through the `HibernationManager` timeout callbacks; unhandled-rejection surfaces.
- **Coalescing correctness** — `beginWake` dedupe across `recordActivity`, `HibernationManager.wakeStrand`, and `CadreNode.wakeStrand`; promise cleanup in `finally` and `stop()`.
- **Wake re-resolution** — confirmed `handleStrandWake` mirrors `launchStrand`'s `resolveCohortSeed` + `selectStrandMode`.
- **DRY** — quiesce/stop/build teardown duplication.
- **Type safety** — `tsc -p tsconfig.build.json --noEmit` clean. (Test files use `as unknown` casts to reach privates; cadre-core tests are not typechecked in CI per `STATUS.md`, so casts are runtime-only — accepted.)
- **Docs** — read every touched source file and confirmed `architecture.md`/`STATUS.md` match the new reality; `reference-app-rn.md` only references hibernation in a test checklist (no stale connection-behavior prose anywhere in `docs/`).
- **Cross-package fallout** — `quiesceStrand`/`resumeStrand`/`ResumeStrandOverrides` are consumed only within `cadre-core` (plus downstream implement tickets); no other package affected.

### Found + fixed inline (minor)
1. **Partial build-failure leaked the libp2p node and corrupted the "already live" guard.** `buildStrandRuntime` set `instance.libp2pNode = node` before `StrandDatabase.initialize()`. If init threw, the instance was left with `libp2pNode` set, `database` undefined, `status='error'`, and the node **never stopped** (leak). Worse, the `if (instance.libp2pNode || instance.database)` early-return in `resumeStrand` and `handleStrandWake` then saw `libp2pNode` truthy and falsely returned "already live" — handing back a strand with no database and **never retrying** the rebuild. (The implement handoff's gap #5 claimed "a later wake retries the rebuild"; that only holds when `createLibp2pNode` itself fails, not the db-init subcase, which did the opposite.) **Fix:** wrapped `buildStrandRuntime` in try/catch that rolls back any partially-attached runtime so the instance is left with *neither* handle; attach the db before `initialize()` so the rollback closes it (`StrandDatabase.close()` is null-safe on a partially-initialized db). Regression test added (`resume that fails to rebuild rolls back the partial runtime, so a later resume retries`).
2. **Unhandled promise rejection on hibernate/idle.** `HibernationManager.handleHibernateTimeout`/`handleIdleTimeout` invoked `void this.callbacks.onX(...).then(...)` with no `.catch`. Pre-change `onHibernate` could never throw (it only set a flag); now it `await`s `quiesceStrand`, whose `close()`/`stop()` errors propagate — so a failed hibernate produced an unhandled rejection (and silently skipped check-in scheduling). **Fix:** added `.catch` (log) to both timeout callback chains. Test added (`a rejecting onHibernate is caught …`).
3. **DRY.** The close-db-then-stop-node teardown was duplicated across `quiesceStrand`, `stopStrand`, and (now) build rollback. Extracted a private `releaseRuntime(instance)` shared by all three.

### Found, not fixed — deferred/by-design (documented, no new ticket)
- **Wake always re-infers mode, discarding an explicit launch mode.** `handleStrandWake` calls `selectStrandMode(undefined, hasOtherPeers)`, so a strand launched via `addStrand({ mode })` loses that explicit pin on wake (the retained `launchConfig.mode` is never consulted because the override is always non-undefined). This is consistent with the ticket's stated cohort re-resolution intent and harmless today (no app pins mode across hibernation; "no backwards-compat yet"). Flagged for **`2-hibernation-checkin-backoff`** to confirm whether explicit mode should survive wake.
- **Wake does not re-arm the idle→hibernate timer** (handoff gap #4). Confirmed genuinely pre-existing: even before this change `recordActivity` returned before the `status==='active'` reschedule (status is still `idle`/`hibernating` at that synchronous point). Belongs to **`2-hibernation-checkin-backoff`** (resume → sync → re-hibernate). Agreed.
- **`quiesceStrand` lacks the `this.stopping` guard that `resumeStrand` has.** Low-severity race only reachable if a hibernate timer fires mid-`stopAll`; `CadreNode.cleanup()` stops the `HibernationManager` (clearing timers) before `stopAll`, so practically unreachable. Left as-is.
- **No real-node "zero connections after hibernate" integration test** (handoff gap #2). The quiesce/resume unit test mocks `createLibp2pNode`/`StrandDatabase` and asserts `stop()`/`close()` + field clearing. A heavier integration test would raise the floor; out of scope to keep the suite fast. Agreed.
- **`cadre-node.spec.ts` reaches privates via casts** (handoff gap #3). Validates orchestration wiring only; accepted given cadre-core tests aren't typechecked in CI.

### Empty categories (explicit)
- **Security:** nothing relevant — change is intra-process lifecycle bookkeeping; no new inputs, auth, or network surface (schema-signature verification path unchanged).
- **Performance:** no regression — quiesce *frees* resources; rebuild cost on wake is the intended trade-off and already timed via `timing(...)`.

## Validation
- `yarn workspace @serfab/cadre-core test` — **215 passed (17 files)** (was 213 at HEAD; +2 new regression tests).
- `yarn workspace @serfab/cadre-core typecheck` (`tsc -p tsconfig.build.json --noEmit`) — exit 0. (No `lint` script in this package; typecheck is the gate. Build = same compile minus emit.)

## Downstream (already queued in implement/)
- `2-hibernation-checkin-backoff` (prereq: this) — real cohort check-in on exponential backoff; should also resolve the wake-re-arm and explicit-mode-on-wake questions above.
- `3-hibernation-push-wake` (prereq: checkin-backoff) — control-network push-wake; reuses `handleStrandWake`/`resumeStrand`.
