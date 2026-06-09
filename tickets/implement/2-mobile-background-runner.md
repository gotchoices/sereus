----
description: BackgroundRunner in the RN reference app that owns CadreNode lifecycle across foreground/background transitions via AppState
prereq: cadre-background-primitives
files: packages/reference-app-rn/src/cadre-phone.ts, packages/reference-app-rn/src/use-cadre.ts, packages/reference-app-rn/src/cadre-context.tsx, packages/reference-app-rn/app/_layout.tsx, packages/reference-app-rn/package.json
effort: high
----

The RN reference app currently runs the `CadreNode` for exactly as long as the React tree is mounted, started manually from the Settings screen (`use-cadre.ts:start()` → `cadre-phone.ts:startPhoneNode`). There is no `AppState` handling: when the app is backgrounded the node keeps a (soon-to-be-OS-killed) full footprint, and on return there is no managed resume. This ticket adds a `BackgroundRunner` that owns the lifecycle across OS foreground/background transitions, using the cadre-core primitives from `cadre-background-primitives`.

Scope is **AppState-driven lifecycle only**. The push/FCM/APNs receive path and native background-task configuration are the next ticket (`mobile-push-wake-receive`); this ticket must be shippable and testable without any push infrastructure.

### State machine

```
                 ┌──────────────┐  app foreground (AppState 'active')
                 │  FOREGROUND  │◄──────────────────────────────────┐
                 └──────┬───────┘                                   │
       AppState 'background'/'inactive'                             │
                        ▼                                           │
        node.hibernateAll() (non-realtime strands quiesce;          │
        control conn + realtime strands kept while OS permits)      │
                        ▼                                           │
              ┌───────────────────────┐  OS keeps process alive     │
              │ BACKGROUND_CONNECTED   │  (Android FGS / brief iOS)  │
              └──────────┬─────────────┘                            │
        OS suspends process / sockets drop / control disconnects    │
                        ▼                                           │
              ┌───────────────────────┐   foreground return ────────┘
              │ BACKGROUND_HIBERNATING │   (full resume, re-sync control)
              └──────────┬─────────────┘
                  process killed
                        ▼
                  ┌──────────────┐
                  │  TERMINATED  │  (cold start next launch)
                  └──────────────┘
```

- **FOREGROUND**: normal operation; node running, strands live per their latency hints.
- **BACKGROUND_CONNECTED**: entered immediately on background. `hibernateAll()` quiesces non-realtime strands; the control connection and any realtime strands stay up *if the OS allows it*. On Android this is the window before/with a foreground service; on iOS it is the brief grace period before suspension.
- **BACKGROUND_HIBERNATING**: the OS has suspended the process or torn down sockets. cadre-core's `controlConnected` is false; nothing runs. (On iOS this is reached almost immediately after backgrounding; on Android only under Doze / FGS teardown.) Transition is detected by `control:disconnected` and/or AppState, not assumed.
- **TERMINATED**: process killed; next launch is a cold start that re-runs `startPhoneNode` and lands in FOREGROUND.
- **Foreground return from any background state**: full resume — ensure node started, re-establish/await control connection, then mark ready. Surface a `resume in progress` flag for the UI ("sync progress until control network caught up", per the use case).

### Interface

New `packages/reference-app-rn/src/background-runner.ts`:

```ts
export type RunnerState = 'foreground' | 'background-connected' | 'background-hibernating' | 'terminated';

export interface BackgroundRunner {
  readonly state: RunnerState;
  readonly resuming: boolean;          // true while a foreground resume is settling
  start(): void;                       // subscribe to AppState; assumes node already started
  stop(): void;                        // unsubscribe (component unmount / logout)
  onStateChange(cb: (s: RunnerState) => void): () => void;
}

export function createBackgroundRunner(deps: {
  getNode: () => CadreNode | null;     // cadre-phone.getPhoneNode
  appState: AppStateLike;              // injectable wrapper over react-native AppState (testability)
}): BackgroundRunner;
```

Wire it into the existing context layer: `use-cadre.ts` (or a sibling `use-background-runner.ts`) creates the runner once the node is started, exposes `state`/`resuming` for the UI, and tears it down on `stop()`/unmount. Do **not** put this in `cadre-core` (platform-agnostic) — it belongs in the RN app per the parent design.

