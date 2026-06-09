/**
 * background-runner.ts — owns the {@link CadreNode} lifecycle across OS
 * foreground/background transitions for the RN reference app.
 *
 * The node otherwise runs only while the React tree is mounted (started by hand
 * from Settings). This runner subscribes to `AppState` and drives the cadre-core
 * background primitives (`hibernateAll`, the `control:*` readiness edges) so the
 * footprint quiesces on background and a managed resume re-syncs the control
 * network on foreground return.
 *
 * Scope is **AppState-driven lifecycle only** — the push/FCM/APNs receive path
 * and native background-task config land in `mobile-push-wake-receive`. This file
 * is platform-agnostic apart from the injectable {@link AppStateLike}; the
 * production `AppState` wrapper lives in `app-state.ts` so this module (and its
 * unit tests) never import `react-native`.
 *
 * State machine:
 *
 *   FOREGROUND ──background──► BACKGROUND_CONNECTED ──control:disconnected──►
 *   BACKGROUND_HIBERNATING ──active──► (resume) ──► FOREGROUND
 *
 * BACKGROUND_CONNECTED is **best-effort**: iOS suspends sockets within seconds
 * regardless of `hibernateAll`, Android (with the future foreground service) can
 * hold it longer. We never assume the connection survived — the drop to
 * BACKGROUND_HIBERNATING is driven by the real `control:disconnected` edge.
 */

import type { CadreNode } from '@serfab/cadre-core';

// ── Public types ──────────────────────────────────────────────────────────────

export type RunnerState =
  | 'foreground'
  | 'background-connected'
  | 'background-hibernating'
  | 'terminated';

/**
 * Subset of an `AppState` event subscription we depend on. Matches the object
 * react-native's `AppState.addEventListener` returns.
 */
export interface AppStateSubscription {
  remove(): void;
}

/** AppState status values the runner reacts to (others are ignored). */
export type AppStateValue = 'active' | 'background' | 'inactive' | string;

/**
 * Thin, injectable wrapper over react-native's `AppState` so unit tests can
 * drive transitions with a fake and no device. The production impl is
 * {@link createReactNativeAppState} in `app-state.ts`.
 */
export interface AppStateLike {
  addEventListener(
    type: 'change',
    handler: (status: AppStateValue) => void,
  ): AppStateSubscription;
}

export interface BackgroundRunner {
  /** Current lifecycle state. */
  readonly state: RunnerState;
  /** True while a foreground resume is settling (awaiting control reconnect). */
  readonly resuming: boolean;
  /**
   * True after a resume settled without the control network reconnecting
   * (bounded settle timeout fired) — the UI should show an offline/degraded
   * hint rather than spin. Cleared whenever a fresh resume begins.
   */
  readonly degraded: boolean;
  /** Subscribe to AppState. Assumes the node is already (or will be) started. Idempotent. */
  start(): void;
  /** Unsubscribe and drop node listeners (component unmount / logout). Idempotent. */
  stop(): void;
  /**
   * Observe state/resuming/degraded changes. The callback receives the current
   * {@link RunnerState}; read `runner.resuming`/`runner.degraded` for the rest.
   * Returns an unsubscribe fn.
   */
  onStateChange(cb: (s: RunnerState) => void): () => void;
}

