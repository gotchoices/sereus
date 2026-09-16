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
import { createOpenInvitation, type PhoneNodeOptions } from '../../src/cadre-phone';
import { createClosedChatStrand, joinChatStrand } from '../../src/chat-strand';
import { requestHostNode } from '../../src/host-node-request';

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
    multiaddrs: string[] = [];
    private readonly handlers = new Map<string, Set<(payload?: unknown) => void>>();
    private readonly strands = new Map<string, unknown>();
    /**
     * The node's unclaimed-strand backlog — what `getDiscoveredStrands()` hands the
     * hook's catch-up drain. Seeded by a test to stand for strands the real node
     * announced inside `start()`, before any listener existed.
     */
    readonly discovered = new Map<string, unknown>();

    constructor(id: number) {
      this.id = id;
      this.peerIdStr = `peer-${id}`;
      this.peerId = { toString: () => this.peerIdStr };
    }

    getStrands(): Map<string, unknown> {
      return this.strands;
    }

    /** A snapshot, as the real `CadreNode.getDiscoveredStrands()` returns. */
    getDiscoveredStrands(): Map<string, unknown> {
      return new Map(this.discovered);
    }

    getMultiaddrs(): string[] {
      return this.multiaddrs;
    }

    encodeInvitation(_invitation: unknown): string {
      return `encoded-invite-${this.id}`;
    }

    async hibernateAll(): Promise<string[]> {
      this.hibernateAllCount++;
      return [];
    }

    on(event: string, handler: (payload?: unknown) => void): void {
      let set = this.handlers.get(event);
      if (!set) {
        set = new Set();
        this.handlers.set(event, set);
      }
      set.add(handler);
    }

    off(event: string, handler: (payload?: unknown) => void): void {
      this.handlers.get(event)?.delete(handler);
    }

    /** `payload` is what the typed CadreNode event carries; omitted for the void events. */
    emit(event: string, payload?: unknown): void {
      this.handlers.get(event)?.forEach((cb) => cb(payload));
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
  getOwnerPublicKey: () => (h.ctl.node ? `authpub-${h.ctl.node.id}` : null),
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

// The flow itself is covered headlessly in `test/host-node-request.spec.ts`; what
// the hook owns — the re-entry guard, the abort handle and what it passes down — is
// what the tests at the bottom of this file exercise.
vi.mock('../../src/host-node-request', () => ({
  requestHostNode: vi.fn(),
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

function resetHarness(): void {
  h.ctl.node = null;
  h.ctl.appState = new h.FakeAppState();
  h.ctl.startCount = 0;
  h.ctl.nodeCounter = 0;
  h.ctl.lastOpts = null;
  vi.clearAllMocks();
}

async function mountStarted(): Promise<Sink> {
  const { sink } = mountCadre();
  await act(async () => {
    await sink.current!.start(OPTS);
    await tick();
  });
  return sink;
}

describe('useCadreInternal — closed-strand invite', () => {
  beforeEach(resetHarness);

  it('refuses before founding anything when the node has no reachable address', async () => {
    const sink = await mountStarted();

    await act(async () => {
      await expect(sink.current!.createClosedStrandWithInvite('closed-1')).rejects.toThrow(/no reachable address/);
    });

    // Refused up front: no orphaned closed strand, no invitation minted.
    expect(createClosedChatStrand).not.toHaveBeenCalled();
    expect(createOpenInvitation).not.toHaveBeenCalled();
  });

  it('founds the strand and returns the encoded invitation when the node is reachable', async () => {
    const sink = await mountStarted();
    h.ctl.node!.multiaddrs = ['/ip4/127.0.0.1/tcp/4002/ws/p2p/relay/p2p-circuit/p2p/peer-1'];
    vi.mocked(createOpenInvitation).mockResolvedValue({ token: 'tok', expiration: new Date(0) } as never);

    let encoded = '';
    await act(async () => {
      encoded = await sink.current!.createClosedStrandWithInvite('closed-1');
    });

    expect(createClosedChatStrand).toHaveBeenCalledTimes(1);
    // The caller's id is the strand founded, so Settings' logs name the same strand.
    expect(createClosedChatStrand).toHaveBeenCalledWith(expect.anything(), 'closed-1');
    expect(encoded).toBe('encoded-invite-1');
  });
});

describe('useCadreInternal — discovered-strand backlog', () => {
  beforeEach(resetHarness);

  /** An unclaimed row as the control network advertises it. */
  const strandRow = (id: string, type: 'o' | 'c') => ({ Id: id, Type: type, MemberPrivateKey: null, FounderOwnerKey: null });

  /**
   * A node that is ALREADY up with `backlog` unclaimed — the restart shape. The real
   * node announces each stored strand from the watcher's first poll inside
   * `CadreNode.start()`, which resolves before `startPhoneNode` does and long before
   * React can run the subscribing effect, so the hook never sees those events.
   */
  function nodeWithBacklog(...backlog: ReturnType<typeof strandRow>[]): InstanceType<typeof h.MockNode> {
    const node = new h.MockNode(1);
    for (const row of backlog) node.discovered.set(row.Id, row);
    h.ctl.node = node;
    return node;
  }

  it('drains the backlog on subscribe, so a strand announced before mount is still joined', async () => {
    const row = strandRow('stored-1', 'o');
    const node = nodeWithBacklog(row);

    await mountStarted();

    // No `strand:discovered` ever reached this listener — the drain is the only
    // thing that could have produced this call.
    expect(joinChatStrand).toHaveBeenCalledTimes(1);
    expect(joinChatStrand).toHaveBeenCalledWith(node, row);
  });

  it('leaves a CLOSED strand unclaimed — it still requires the explicit invite handshake', async () => {
    nodeWithBacklog(strandRow('closed-stored', 'c'));

    await mountStarted();

    expect(joinChatStrand).not.toHaveBeenCalled();
  });

  it('joins once when the event re-offers a strand the drain is still claiming', async () => {
    const row = strandRow('stored-1', 'o');
    const node = nodeWithBacklog(row);
    // A join that never settles: the window where `getStrands()` still shows nothing,
    // because the strand manager tracks the instance only once `addStrand` resolves.
    // `…Once`, not `mockReturnValue`: `resetHarness` clears calls but NOT implementations,
    // so a permanent never-settling join would leak into every later test in this file.
    vi.mocked(joinChatStrand).mockImplementationOnce(() => new Promise(() => { /* never settles */ }));

    await mountStarted();
    expect(joinChatStrand).toHaveBeenCalledTimes(1);

    await actFlush(() => node.emit('strand:discovered', { strandId: row.Id, strand: row }));

    // Without the in-flight guard this is 2 — two `addStrand` calls for one strand.
    expect(joinChatStrand).toHaveBeenCalledTimes(1);
  });

  it('subscribes BEFORE draining, so a discovery landing between the two is not lost', async () => {
    const node = nodeWithBacklog();
    await mountStarted();

    // Nothing in the backlog at mount, but the listener is attached: the ordinary
    // mid-session discovery still works, unchanged by the drain.
    const row = strandRow('later-1', 'o');
    await actFlush(() => node.emit('strand:discovered', { strandId: row.Id, strand: row }));

    expect(joinChatStrand).toHaveBeenCalledTimes(1);
    expect(joinChatStrand).toHaveBeenCalledWith(node, row);
  });
});

describe('useCadreInternal — BackgroundRunner wiring', () => {
  beforeEach(resetHarness);

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

describe('useCadreInternal — requesting a node from a cadre-host', () => {
  beforeEach(resetHarness);

  /** A request that hangs until the test releases it, plus the deps the hook passed down. */
  function pendingRequest() {
    let release!: () => void;
    const deps: { signal?: AbortSignal; node?: unknown } = {};
    vi.mocked(requestHostNode).mockImplementationOnce(async (_url, _token, passed) => {
      deps.signal = passed.signal;
      deps.node = passed.node;
      await new Promise<void>((resolve) => { release = resolve; });
      return { donationId: 'donation-1', peerId: 'lent-node' };
    });
    return { deps, release: () => release() };
  }

  it('refuses before the node is started', async () => {
    const { sink } = mountCadre();

    await expect(sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok')).rejects.toThrow(/not started/);
    expect(requestHostNode).not.toHaveBeenCalled();
  });

  it('passes the running node, the platform fetch and an abort signal', async () => {
    const sink = await mountStarted();
    vi.mocked(requestHostNode).mockResolvedValueOnce({ donationId: 'donation-1', peerId: 'lent-node' });

    await act(async () => {
      await sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok');
    });

    expect(requestHostNode).toHaveBeenCalledWith('http://127.0.0.1:8088', 'tok', expect.objectContaining({
      fetch: globalThis.fetch,
      node: h.ctl.node,
      signal: expect.any(AbortSignal),
    }));
  });

  it('refuses a second request while one is in flight', async () => {
    const sink = await mountStarted();
    const first = pendingRequest();

    let inFlight!: Promise<unknown>;
    await actFlush(() => {
      inFlight = sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok');
    });

    // The guard, not the disabled button: a slow host would otherwise take two
    // provisions against one grant.
    await act(async () => {
      await expect(sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok')).rejects.toThrow(/already running/);
    });
    expect(requestHostNode).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.release();
      await inFlight;
    });
  });

  it('allows a retry once the first request has settled, including after a failure', async () => {
    const sink = await mountStarted();
    vi.mocked(requestHostNode).mockRejectedValueOnce(new Error('host unreachable'));

    await act(async () => {
      await expect(sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok')).rejects.toThrow(/host unreachable/);
    });

    vi.mocked(requestHostNode).mockResolvedValueOnce({ donationId: 'donation-2', peerId: 'lent-node' });
    await act(async () => {
      await expect(sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok')).resolves.toEqual({
        donationId: 'donation-2', peerId: 'lent-node',
      });
    });
  });

  it('aborts an in-flight request when the node is stopped, and waits for it to unwind', async () => {
    const sink = await mountStarted();
    const request = pendingRequest();

    let inFlight!: Promise<unknown>;
    await actFlush(() => {
      inFlight = sink.current!.requestHostNode('http://127.0.0.1:8088', 'tok');
    });
    expect(request.deps.signal!.aborted).toBe(false);

    let stopping!: Promise<void>;
    await actFlush(() => {
      stopping = sink.current!.stop();
    });

    expect(request.deps.signal!.aborted).toBe(true);
    // The load-bearing half: the node is STILL UP while the aborted request unwinds,
    // because its cleanup drops the lent node's authorization row through that node.
    // Without the wait the removal would race `stopPhoneNode` and lose.
    expect(h.ctl.node).not.toBeNull();

    await act(async () => {
      request.release();
      await inFlight;
      await stopping;
    });
    expect(h.ctl.node).toBeNull();
  });
});
