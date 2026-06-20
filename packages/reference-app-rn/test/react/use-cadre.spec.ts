/**
 * use-cadre.spec.ts — runtime coverage for `useCadreInternal`'s wiring of the
 * {@link BackgroundRunner} into React. `background-runner.ts` is unit-tested in
 * plain node (test/background-runner.spec.ts); this exercises the *hook* that
 * owns the runner's lifecycle, which previously had no test (only typecheck).
 *
 * Strategy: mount the real hook with `react-test-renderer` (node env — no DOM)
 * while mocking the modules that would otherwise pull react-native / expo /
 * libp2p (`cadre-phone`, `app-state`, `push-wake-native`, `chat-strand`,
 * `@serfab/cadre-core`). The runner itself is the REAL one — we drive it through
 * a fake `AppState` + a mock node singleton and assert the observable wiring:
 *
 *  - runner created when the node starts, torn down on unmount;
 *  - cold-start re-sync (foreground return after an OS kill re-runs
 *    `startPhoneNode` and re-syncs node/peerId), incl. the runner being recreated
 *    by the `node`-dep change mid-resume without leaving `resuming` stuck;
 *  - a degraded resume propagating out to the status banner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { useCadreInternal, type UseCadreResult } from '../../src/use-cadre';
import { connectionBanner } from '../../src/connection-status';
import type { PhoneNodeOptions } from '../../src/cadre-phone';

// ── Shared test doubles (hoisted so the vi.mock factories below can close over
//    them — vitest lifts vi.hoisted above the mocks). ─────────────────────────

const h = vi.hoisted(() => {
  /** Records the registered AppState handler so a test can drive transitions. */
  class FakeAppState {
    handler: ((status: string) => void) | null = null;
    addCount = 0;
    removeCount = 0;

    addEventListener(_type: 'change', handler: (status: string) => void) {
      this.addCount++;
      this.handler = handler;
      return {
        remove: () => {
          this.removeCount++;
          this.handler = null;
        },
      };
    }

    fire(status: string): void {
      this.handler?.(status);
    }
  }

  /** Minimal CadreNode stub — only the surface use-cadre + the runner touch. */
  class MockNode {
    readonly id: number;
    readonly peerIdStr: string;
    readonly peerId: { toString(): string };
    isRunning = true;
    running = true;
    controlConnected = true;
    hibernateAllCount = 0;
    private readonly handlers = new Map<string, Set<() => void>>();
    private readonly strands = new Map<string, unknown>();

    constructor(id: number) {
      this.id = id;
      this.peerIdStr = `peer-${id}`;
      this.peerId = { toString: () => this.peerIdStr };
    }

    getStrands(): Map<string, unknown> {
      return this.strands;
    }

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
      this.handlers.get(event)?.forEach((cb) => cb());
    }

    listenerCount(event: string): number {
      return this.handlers.get(event)?.size ?? 0;
    }
  }

  // Mutable controller shared by the mocks + the test body. Reset per-test.
  const ctl: {
    node: MockNode | null;
    appState: FakeAppState;
    startCount: number;
    nodeCounter: number;
    lastOpts: unknown;
  } = { node: null, appState: new FakeAppState(), startCount: 0, nodeCounter: 0, lastOpts: null };

  return { FakeAppState, MockNode, ctl };
});

// ── Module mocks (keep react-native / expo / libp2p out of this env) ──────────

vi.mock('../../src/app-state', () => ({
  // The hook calls this inside the runner effect; hand back the SAME fake the
  // test holds so `.fire(...)` routes to whichever runner is currently mounted.
  createReactNativeAppState: () => h.ctl.appState,
}));

vi.mock('../../src/cadre-phone', () => ({
  getPhoneNode: () => h.ctl.node,
  startPhoneNode: vi.fn(async (opts: unknown) => {
    h.ctl.startCount++;
    h.ctl.lastOpts = opts;
    // Idempotent like the real impl: only mint a node when none is running.
    if (!h.ctl.node) h.ctl.node = new h.MockNode(++h.ctl.nodeCounter);
    return h.ctl.node;
  }),
  stopPhoneNode: vi.fn(async () => {
    h.ctl.node = null;
  }),
  getAuthorityPublicKey: () => (h.ctl.node ? `authpub-${h.ctl.node.id}` : null),
  dialPeer: vi.fn(async () => {}),
  createOpenInvitation: vi.fn(),
  publishFormationInvite: vi.fn(),
  formStrand: vi.fn(),
}));

vi.mock('../../src/push-wake-native', () => ({
  acquireAndRegisterDeviceToken: vi.fn(async () => {}),
  clearDeviceTokenRegistration: vi.fn(async () => {}),
}));

