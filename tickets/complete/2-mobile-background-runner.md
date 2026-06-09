----
description: RN BackgroundRunner that owns CadreNode lifecycle across foreground/background transitions via AppState
files: packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/src/app-state.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/test/background-runner.spec.ts, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/package.json, docs/architecture.md, docs/STATUS.md
----

## What shipped

An `AppState`-driven `BackgroundRunner` for the RN reference app that owns the `CadreNode` lifecycle
across OS foreground/background transitions, consuming the cadre-core background primitives
(`hibernateAll`, `running`/`controlConnected`, `control:connected`/`control:disconnected`) from
`cadre-background-primitives`. Push/FCM/APNs receive + native background-task config are out of scope
(follow-up `mobile-push-wake-receive`, now in `tickets/implement/3-mobile-push-wake-receive.md`).

```
FOREGROUND ──'background'──► BACKGROUND_CONNECTED ──control:disconnected──►
BACKGROUND_HIBERNATING ──'active' (epoch-guarded resume)──► FOREGROUND
```

- `src/background-runner.ts` — pure-TS `createBackgroundRunner(deps)` (no `react-native` import); state
  machine, monotonic-`epoch` flap safety, bounded resume settle (`settleTimeoutMs`, default 15s) with
  `resuming`/`degraded`. `'background'` hibernates; `'inactive'` is a deliberate no-op.
- `src/app-state.ts` — production `AppStateLike` over react-native's `AppState`, isolated so the runner
  and its tests never import RN.
- `src/use-cadre.ts` — creates/starts the runner once the node exists; exposes `runnerState`/`resuming`/
  `degraded`; cold-starts via `ensureNode` (re-runs `startPhoneNode` with the last opts).
- `app/index.tsx` — status bar shows "Resuming — syncing…" while resuming and "Offline — reconnecting…"
  while degraded.
- `test/background-runner.spec.ts` (vitest, node env) + `vitest.config.ts` + `vitest` dev-dep.

## Review findings

**Process:** read the implement diff (`77577bc`) with fresh eyes before the handoff. Verified via an
explore pass that every cadre-core member the runner consumes exists with the exact expected signature
(`hibernateAll(): Promise<string[]>`, `running`/`controlConnected` boolean getters, typed
`CadreNodeEvents` map with `control:connected`/`control:disconnected` as `void`-payload events,
`on`/`off` generic over the event map, `CadreNode` exported from the package entry). Re-ran the full
gate after fixes: `cadre-core build` (exit 0), `reference-app-rn typecheck` (exit 0), `test` (**13
passed**, was 11), eslint on all touched files + `app/index.tsx` (exit 0).

**Correctness — checked, no defects found:**
- **Flap safety.** Every AppState transition bumps `epoch`; async handlers capture it at entry and bail
  after each `await` if superseded. Traced background→active→background: the late resume's post-await
  `epoch !== myEpoch` guard returns before any state write, so it cannot clobber the second background
  (covered by the flap test).
- **`hibernateAll` race.** `handleBackground` sets `background-connected` synchronously, then awaits
  `hibernateAll` with no post-await state write — a foreground flap that supersedes mid-await owns state.
- **`control:disconnected` semantics.** No-op while foreground (transient churn the node reconnects
  from); only `background-connected → background-hibernating` while backgrounded — matches the
  iOS-suspends-fast / Android-FGS-holds-longer divergence the ticket calls out.
- **node === null transitions** no-op safely (background stays `background-connected`, no hibernate).
- **Cold-start ↔ effect-recreate** (implementer asked to scrutinize): `ensureNode`'s `setNode` recreates
  the runner effect mid-resume; the old runner's in-flight `handleForeground` aborts via the `epoch`
  bump from `stop()`, the fresh runner re-enters `foreground`, and the hook's `sync()` after the new
  `start()` re-reads `resuming=false` — converges. Confirmed benign (runtime-untested; see below).

