description: Review — strand hibernation now releases libp2p/db resources and rehydrates on wake
files: packages/cadre-core/src/strand-instance-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/index.ts, packages/cadre-core/test/strand-instance-manager-hibernation.spec.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md, docs/STATUS.md
----

## What landed

Hibernation used to be cosmetic: `handleStrandHibernate` only flipped `status = 'hibernating'` while the strand kept its full libp2p node + `StrandDatabase` open. It now **releases** strand-network resources and **rehydrates** them on wake.

### `StrandInstanceManager` (`strand-instance-manager.ts`)
- Extracted `private buildStrandRuntime(instance, config)` — the libp2p-node + `StrandDatabase` construction previously inline in `startStrand` (now identical logic, just shared). `startStrand` calls it; so does `resumeStrand`.
- Added `private launchConfigs: Map<string, StartStrandConfig>` — populated in `startStrand`, cleared in `stopStrand`. Holds the per-strand storage/network/profile/key/sApp config so `resumeStrand` doesn't need the caller to re-thread it. (We retain the **whole** `StartStrandConfig`, including the original `strandRow`, so no `StrandRow` reconstruction is needed — the ticket's fallback note about a minimal row is moot.)
- `quiesceStrand(strandId)`: closes `database`, stops `libp2pNode`, clears both, sets `connectedPeers = 0`, **retains** the instance + launch config. Leaves `status` for the caller. No-ops if missing or already quiesced.
- `resumeStrand(strandId, overrides?)`: rebuilds via `buildStrandRuntime`, re-applying `overrides.bootstrapNodes`/`overrides.mode` (and persisting them back into `launchConfigs` so a later resume reuses them). Sets `status = 'active'`. Throws if the strand isn't tracked / has no retained config; returns the live instance unchanged if already running.
- New exported type `ResumeStrandOverrides` (re-exported from `index.ts`).

### `CadreNode` (`cadre-node.ts`)
- `handleStrandHibernate` → `await strandManager.quiesceStrand(...)`, set `hibernating`, emit `strand:hibernating`. Guards missing / already-quiesced.
- `handleStrandWake` → if quiesced (no `libp2pNode`), re-resolve cohort seed (`resolveCohortSeed`) + mode (`selectStrandMode`) **exactly as `launchStrand` does**, then `resumeStrand(strandId, { bootstrapNodes, mode })`; set `lastActivity`, emit `strand:waking`. If still live (idle wake, or defensive), just flip status — no rebuild.

### `HibernationManager` (`hibernation-manager.ts`)
- Wake coalescing guard lives here (see "Design decision" below): `private wakePromises: Map<string, Promise<void>>` + `private beginWake(strandId)`. `recordActivity` and `wakeStrand` both route through `beginWake`, so `onWake` — and the libp2p rebuild it drives — runs **at most once per concurrent wake**. `recordActivity`'s previously fire-and-forget `void onWake(...)` now goes through `beginWake` (errors logged on the best-effort activity path; propagated to force-wake awaiters). `wakePromises` is cleared in `stop()`.

### Docs
- `docs/architecture.md` hibernation section: state table "Connections" column → "Strand-network resources" reflecting hibernating = node stopped/DB closed/zero connections, idle = still fully running (lightweight flag). Idle-vs-hibernating behavior + wake mechanisms rewritten to mark check-in/push-wake **(planned)** so the doc never describes unimplemented behavior. Realtime never-hibernate row kept (latency-hint table).
- `docs/STATUS.md`: new "Strand Hibernation (cadre-core)" checklist — release/rehydrate `[x]`, idle lightweight flag `[x]`, idle connection-trim `[ ]` (parked to backlog `3-mobile-resource-awareness`), cohort check-in `[ ]`, push-wake `[ ]`.

## Validation done

- `yarn workspace @serfab/cadre-core test` — **213 passed (17 files)**, including the existing real-libp2p-node tests in `strand-instance-manager.spec.ts` and `cadre-node.spec.ts` (the `buildStrandRuntime` extraction is behavior-preserving).
- `tsc -p tsconfig.build.json --noEmit` (the package `typecheck`) and `yarn build` — both exit 0.