`AppStateLike` is a thin interface (`addEventListener(type, handler) => subscription`) so tests inject a fake and drive transitions without a device. Use react-native's `AppState` as the production impl.

### Behavior on transitions

- **active → background/inactive**: call `node.hibernateAll()`. Move to BACKGROUND_CONNECTED. Do not stop the node.
- **`control:disconnected` while backgrounded**: move BACKGROUND_CONNECTED → BACKGROUND_HIBERNATING.
- **background → active**: set `resuming=true`; ensure node running (cold-start path calls `startPhoneNode`); await `controlConnected` (event or a bounded settle timeout); `resuming=false`; state=FOREGROUND. Realtime strands resume via existing wake on activity.
- **cold start** (no node yet, e.g. relaunch after TERMINATED): runner starts in FOREGROUND once `startPhoneNode` completes.

### Edge cases & interactions

- **iOS vs Android divergence**: iOS suspends sockets within seconds of backgrounding regardless of `hibernateAll`; BACKGROUND_CONNECTED is effectively transient there. Android (with the FGS from the next ticket) can hold BACKGROUND_CONNECTED longer. The state machine must treat BACKGROUND_CONNECTED as *best-effort* and rely on `control:disconnected` to fall to BACKGROUND_HIBERNATING — never assume the connection survived.
- **Rapid foreground/background flapping** (user swiping app switcher): debounce/guard so overlapping hibernate and resume don't race; a resume in progress when a new background event arrives must settle deterministically (e.g. cancel resume, re-hibernate). Idempotency of `hibernateAll` (returns only newly-hibernated ids) helps.
- **AppState 'inactive' (iOS transient: incoming call, control center)** vs 'background': decide whether 'inactive' triggers hibernation. Recommended: treat only 'background' as the hibernate trigger; 'inactive' is a no-op (avoids hibernating during a transient overlay). Document the choice.
- **Resume when control never reconnects** (no network / drone unreachable): bounded settle timeout must clear `resuming` and surface a degraded/offline state to the UI rather than spinning forever.
- **node === null** at transition time (stopped via Settings while backgrounded): transitions must no-op safely.
- **Double start / double stop**: `start()`/`stop()` idempotent; `stop()` must remove the AppState subscription and any node event listeners to avoid leaks across remounts (the hook already manages event subscriptions in `use-cadre.ts:103-145` — follow that teardown pattern).
- **Realtime strand during background**: `hibernateAll` leaves realtime strands running; if the OS suspends anyway, they hibernate via socket loss and resume on foreground. Ensure the runner does not force-hibernate realtime strands (cadre-core already guards this).
- **Interaction with manual Settings start/stop**: the existing manual controls must still work; the runner observes the node lifecycle rather than fighting it.

### Key tests (expected outputs)

Use the injectable `AppStateLike` fake + a stub/mock `CadreNode` exposing `hibernateAll`/`running`/`controlConnected` and an event emitter.

- active → background → `hibernateAll()` called once; state `background-connected`.
- backgrounded + `control:disconnected` emitted → state `background-hibernating`.
- background → active → `resuming` true then false; state `foreground`; node start ensured.
- 'inactive' transition → no `hibernateAll` call (no-op).
- flap (background→active→background quickly) → no overlapping resume; ends in a consistent state.
- resume with control never connecting → `resuming` clears after settle timeout; degraded state surfaced.
- `stop()` removes subscriptions (no further transitions after stop).

## TODO

- [ ] Add `background-runner.ts` with the `RunnerState` machine and injectable `AppStateLike`
- [ ] `AppState` production wrapper; subscribe in runner `start()`, unsubscribe in `stop()`
- [ ] On background: `hibernateAll()`; on `control:disconnected`: → background-hibernating
- [ ] On foreground: ensure node running (cold-start via `startPhoneNode`), await `controlConnected` with bounded settle, expose `resuming`
- [ ] Decide & document 'inactive' vs 'background' handling
- [ ] Wire runner into `use-cadre.ts`/`cadre-context.tsx`; expose `state`/`resuming`; tear down on unmount
- [ ] (Optional, light) reflect resume/sync progress in the connection status bar (`app/index.tsx`)
- [ ] Unit tests with fake AppState + mock node
- [ ] `yarn workspace @serfab/reference-app-rn typecheck` (+ tests if the package has a runner) green