**Minor — fixed inline this pass:**
- **`stop()` during an in-flight resume settle leaked the `control:connected` listener.**
  `awaitControlConnected`'s doc promised "Always cleans up its listener + timer," but its only cleanup
  path is `finish()`, reached via the event or the settle timer. `stop()` did `clearTimeout(timer)`
  *without* calling `finish`, so on a stop mid-settle the timer's `finish(false)` could never fire and
  the `control:connected` one-shot stayed attached to the (singleton) node — a listener + pending-promise
  leak, accumulating across stop-during-settle cycles while control stayed down. Fix: track each settle's
  `finish` in a `pendingSettles` set; `stop()` now aborts them (removes listener + timer, resolves false;
  the `epoch` bump makes the resolved handler bail). Added test
  `'stop() during an in-flight resume settle tears down the control:connected listener (no leak)'`.
- **`degraded` never reached the UI** — the ticket explicitly required the bounded settle to "surface a
  degraded/offline state **to the UI**." The runner computed `degraded` (and a unit test asserted it),
  but `use-cadre.ts`'s `sync()` propagated only `state`/`resuming`; `degraded` was dropped, so after a
  resume timeout the status bar reverted to the stale `cadre.status` (still green "Connected"). Fix:
  surfaced `degraded` through `UseCadreResult` and the status bar ("Offline — reconnecting…", red).
- **Stale `degraded` after self-recovery.** Nothing cleared `degraded` until the next background cycle,
  so once surfaced it would stick even after the control network recovered on its own. Fix: a persistent
  `onControlConnected` listener clears `degraded` when a `control:connected` arrives while foregrounded
  (no-op during settle, where state isn't yet `foreground`). Added test
  `'degraded clears when control reconnects on its own while foregrounded'`.
- **Docs were stale.** `architecture.md` (Wake Mechanisms #3/#4) and `STATUS.md` still pointed the
  push-wake and RN-runner work at the deleted `tickets/backlog/3-mobile-background-service.md` and
  described the RN runner as unbuilt. Repointed the push references to
  `tickets/implement/3-mobile-push-wake-receive.md` and updated the imperative-lifecycle bullet to record
  that the `AppState`-driven `BackgroundRunner` has shipped in `reference-app-rn`.

**Major — filed as follow-up ticket:**
- **No React-layer runtime test.** The package has a node-only vitest runner and no React renderer, so
  `use-cadre.ts`'s runner effect, `ensureNode` cold-start re-sync, the cold-start↔effect-recreate
  interaction, and `runnerState`/`resuming`/`degraded` → UI propagation are type-checked but not
  runtime-exercised. Also flagged a latent edge: `optsRef.current` is only set by `start()`, so a mount
  that finds `getPhoneNode()` already running (without a `start()` this session) cannot cold-start.
  → `tickets/backlog/reference-app-rn-react-test-harness.md`.

**Not done (out of scope, accepted):**
- **No real-node / device integration.** Tests use a `MockNode`; the interplay with a live `CadreNode`
  (real socket teardown emitting `control:disconnected`, resume re-sync timing) and any Detox/device run
  are owned by the push follow-up and the e2e harness, not this ticket. No new ticket filed — already
  tracked downstream.
- **`app-state.ts`** (thin RN pass-through) is intentionally excluded from the node vitest run; it has no
  logic beyond narrowing the status type.
- **`TERMINATED`** remains an unassigned enum arm by design (a killed process can't run code to set it;
  the next launch is a cold start into `FOREGROUND`) — kept in the type for the UI/push ticket.

## Validation

```
yarn workspace @serfab/cadre-core build            # exit 0 (RN consumes cadre-core's built dist types)
yarn workspace @serfab/reference-app-rn typecheck  # exit 0
yarn workspace @serfab/reference-app-rn test        # 13 passed
npx eslint packages/reference-app-rn/src/background-runner.ts \
  packages/reference-app-rn/src/app-state.ts packages/reference-app-rn/src/use-cadre.ts \
  packages/reference-app-rn/test/background-runner.spec.ts packages/reference-app-rn/app/index.tsx  # exit 0
```

cadre-core `dist` was stale relative to its committed source at HEAD (primitives source had landed,
`dist` is gitignored); rebuilding it is the standard monorepo build order, not a defect. No
`.pre-existing-error.md` filed (no test failure).
