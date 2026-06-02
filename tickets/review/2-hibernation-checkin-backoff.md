description: Review — real cohort check-in on exponential backoff (resume → bounded window → re-hibernate), replacing the no-op fixed-interval timer
files: packages/cadre-core/src/types.ts, packages/cadre-core/src/hibernation-manager.ts, packages/cadre-core/src/cadre-node.ts, packages/cadre-core/test/hibernation-manager.spec.ts, packages/cadre-core/test/cadre-node.spec.ts, docs/architecture.md, docs/STATUS.md, tickets/backlog/hibernation-control-network-pending-precheck.md
----

## What landed

The hibernating-strand check-in is now **real** and **backed off**, replacing the old fixed `setInterval` whose body only advanced `nextCheckIn` (the "we just update the nextCheckIn timestamp" no-op).

### 1. Exponential backoff schedule (`types.ts`, `hibernation-manager.ts`)
- `HibernationTimeouts` gains `checkInBackoffFactor` (default 2) and `checkInMaxInterval` (per-hint cap). `checkInInterval` is now the **base** (first) delay. `HIBERNATION_TIMEOUTS` caps: interactive 30s→~1h, background 5m→~6h, archive 1h→~3d; realtime stays N/A (`Infinity`). All flow through `customTimeouts` (each field independently overridable) and `getTimeouts` merges them.
- `scheduleCheckIn` is now a **self-rescheduling single-shot `setTimeout` chain** (not `setInterval`). `runCheckIn` awaits `onCheckIn`, then: if the strand woke (`instance.status !== 'hibernating'`) it stops the chain; else it escalates `min(currentDelay × factor, cap)` and reschedules. The current delay is carried as a chain **parameter**, so backoff **auto-resets to base** on the next hibernation cycle (no per-strand counter to clear). This also fixes the latent `setInterval` bug (fixed period regardless of check-in duration) — the next tick is armed only *after* `onCheckIn` resolves, so a slow check-in never overlaps.
- `checkInTimers` map + `stop()`/`clearTimers()` switched from `clearInterval` to `clearTimeout`.

### 2. Real cohort check-in action (`hibernation-manager.ts`, `cadre-node.ts`)
- New `onCheckIn(strandId): Promise<void>` callback on `HibernationCallbacks`.
- `CadreNode.handleStrandCheckIn` implements **resume → bounded window → re-hibernate-if-idle**, reusing `resumeStrand`/`quiesceStrand` and `resolveCohortSeed`/`selectStrandMode` (same cohort re-resolution as wake):
  1. Resume the strand (rebuild node+db, re-resolve cohort seed/mode).
  2. Hold it live for `checkInWindowMs` (new `HibernationConfig` field, default `DEFAULT_CHECKIN_WINDOW_MS` = 15s; ≤0 resolves immediately). Extracted as `runCheckInWindow` so tests can stub it.
  3. If activity landed during the window (detected via `instance.lastActivity` **reference** change — `recordActivity` assigns a fresh `Date`), stay `active` + emit `strand:waking`; else `quiesceStrand` and mark `hibernating` (manager then escalates + reschedules).

### 3. Wake re-arms the lifecycle (`hibernation-manager.ts`) — resolves a prereq-flagged gap
- `recordActivity`'s wake branch now re-arms the idle→hibernate transition once the wake settles (guarded on `status === 'active'`). Previously a strand that woke then went quiet stayed `active` forever and never re-hibernated — which would make "backoff resets on next hibernation" unreachable via the activity-wake path. (Flagged by `1-hibernation-resource-release`'s review as belonging here.)

### 4. Docs + backlog
- `architecture.md`: check-in wake flipped from **(planned)** to **(implemented)** with the backoff + resume-as-reachability semantics and the pull-on-read caveat; latency-hint table now shows **base → cap**.
- `STATUS.md`: cohort-querying check-in checklist item flipped to `[x]` with the known gap noted.
- Filed `tickets/backlog/hibernation-control-network-pending-precheck.md` for the lighter same-cadre control-network pre-check optimization (overlaps `backlog/later/3-mobile-resource-awareness`).

## Open item resolved during implement (optimystic sync model)

Confirmed in `../optimystic`: **sync is pull-on-read only.** A resumed node does **not** proactively pull pending cohort transactions on connect; data is fetched lazily when a read/query touches a collection (`CoordinatorRepo.get` → read-repair → `fetchBlockFromCluster`). `IRepo`/`coordinatedRepo` expose only `get`/`pend`/`commit`/`cancel` — **no repo-level sync/pull/head API.** The only "pull latest" surface is `Collection.update()` / `Tree.update()` at the optimystic collection layer, which is **not** exposed through `StrandDatabase` and would require knowing the sApp's table names to drive a representative read.

**Consequence (honest landed behavior):** the check-in realizes "query the cohort for pending activity" as the **resume-as-reachability cycle** — it establishes connectivity and gives the app a window to drive reads, but it does **not itself** issue a representative read, so it never reports a false "synced". See gaps below.

## Use cases for testing / validation

Covered by the added tests (the floor, not the ceiling):