export interface BackgroundRunnerDeps {
  /** Returns the live node singleton (e.g. `cadre-phone.getPhoneNode`), or null if stopped. */
  getNode: () => CadreNode | null;
  /** Injectable AppState (react-native in prod, a fake in tests). */
  appState: AppStateLike;
  /**
   * Cold-start hook: re-run `startPhoneNode` when a foreground return finds the
   * node stopped/killed. Optional — without it the runner only awaits an
   * already-present node's control connection. Must be idempotent.
   */
  ensureNode?: () => Promise<void>;
  /**
   * Bounded resume settle: max wait for `control:connected` on foreground return
   * before clearing `resuming` and surfacing a degraded state. Default 15s.
   */
  settleTimeoutMs?: number;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 15_000;

// ── Implementation ──────────────────────────────────────────────────────────────

/**
 * Create a {@link BackgroundRunner}. Construction is inert — call `start()` to
 * subscribe to AppState.
 *
 * Concurrency model: every AppState transition bumps a monotonic `epoch`. Async
 * handlers (hibernate sweep, resume settle) capture the epoch at entry and bail
 * after each `await` if a newer transition has superseded them. This makes rapid
 * foreground/background flapping deterministic — a late-completing resume can
 * never clobber the state a subsequent background event already set.
 */
export function createBackgroundRunner(deps: BackgroundRunnerDeps): BackgroundRunner {
  const settleTimeoutMs = deps.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;

  let state: RunnerState = 'foreground';
  let resuming = false;
  let degraded = false;
  let epoch = 0;
  let active = false;

  let subscription: AppStateSubscription | null = null;
  let listenedNode: CadreNode | null = null;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  // In-flight `awaitControlConnected` teardowns, so `stop()` can abort a settle
  // mid-flight (removing its `control:connected` listener + timer) instead of
  // orphaning them — `clearTimeout` alone would leave the listener attached.
  const pendingSettles = new Set<(connected: boolean) => void>();
  const stateListeners = new Set<(s: RunnerState) => void>();

  // ── notification ────────────────────────────────────────────────────────────

  function notify(): void {
    for (const cb of stateListeners) {
      try {
        cb(state);
      } catch (err) {
        console.warn('[background-runner] state listener threw:', err);
      }
    }
  }

  function setState(next: RunnerState): void {
    if (state === next) return;
    state = next;
    notify();
  }

  function setResuming(next: boolean): void {
    if (resuming === next) return;
    resuming = next;
    notify();
  }

  function setDegraded(next: boolean): void {
    if (degraded === next) return;
    degraded = next;
    notify();
  }

  // ── node event listeners ──────────────────────────────────────────────────────

  // A `control:disconnected` while backgrounded is the signal that the OS tore
  // down sockets / suspended us — drop BACKGROUND_CONNECTED → BACKGROUND_HIBERNATING.
  // While foreground it's transient churn the node will reconnect from; ignore it.
  function onControlDisconnected(): void {
    if (state === 'background-connected') {
      setState('background-hibernating');
    }
  }

  // A `control:connected` that arrives while we are already foregrounded and
  // degraded means the control network recovered on its own (no app-lifecycle
  // transition to drive a fresh resume). Clear the stale degraded hint so the UI
  // stops showing offline. During a resume settle, state is not yet 'foreground',
  // so this no-ops and the settle's own one-shot listener owns the outcome.
  function onControlConnected(): void {
    if (state === 'foreground' && degraded) {
      setDegraded(false);
    }
  }

  function attachNodeListeners(): void {
    const node = deps.getNode();
    if (node === listenedNode) return;
    detachNodeListeners();
    if (!node) return;
    node.on('control:disconnected', onControlDisconnected);
    node.on('control:connected', onControlConnected);
    listenedNode = node;
  }

  function detachNodeListeners(): void {
    if (!listenedNode) return;
    listenedNode.off('control:disconnected', onControlDisconnected);
    listenedNode.off('control:connected', onControlConnected);
    listenedNode = null;
  }

  // ── settle helper ────────────────────────────────────────────────────────────

  /**
   * Resolve when the node's control network connects, or after the bounded
   * settle timeout — whichever first. Resolves to `true` if connected, `false`
   * if it timed out (degraded). Always cleans up its listener + timer.
   */
  function awaitControlConnected(node: CadreNode): Promise<boolean> {
    if (node.controlConnected) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        node.off('control:connected', onConnected);
        pendingTimers.delete(timer);
        clearTimeout(timer);
        pendingSettles.delete(finish);
        resolve(connected);
      };
      const onConnected = () => finish(true);
      node.on('control:connected', onConnected);
      const timer = setTimeout(() => finish(false), settleTimeoutMs);
      pendingTimers.add(timer);
      pendingSettles.add(finish);
      // Guard a connect that raced in between the initial check and subscribe.
      if (node.controlConnected) finish(true);
    });
  }

  // ── transition handlers ────────────────────────────────────────────────────────

  // active → background: quiesce non-realtime strands and move to
  // BACKGROUND_CONNECTED. We do NOT stop the node — the control connection and
  // realtime strands stay up for as long as the OS permits. A superseding
  // foreground event (flap) bumps the epoch and owns state after our await.
  async function handleBackground(): Promise<void> {
    const myEpoch = ++epoch;
    setResuming(false); // cancel any in-flight resume settle
    setDegraded(false);
    setState('background-connected');

    const node = deps.getNode();
    if (!node || !node.running) return; // node null/stopped → no-op safely
    try {
      await node.hibernateAll();
    } catch (err) {
      console.warn('[background-runner] hibernateAll failed:', err);
    }
    // No post-await state write: if a foreground flap superseded us
    // (epoch changed), that handler now owns the state.
    void myEpoch;
  }

  // background → active: full resume. Ensure the node is running (cold-start via
  // `ensureNode`), await the control connection (bounded), then settle to
  // FOREGROUND. Each await is epoch-guarded so a background flap mid-resume aborts
  // cleanly rather than racing a hibernate.
  async function handleForeground(): Promise<void> {
    const myEpoch = ++epoch;
    setDegraded(false);
    setResuming(true);

    if (!deps.getNode() && deps.ensureNode) {
      await runEnsureNode();
      if (epoch !== myEpoch) return; // superseded by a background flap
    }

    const node = deps.getNode();
    if (node && !node.running && deps.ensureNode) {
      await runEnsureNode();
      if (epoch !== myEpoch) return;
    }

    attachNodeListeners();

    const live = deps.getNode();
    if (live) {
      const connected = await awaitControlConnected(live);
      if (epoch !== myEpoch) return;
      setDegraded(!connected);
    }

    setResuming(false);
    setState('foreground');
  }

  async function runEnsureNode(): Promise<void> {
    try {
      await deps.ensureNode!();
    } catch (err) {
      console.warn('[background-runner] ensureNode (cold start) failed:', err);
    }
  }

  // 'inactive' (iOS transient overlay: incoming call, control center, app
  // switcher peek) is deliberately a no-op — hibernating on it would tear down
  // strands during a brief overlay the user immediately dismisses. Only a real
  // 'background' triggers the hibernate sweep.
  function handleAppState(status: AppStateValue): void {
    if (!active) return;
    if (status === 'background') {
      void handleBackground();
    } else if (status === 'active') {
      void handleForeground();
    }
    // 'inactive' and any other value: no-op.
  }

  // ── public surface ──────────────────────────────────────────────────────────

  function start(): void {
    if (subscription) return; // idempotent
    active = true;
    subscription = deps.appState.addEventListener('change', handleAppState);
    attachNodeListeners();
    // Node is assumed already started (Settings start, or cold-start completed
    // before the hook mounts the runner) → land in FOREGROUND.
    setState('foreground');
  }

  function stop(): void {
    active = false;
    epoch++; // invalidate any in-flight resume/hibernate
    if (subscription) {
      subscription.remove();
      subscription = null;
    }
    detachNodeListeners();
    // Abort any in-flight settle (removes its `control:connected` listener +
    // timer and resolves it); the epoch bump above makes the resolved handler
    // bail before touching state. Snapshot first — `finish` mutates the set.
    for (const finish of [...pendingSettles]) finish(false);
    pendingSettles.clear();
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
    setResuming(false);
    setDegraded(false);
  }

  function onStateChange(cb: (s: RunnerState) => void): () => void {
    stateListeners.add(cb);
    return () => {
      stateListeners.delete(cb);
    };
  }

  return {
    get state() {
      return state;
    },
    get resuming() {
      return resuming;
    },
    get degraded() {
      return degraded;
    },
    start,
    stop,
    onStateChange,
  };
}
