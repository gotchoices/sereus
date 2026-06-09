import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CadreNode } from '@serfab/cadre-core';
import {
  createBackgroundRunner,
  type AppStateLike,
  type AppStateSubscription,
  type AppStateValue,
} from '../src/background-runner';

// ── Test doubles ────────────────────────────────────────────────────────────

/** Records the registered AppState handler so a test can drive transitions. */
class FakeAppState implements AppStateLike {
  handler: ((status: AppStateValue) => void) | null = null;
  addCount = 0;
  removeCount = 0;

  addEventListener(_type: 'change', handler: (status: AppStateValue) => void): AppStateSubscription {
    this.addCount++;
    this.handler = handler;
    return {
      remove: () => {
        this.removeCount++;
        this.handler = null;
      },
    };
  }

  fire(status: AppStateValue): void {
    this.handler?.(status);
  }
}

/** Minimal CadreNode stub exposing only the surface the runner touches. */
class MockNode {
  running = true;
  controlConnected = true;
  hibernateAllCount = 0;
  private handlers = new Map<string, Set<() => void>>();

  async hibernateAll(): Promise<string[]> {
    this.hibernateAllCount++;
    return [];
  }

  on(event: string, handler: () => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: () => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string): void {
    this.handlers.get(event)?.forEach((h) => h());
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

function asNode(mock: MockNode): CadreNode {
  return mock as unknown as CadreNode;
}

/** Drain queued microtasks (the runner's async handlers chain a few awaits). */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createBackgroundRunner', () => {
  let node: MockNode;
  let app: FakeAppState;

  beforeEach(() => {
    node = new MockNode();
    app = new FakeAppState();
  });

  it('active → background hibernates once and enters background-connected', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();

    app.fire('background');
    await flush();

    expect(node.hibernateAllCount).toBe(1);
    expect(runner.state).toBe('background-connected');
  });

  it('control:disconnected while backgrounded drops to background-hibernating', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();

    app.fire('background');
    await flush();
    expect(runner.state).toBe('background-connected');

    node.emit('control:disconnected');
    expect(runner.state).toBe('background-hibernating');
  });

  it('background → active resumes: resuming toggles true→false, lands foreground', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();
    app.fire('background');
    await flush();

    app.fire('active');
    expect(runner.resuming).toBe(true);

    await flush();
    expect(runner.resuming).toBe(false);
    expect(runner.state).toBe('foreground');
    expect(runner.degraded).toBe(false);
  });

  it('cold start: foreground return with no node calls ensureNode', async () => {
    let current: MockNode | null = null;
    const ensureNode = vi.fn(async () => {
      current = node; // ensureNode brings the node up
    });
    const runner = createBackgroundRunner({
      getNode: () => (current ? asNode(current) : null),
      appState: app,
      ensureNode,
    });
    runner.start();

    app.fire('active');
    await flush();

    expect(ensureNode).toHaveBeenCalledTimes(1);
    expect(runner.state).toBe('foreground');
    expect(runner.resuming).toBe(false);
  });

  it("'inactive' is a no-op (no hibernate, stays foreground)", async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();

    app.fire('inactive');
    await flush();

    expect(node.hibernateAllCount).toBe(0);
    expect(runner.state).toBe('foreground');
  });

  it('node === null at background transition is a safe no-op', async () => {
    const runner = createBackgroundRunner({ getNode: () => null, appState: app });
    runner.start();

    app.fire('background');
    await flush();

    expect(runner.state).toBe('background-connected');
    expect(node.hibernateAllCount).toBe(0);
  });

  it('flap (background→active→background) settles deterministically without overlapping resume', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();
    app.fire('background');
    await flush();

    // Foreground then immediately background again, before the resume settles.
    app.fire('active');
    app.fire('background');
    await flush();

    // The late resume must not clobber the second background — we end backgrounded.
    expect(runner.state).toBe('background-connected');
    expect(runner.resuming).toBe(false);
  });

  it('resume with control never connecting clears resuming after settle timeout and surfaces degraded', async () => {
    vi.useFakeTimers();
    try {
      const runner = createBackgroundRunner({
        getNode: () => asNode(node),
        appState: app,
        settleTimeoutMs: 5_000,
      });
      runner.start();
      node.controlConnected = false;

      app.fire('background');
      await flush();

      app.fire('active');
      expect(runner.resuming).toBe(true);
      expect(runner.degraded).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(runner.resuming).toBe(false);
      expect(runner.degraded).toBe(true);
      expect(runner.state).toBe('foreground');
    } finally {
      vi.useRealTimers();
    }
  });

  it('degraded clears when control reconnects on its own while foregrounded', async () => {
    vi.useFakeTimers();
    try {
      const runner = createBackgroundRunner({
        getNode: () => asNode(node),
        appState: app,
        settleTimeoutMs: 5_000,
      });
      runner.start();
      node.controlConnected = false;

      app.fire('background');
      await flush();

      app.fire('active');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(runner.degraded).toBe(true);
      expect(runner.state).toBe('foreground');

      // Control network recovers later with no app-lifecycle transition to drive
      // a fresh resume — the stale degraded hint must self-heal.
      node.controlConnected = true;
      node.emit('control:connected');
      expect(runner.degraded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() during an in-flight resume settle tears down the control:connected listener (no leak)', async () => {
    const runner = createBackgroundRunner({
      getNode: () => asNode(node),
      appState: app,
      settleTimeoutMs: 5_000,
    });
    runner.start();
    const baseline = node.listenerCount('control:connected'); // persistent self-heal listener
    node.controlConnected = false;

    app.fire('background');
    await flush();

    app.fire('active'); // begins the resume settle (awaits control:connected)
    await flush();
    expect(runner.resuming).toBe(true);
    expect(node.listenerCount('control:connected')).toBe(baseline + 1); // settle one-shot added

    runner.stop();
    expect(node.listenerCount('control:connected')).toBe(0); // both removed, nothing orphaned
    expect(runner.resuming).toBe(false);
  });

  it('stop() removes the AppState subscription and node listeners; no further transitions', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();
    expect(node.listenerCount('control:disconnected')).toBe(1);

    runner.stop();
    expect(app.removeCount).toBe(1);
    expect(node.listenerCount('control:disconnected')).toBe(0);

    app.fire('background');
    node.emit('control:disconnected');
    await flush();

    expect(node.hibernateAllCount).toBe(0);
    expect(runner.state).toBe('foreground');
  });

  it('start()/stop() are idempotent', () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    runner.start();
    runner.start();
    expect(app.addCount).toBe(1);

    runner.stop();
    runner.stop();
    expect(app.removeCount).toBe(1);
  });

  it('onStateChange notifies on transitions and unsubscribes', async () => {
    const runner = createBackgroundRunner({ getNode: () => asNode(node), appState: app });
    const seen: string[] = [];
    const unsub = runner.onStateChange((s) => seen.push(s));
    runner.start();

    app.fire('background');
    await flush();
    expect(seen).toContain('background-connected');

    unsub();
    const lenBefore = seen.length;
    app.fire('active');
    await flush();
    expect(seen.length).toBe(lenBefore);
  });
});