**`hibernation-manager.spec.ts` › check-in backoff** (fake timers, pinned to t=0; `FAST_BACKOFF`: base 100, ×2, cap 800):
- Escalating delays 100→200→400→800→800 with `nextCheckIn` advancing accordingly, capped at the per-hint ceiling.
- `onCheckIn` is awaited before the next tick (a blocked check-in never overlaps; `maxConcurrent === 1` across a 2000ms advance).
- A check-in that wakes the strand resets backoff: the first check-in of the **second** hibernation cycle fires at base (100), not the escalated 800.
- `recordActivity` wake re-arms the idle→hibernate cycle (idle fires again after a wake).
- A throwing `onCheckIn` does not break the chain (next tick still fires).

**`cadre-node.spec.ts` › hibernation orchestration** (injected fake `StrandInstanceManager` + control DB/node):
- No-activity check-in (`checkInWindowMs: 0`): resumes with a freshly re-resolved seed (`{bootstrapNodes:[], mode:'bootstrap'}` for solo cohort), then `quiesceStrand`s — left `hibernating`, no live node.
- Activity-during-window (stubbed `runCheckInWindow` advances `lastActivity`): stays `active`, never quiesces, emits `strand:waking`.

**Suggested reviewer probes (not yet covered):**
- `customTimeouts` overrides of `checkInBackoffFactor`/`checkInMaxInterval` actually flow through (only defaults are exercised end-to-end).
- `checkInWindowMs` config plumbing with a non-zero/`undefined` value.
- A real-network integration test (in `integration-tests/`) of resume→connect→read→re-hibernate against a live optimystic strand — see gap #1.

## Known gaps / honest flags (treat my work as a starting point)

1. **The check-in does not itself pull pending cohort transactions.** Per the optimystic finding above, "sync" relies on app-driven reads during the window. If no app code reads during the window, nothing is pulled and the strand re-hibernates even if peers had pending data. The real missing piece is a `StrandDatabase.sync()`-style hook that calls `Tree.update()`/`Collection.update()` for the strand's tables (needs the sApp table set). **Out of scope here; reviewer should weigh filing a follow-up** distinct from the parked control-network pre-check.
2. **Activity detection is app-driven only.** `handleStrandCheckIn` keys off `instance.lastActivity` (mutated solely by `recordActivity`). `connectedPeers` is not wired to a live libp2p connection-count yet, so "peers connected during the window" is **not** a usable signal — a window that connects but sees no app read still re-hibernates.
3. **The window is a fixed bounded sleep (default 15s).** No early-exit on activity/connection and no per-check-in retry. On a cold cohort, real connection setup may exceed 15s, in which case the check-in re-hibernates without having connected (the backoff cadence is the only retry). Reviewer: assess the default and whether connection-await/early-exit is worth adding.
4. **Manager ↔ CadreNode coupling via `instance.status`.** The manager decides wake-vs-escalate by reading `instance.status` after `onCheckIn` (CadreNode owns the mutation). The ticket specified `onCheckIn: Promise<void>`, so a boolean return wasn't used; the coupling is documented but worth a look.
5. **No real-node integration test.** Unit tests use injected fakes + a stubbed window; the resume→connect→read→re-hibernate cycle against live optimystic is unverified here.
6. **Force `wakeStrand(strandId)` re-arm gap remains.** The idle re-arm (item 3 in "What landed") lives in `recordActivity`, which has the `StrandInstance`. Force `wakeStrand` only has the `strandId` (the manager keeps no id→instance map), so an explicitly force-woken strand that goes quiet won't re-arm idle until the next activity. Common app-activity path is fixed; the rarer admin force-wake is not. Minor.
7. **Concurrency during an in-flight check-in.** While `onCheckIn` awaits (strand resumed → `active`), a concurrent `recordActivity` takes the active branch (re-arm idle, no second wake) and a concurrent force `wakeStrand` resumes idempotently; activity arriving while status is momentarily still `hibernating` mid-resume would trigger a second (idempotent) `resumeStrand`. Edge cases reasoned through, not exhaustively tested.

## Design decisions (by-design, confirming prereq questions)

- **Explicit launch mode does NOT survive wake/check-in** (confirms `1-hibernation-resource-release`'s open question). Both wake and check-in re-infer mode from current cohort membership via `selectStrandMode(undefined, hasOtherPeers)` — the intended `bootstrap → networked` correction as the cohort grows. No app pins mode across hibernation today, and "no backwards-compat yet", so re-inference is correct; the retained `launchConfig.mode` is intentionally not consulted.
- **Backoff state is the `setTimeout`-chain parameter, not a per-strand map** — reset is automatic on the next hibernation, nothing to clear on wake.
- **Event semantics:** the silent re-hibernate path emits **no** `strand:hibernating` (net-no-observable-change: it was hibernating, stays hibernating); only the activity-found path emits `strand:waking`. During the window the strand is genuinely live (`libp2pNode` present), so an observer polling `getStrand` mid-check-in will briefly see `active`.

## Validation
- `yarn workspace @serfab/cadre-core test` — **233 passed (17 files)** (+6 new: 5 check-in/backoff, 1 wake-re-arm; was 215 at the prereq's HEAD baseline).
- `yarn workspace @serfab/cadre-core typecheck` (`tsc -p tsconfig.build.json --noEmit`) — exit 0.
- `yarn workspace @serfab/cadre-core build` — exit 0. (No `lint` script; typecheck is the gate. cadre-core test files are not typechecked in CI per `STATUS.md`; specs reach privates via `as unknown` casts — runtime-only, consistent with the existing suite.)