vi.mock('../../src/chat-strand', () => ({
  createChatStrand: vi.fn(),
  joinChatStrand: vi.fn(),
  createClosedChatStrand: vi.fn(),
  joinClosedChatStrandFromFormation: vi.fn(),
  CHAT_SAPP_ID: 'chat-test',
}));

vi.mock('@serfab/cadre-core', () => ({
  pinnedKeyTrustPolicy: vi.fn(),
}));

// ── Harness ───────────────────────────────────────────────────────────────────

interface Sink {
  current: UseCadreResult | null;
  /** Committed `resuming` transitions, to observe the resume flicker → settle. */
  resumingHistory: boolean[];
}

/**
 * Mounts the real hook and, on every render, recomputes the production status
 * banner from the hook's state so a test can assert what the bar would show.
 */
function CadreHarness({ sink }: { sink: Sink }): React.ReactElement {
  const cadre = useCadreInternal();
  sink.current = cadre;
  React.useEffect(() => {
    sink.resumingHistory.push(cadre.resuming);
  }, [cadre.resuming]);

  const banner = connectionBanner({
    resuming: cadre.resuming,
    degraded: cadre.degraded,
    status: cadre.status,
    error: cadre.error,
    strandCount: cadre.strands.size,
    memberCount: 0,
  });
  return React.createElement('status', { color: banner.color }, banner.text);
}

function mountCadre(): { sink: Sink; renderer: ReactTestRenderer } {
  const sink: Sink = { current: null, resumingHistory: [] };
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(React.createElement(CadreHarness, { sink }));
  });
  return { sink, renderer };
}

const OPTS: PhoneNodeOptions = { partyId: 'demo', bootstrapAddrs: [] };

/** Drain queued microtasks (the hook + runner chain several awaits). */
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** Fire a synchronous action inside act(), then let async handlers settle. */
async function actFlush(fn: () => void): Promise<void> {
  await act(async () => {
    fn();
    await tick();
  });
}

