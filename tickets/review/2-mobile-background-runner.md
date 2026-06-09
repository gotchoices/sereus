----
description: Review the RN BackgroundRunner that owns CadreNode lifecycle across foreground/background transitions via AppState
files: packages/reference-app-rn/src/background-runner.ts, packages/reference-app-rn/src/app-state.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/app/index.tsx, packages/reference-app-rn/test/background-runner.spec.ts, packages/reference-app-rn/vitest.config.ts, packages/reference-app-rn/package.json
----

## What shipped

An AppState-driven `BackgroundRunner` for the RN reference app that owns the `CadreNode`
lifecycle across OS foreground/background transitions, consuming the cadre-core primitives
(`hibernateAll`, `running`/`controlConnected`, `control:connected`/`control:disconnected`) that
landed in `cadre-background-primitives`. Push/FCM/APNs receive + native background-task config are
explicitly **out of scope** (next ticket `mobile-push-wake-receive`); this ships and tests with no
push infra.

### New files

- **`src/background-runner.ts`** — `createBackgroundRunner(deps)` factory returning a
  `BackgroundRunner` (`state`, `resuming`, `degraded`, `start`, `stop`, `onStateChange`). Pure
  TS; depends only on the injectable `AppStateLike` interface + a `getNode` accessor — **no
  `react-native` import**, so it unit-tests in plain node.
- **`src/app-state.ts`** — `createReactNativeAppState()`, the production `AppStateLike` over
  react-native's `AppState`. Isolated here so the runner module (and its tests) never import RN.
- **`test/background-runner.spec.ts`** — 11 vitest cases with a `FakeAppState` + `MockNode`.
- **`vitest.config.ts`** — node-environment runner; the package had no test runner before, so
  vitest `^4.0.17` + `test`/`dev:test` scripts were added to `package.json`.

### Modified

- **`src/use-cadre.ts`** — creates/starts the runner in a `useEffect([node, ensureNode])` once the
  node exists; exposes `runnerState` + `resuming` on `UseCadreResult`; tears the runner down on
  unmount/stop. `ensureNode` re-runs `startPhoneNode` (last opts kept in `optsRef`) for cold-start
  on foreground return; `start()` stores opts.
- **`app/index.tsx`** — chat status bar shows "Resuming — syncing…" (orange) while `cadre.resuming`.

### State machine & key decisions

```
FOREGROUND ──'background'──► BACKGROUND_CONNECTED ──control:disconnected──►
BACKGROUND_HIBERNATING ──'active' (resume, epoch-guarded)──► FOREGROUND
```

- **`'background'` triggers `hibernateAll()`; `'inactive'` is a deliberate no-op** (avoids tearing
  down strands during a transient iOS overlay — incoming call / control center / switcher peek).
  Documented at `handleAppState`.
- **BACKGROUND_CONNECTED is best-effort.** The drop to BACKGROUND_HIBERNATING is driven only by the
  real `control:disconnected` edge, never assumed — matches the iOS-suspends-in-seconds /
  Android-FGS-holds-longer divergence.
- **Flap safety via a monotonic `epoch`.** Every AppState transition bumps `epoch`; async handlers
  capture it at entry and bail after each `await` if superseded. A late resume cannot clobber a
  subsequent background.
- **Bounded resume settle** (`settleTimeoutMs`, default 15s): if `control:connected` never fires,
  `resuming` clears and `degraded` is set (UI shows offline rather than spinning forever).
- **`degraded`, `ensureNode`, `settleTimeoutMs` are additions beyond the ticket's literal
  interface.** Rationale: the ticket's stated `deps` (`getNode` + `appState` only) **cannot
  cold-start** a killed node as the behavior section requires — `ensureNode` is the cold-start hook.
  `degraded` makes "surface a degraded/offline state" observable/assertable. Both are optional or
  derived; the required surface (`state`/`resuming`/`start`/`stop`/`onStateChange`) is intact.

## How to validate

```
# RN package consumes cadre-core's BUILT dist types — build it first (it was stale at HEAD;
# the primitives source had landed but dist is gitignored). CI/`yarn build` does this in topo order.
yarn workspace @serfab/cadre-core build
yarn workspace @serfab/reference-app-rn typecheck   # exit 0
yarn workspace @serfab/reference-app-rn test         # 11 passed
npx eslint packages/reference-app-rn/src/background-runner.ts \
  packages/reference-app-rn/src/app-state.ts packages/reference-app-rn/src/use-cadre.ts \
  packages/reference-app-rn/test/background-runner.spec.ts packages/reference-app-rn/app/index.tsx
```

### Test coverage (the floor — extend, don't trust as ceiling)

Each ticket "Key test" is covered:
- active → background → `hibernateAll()` called once; `state==='background-connected'`.
- backgrounded + `control:disconnected` → `background-hibernating`.
- background → active → `resuming` true then false; `foreground`; `degraded===false`.
- cold start: foreground with `getNode()===null` → `ensureNode` called once; ends `foreground`.
- `'inactive'` → no `hibernateAll`; stays `foreground`.
- `node===null` at background → safe no-op (still `background-connected`, no hibernate).
- flap (background→active→background) → ends `background-connected`, `resuming===false`.
- resume, control never connects → `resuming` clears after 5s fake-timer settle, `degraded===true`.
- `stop()` removes AppState subscription + node `control:disconnected` listener; no further
  transitions; idempotent `start`/`stop`; `onStateChange` notify + unsubscribe.

## Known gaps / things to probe (treat my work as a starting point)

- **No real-node integration.** Tests use a `MockNode`; the interplay with the *real* `CadreNode`
  (`hibernateAll` over live strands, actual socket teardown emitting `control:disconnected`, resume
  re-sync timing) is reasoned about, not exercised. There is no device/Detox test in this ticket.
  Highest-value place for an adversarial reviewer to push.
- **Hook wiring is type-checked, not runtime-tested.** The `use-cadre.ts` runner effect, `ensureNode`
  cold-start (`setNode`/`setPeerId`/`setStrands` re-sync), and `runnerState`/`resuming` → UI
  propagation have **no React test** (the package has no RTL/react-test-renderer harness). Verify by
  reading, or consider adding a `renderHook` test.
- **Cold-start ↔ effect-recreate interaction (please scrutinize).** On a background→active resume
  where the node was killed, `ensureNode` calls `setNode(started)`. That state change makes the
  `useEffect([node, ensureNode])` tear down and recreate the runner *mid-resume*. The old runner's
  in-flight `handleForeground` aborts via the `epoch` bump from `stop()`, and the fresh runner
  re-enters `foreground` — so it converges, but `resuming` may flicker and the resume settle is
  effectively restarted by the new runner. I believe this is benign; it is not directly tested.
- **TERMINATED is unreachable in-process by design.** It is part of the type (for the UI / push
  ticket) but the runner never assigns it — a process that was killed cannot run code to set it; the
  next launch is a cold start landing in FOREGROUND. One enum arm therefore has no path/test.
- **`getNode` vs React `node`.** The runner reads the live `getPhoneNode()` singleton (always
  current), while the hook also tracks `node` in state. Confirm no divergence assumption bites
  (e.g. a manual Settings `stop()` while backgrounded — the runner's `getNode()` then returns null
  and transitions no-op, which is intended).
- **`app-state.ts` is untested** (thin RN pass-through; excluded from the node vitest run by design).

## Pre-existing notes

- cadre-core `dist` was stale relative to its committed source at HEAD (primitives source landed,
  dist is gitignored). Rebuilding it is required before RN typecheck — standard monorepo build order,
  not a defect introduced here. No `.pre-existing-error.md` filed (not a test failure).