New/extended tests:
- `strand-instance-manager-hibernation.spec.ts` (new, **mocks `createLibp2pNode` + `StrandDatabase`**): quiesce releases node/db once and retains the instance; quiesce is idempotent; resume rebuilds + re-applies override seed (asserts `createLibp2pNode` re-called with the new `bootstrapNodes`); resume rejects when untracked; resume no-ops a live instance; `stopStrand` after quiesce removes the instance + clears the launch config.
- `hibernation-manager.spec.ts` (extended): idle→hibernate timeouts fire `onHibernate`; **two near-simultaneous `recordActivity` calls fire `onWake` exactly once**; force `wakeStrand` coalesces with an in-flight activity wake.
- `cadre-node.spec.ts` (extended, fake strand manager + injected control DB): hibernate→wake drives `quiesceStrand` then `resumeStrand(strandId, { bootstrapNodes, mode })` with a **freshly re-resolved** seed (cohort grown → `networked`); `strand:hibernating`/`strand:waking` emit; idle-wake flips status without a rebuild.

## Reviewer focus / known gaps (your tests are a floor, not a ceiling)

1. **Design decision — coalescing guard is in `HibernationManager`, not `CadreNode`.** The ticket said "in CadreNode or the manager." All three wake call sites (`recordActivity`, `HibernationManager.wakeStrand`, `CadreNode.wakeStrand` → `hibernationManager.wakeStrand`) funnel through `HibernationManager`, so `beginWake` there coalesces all of them; `resumeStrand`'s own already-live early-return is a backstop. There is **no** separate guard in `CadreNode`. Consider whether a defensive guard around the `resolveCohortSeed`+`resumeStrand` orchestration is also wanted (today nothing calls `handleStrandWake` concurrently because of the upstream guard, so it'd be dead code).

2. **No end-to-end "real strand holds zero connections after hibernate" test.** The quiesce/resume unit test **mocks** `createLibp2pNode`/`StrandDatabase`, so it asserts `stop()`/`close()` were called and fields cleared — not that a real node actually dropped its transports/connections. A heavier integration test (start a real strand, hibernate, assert `getConnections().length === 0`, wake, assert it transacts again) would raise the floor. Not added here to keep the suite fast.

3. **Cadre-node test reaches into privates.** `cadre-node.spec.ts` injects a fake `strandManager`/`controlDatabase` and calls `handleStrandHibernate`/`handleStrandWake` via `as unknown` casts. It validates orchestration wiring, not the real manager. (cadre-core tests aren't typechecked in CI — STATUS.md "Type-check coverage" — so the casts are runtime-only.)

4. **Wake does not re-arm the idle→hibernate timer.** After a programmatic wake the strand stays `active` until the next `recordStrandActivity` (which reschedules idle only when `status === 'active'`). A woken strand that receives no further activity will **not** re-hibernate on its own. This matches pre-existing behavior, but matters more now that hibernation actually frees resources. Real cohort check-in (resume → sync → re-hibernate) is the prereq deliverable of `2-hibernation-checkin-backoff`, so this is intentionally left for that ticket — confirm you agree it belongs there, not here.

5. **Partial-failure paths.** `quiesceStrand` lets `database.close()` / `libp2pNode.stop()` errors propagate (unlike `stopStrand`, which catches and sets `status = 'error'`); a throw mid-quiesce can leave the instance half-released. `resumeStrand` on rebuild failure sets `status = 'error'` but keeps the instance + launch config, so a later wake retries the rebuild (possible retry loop if the failure is persistent). Decide whether either needs explicit cleanup/backoff.

6. **`idle` is honestly a no-op for resources.** Idle keeps node + DB running; only the status flag changes. Connection-trimming on idle is parked to backlog (`3-mobile-resource-awareness`) and the docs say so — verify the docs don't overstate.

## Downstream (already queued in implement/, do not action here)
- `2-hibernation-checkin-backoff` (prereq: this) — real cohort check-in on exponential backoff; will use the resume/re-hibernate path built here.
- `3-hibernation-push-wake` (prereq: checkin-backoff) — control-network push-wake; reuses `handleStrandWake`/`resumeStrand`.