function bannerOf(renderer: ReactTestRenderer): { type: string; color: string; text: string } {
  const json = renderer.toJSON() as { type: string; props: { color: string }; children: string[] };
  return { type: json.type, color: json.props.color, text: json.children[0] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useCadreInternal — BackgroundRunner wiring', () => {
  beforeEach(() => {
    h.ctl.node = null;
    h.ctl.appState = new h.FakeAppState();
    h.ctl.startCount = 0;
    h.ctl.nodeCounter = 0;
    h.ctl.lastOpts = null;
    vi.clearAllMocks();
  });

  it('creates the runner when the node starts and tears it down on unmount', async () => {
    const { sink, renderer } = mountCadre();

    // No node yet → the runner effect has not run.
    expect(h.ctl.appState.addCount).toBe(0);
    expect(sink.current?.node).toBeNull();

    await act(async () => {
      await sink.current!.start(OPTS);
      await tick();
    });

    const n1 = h.ctl.node!;
    expect(n1).not.toBeNull();
    expect(h.ctl.startCount).toBe(1);
    expect(sink.current!.peerId).toBe(n1.peerIdStr);
    // Runner subscribed to AppState + the node's control edges.
    expect(h.ctl.appState.addCount).toBe(1);
    expect(n1.listenerCount('control:disconnected')).toBe(1);
    expect(sink.current!.runnerState).toBe('foreground');

    await act(async () => {
      renderer.unmount();
    });

    // Unmount tore the runner down: AppState unsubscribed, node listeners dropped.
    expect(h.ctl.appState.removeCount).toBe(1);
    expect(n1.listenerCount('control:disconnected')).toBe(0);
    expect(n1.listenerCount('control:connected')).toBe(0);
  });

  it('background hibernates the node and lands background-connected', async () => {
    const { sink } = mountCadre();
    await act(async () => {
      await sink.current!.start(OPTS);
      await tick();
    });
    const n1 = h.ctl.node!;

    await actFlush(() => h.ctl.appState.fire('background'));

    expect(n1.hibernateAllCount).toBe(1);
    expect(sink.current!.runnerState).toBe('background-connected');
  });

  it('cold-start re-syncs node + peerId and recreates the runner without leaving resuming stuck', async () => {
    const { sink } = mountCadre();
    await act(async () => {
      await sink.current!.start(OPTS);
      await tick();
    });
    const n1 = h.ctl.node!;
    expect(sink.current!.peerId).toBe('peer-1');

    await actFlush(() => h.ctl.appState.fire('background'));
    expect(sink.current!.runnerState).toBe('background-connected');

    // OS kills the node while we are backgrounded.
    h.ctl.node = null;

    // Foreground return: ensureNode cold-starts a FRESH node, which changes the
    // `node` dep and recreates the runner mid-resume.
    await actFlush(() => h.ctl.appState.fire('active'));

    const n2 = h.ctl.node!;
    expect(n2).not.toBe(n1);
    expect(n2.id).toBe(2);
    expect(h.ctl.startCount).toBe(2); // initial start + cold-start re-run
    expect(sink.current!.peerId).toBe('peer-2'); // React state re-synced to the new node
    expect(sink.current!.node).toBe(n2 as unknown as UseCadreResult['node']);

    // Resume converged: not stuck resuming, settled in foreground.
    expect(sink.current!.resuming).toBe(false);
    expect(sink.current!.degraded).toBe(false);
    expect(sink.current!.runnerState).toBe('foreground');

    // The node-dep change recreated the runner: old runner stopped (one remove),
    // new runner started (a second add); listeners moved off n1 onto n2.
    expect(h.ctl.appState.addCount).toBe(2);
    expect(h.ctl.appState.removeCount).toBe(1);
    expect(n1.listenerCount('control:disconnected')).toBe(0);
    expect(n2.listenerCount('control:disconnected')).toBe(1);

    // The settle-restart left `resuming` cleared (false), not wedged on. (The
    // committed `resuming === true` mid-resume is asserted in the degraded test;
    // here the cold-start + recreate is fast enough that act() batches the true
    // commit away — what matters for THIS path is that it converges to false.)
    expect(sink.resumingHistory.at(-1)).toBe(false);
  });

  it('a degraded resume (control never reconnects) reaches the status banner', async () => {
    vi.useFakeTimers();
    try {
      const { sink, renderer } = mountCadre();
      await act(async () => {
        await sink.current!.start(OPTS);
        await tick();
      });
      const n1 = h.ctl.node!;
      n1.controlConnected = false; // resume will not see control:connected

      await actFlush(() => h.ctl.appState.fire('background'));
      await actFlush(() => h.ctl.appState.fire('active'));

      // Mid-resume: settling, not yet degraded.
      expect(sink.current!.resuming).toBe(true);
      expect(sink.current!.degraded).toBe(false);
      expect(bannerOf(renderer).text).toBe('Resuming — syncing…');

      // The bounded settle timeout (default 15s) fires with no reconnect.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });

      expect(sink.current!.resuming).toBe(false);
      expect(sink.current!.degraded).toBe(true);
      expect(sink.current!.runnerState).toBe('foreground');

      // …and that degraded flag is what the status bar renders.
      const banner = bannerOf(renderer);
      expect(banner.text).toBe('Offline — reconnecting…');
      expect(banner.color).toBe('#f44336');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop() drops the node and the runner unsubscribes from AppState', async () => {
    const { sink } = mountCadre();
    await act(async () => {
      await sink.current!.start(OPTS);
      await tick();
    });
    const n1 = h.ctl.node!;
    expect(h.ctl.appState.addCount).toBe(1);

    await act(async () => {
      await sink.current!.stop();
      await tick();
    });

    // stop() nulls the node → the runner effect's cleanup runs (node dep → null).
    expect(sink.current!.node).toBeNull();
    expect(sink.current!.status).toBe('idle');
    expect(h.ctl.appState.removeCount).toBe(1);
    expect(n1.listenerCount('control:disconnected')).toBe(0);
  });

  // ── Documented limitation (latent edge from the ticket) ─────────────────────
  // If the node singleton is already running at mount but `start()` was never
  // called this session, `optsRef` stays null and a later cold-start cannot
  // re-run `startPhoneNode` — the dead node is never recovered. This is only
  // reachable when the module singleton survives a remount (dev Fast Refresh); a
  // production fresh JS context starts with a null singleton, so `start()` always
  // runs first and populates `optsRef`. Test pins the current behavior so a
  // future fix (persisting opts) is a deliberate, visible change.
  it('documents: a warm node at mount (no start()) cannot cold-start after an OS kill', async () => {
    // Simulate a surviving singleton: node present at mount, start() never called.
    h.ctl.node = new h.MockNode(++h.ctl.nodeCounter);
    const warm = h.ctl.node;

    const { sink } = mountCadre();
    expect(sink.current!.node).toBe(warm as unknown as UseCadreResult['node']);
    expect(sink.current!.runnerState).toBe('foreground');

    await actFlush(() => h.ctl.appState.fire('background'));
    h.ctl.node = null; // OS kills it

    await actFlush(() => h.ctl.appState.fire('active'));

    // ensureNode no-ops (optsRef null) → no re-start, and the hook keeps a stale
    // handle to the dead node rather than recovering it. This is the gap.
    expect(h.ctl.startCount).toBe(0);
    expect(h.ctl.node).toBeNull();
    expect(sink.current!.node).toBe(warm as unknown as UseCadreResult['node']);
  });
});
