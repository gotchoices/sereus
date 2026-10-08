/**
 * use-cadre.spec.ts — runtime coverage for `useCadreInternal`'s wiring of the
 * {@link BackgroundRunner} into React. The runner itself is unit-tested in the
 * kit (`@serfab/cadre-rn`, test/lifecycle/background-runner.spec.ts); this
 * exercises the *hook* that owns the runner's lifecycle.
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
 *  - a degraded resume propagating out to the status banner;
 *  - launch resuming the last session from the saved start options.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
// Type-only: the runtime module is `vi.mock`ed below, and this import is erased.
import type { RelayReservationState } from '@serfab/cadre-core';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { useCadreInternal, type UseCadreResult } from '../../src/use-cadre';
import { connectionBanner } from '../../src/connection-status';
import {
  createOpenInvitation,
  getRelayState,
  loadSavedStartOptions,
  startPhoneNode,
  type PhoneNodeOptions,
  type SavedStartOptions,
} from '../../src/cadre-phone';
import { createClosedChatStrand, joinChatStrand } from '../../src/chat-strand';

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

  /** The relay posture `getRelayState()` reports. `none` is the default phone posture. */
  const noRelay = (): RelayReservationState =>
    ({ status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null });

  // Mutable controller shared by the mocks + the test body. Reset per-test.
  const ctl: {
    node: MockNode | null;
    appState: FakeAppState;
    startCount: number;
    nodeCounter: number;
    lastOpts: unknown;
    relay: RelayReservationState;
    /** What `loadSavedStartOptions()` resolves to: the record a previous session left. */
    saved: unknown;
  } = {
    node: null, appState: new FakeAppState(), startCount: 0, nodeCounter: 0, lastOpts: null,
    relay: noRelay(), saved: undefined,
  };

  return { FakeAppState, MockNode, ctl, noRelay };
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
  getNoiseCryptoMode: () => (h.ctl.node ? 'symmetric' : null),
  // Live read in production; here, whatever the test set. `vi.fn` so a test can also
  // assert the guard read it at the moment of the tap rather than off cached state.
  getRelayState: vi.fn(() => h.ctl.relay),
  loadSavedStartOptions: vi.fn(async () => h.ctl.saved),
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
  decodeCadreInvitation: vi.fn(),
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
    participantCount: 0,
    relayStatus: cadre.relayStatus,
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

/** Mount, then let the launch read of the saved start options and anything it starts settle. */
async function mountLaunched(): Promise<Sink> {
  const sink: Sink = { current: null, resumingHistory: [] };
  await act(async () => {
    create(React.createElement(CadreHarness, { sink }));
    await tick();
  });
  return sink;
}

const OPTS: PhoneNodeOptions = { partyId: 'demo', bootstrapAddrs: [], relayAddrs: [] };
/** What a previous session saved — distinct from {@link OPTS}, so a test can tell whose options a start used. */
const SAVED_OPTS: PhoneNodeOptions = {
  partyId: 'saved-party',
  bootstrapAddrs: ['/ip4/10.0.0.5/tcp/4002/ws/p2p/12D3KooWSavedBootstrapPeer'],
  relayAddrs: [],
  noiseCryptoMode: 'symmetric',
};

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
  h.ctl.relay = h.noRelay();
  h.ctl.saved = undefined;
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

  it('names the Settings field when the reason is that no relay is configured', async () => {
    const sink = await mountStarted();

    await act(async () => {
      await expect(sink.current!.createClosedStrandWithInvite('closed-1'))
        .rejects.toThrow(/No relay is configured — set one in Settings under "Relay"/);
    });

    expect(createClosedChatStrand).not.toHaveBeenCalled();
    expect(createOpenInvitation).not.toHaveBeenCalled();
  });

  it('names the status and the recorded error when the relay is not answering', async () => {
    const sink = await mountStarted();
    h.ctl.relay = {
      status: 'retrying',
      addrs: ['/ip4/10.0.0.9/tcp/4002/ws/p2p/12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5'],
      circuitAddrs: [],
      error: 'no circuit reservation within 10000ms',
      retryAtMs: Date.now() + 2000,
    };

    await act(async () => {
      await expect(sink.current!.createClosedStrandWithInvite('closed-1'))
        .rejects.toThrow(/relay is not answering \(retrying: no circuit reservation within 10000ms\)/);
    });

    expect(createClosedChatStrand).not.toHaveBeenCalled();
    expect(createOpenInvitation).not.toHaveBeenCalled();
  });

  it('reads the posture at the moment of the tap, not off the polled banner state', async () => {
    const sink = await mountStarted();
    // The poll has already run at least once; clear it so the count below is the
    // guard's own read.
    vi.mocked(getRelayState).mockClear();

    await act(async () => {
      await expect(sink.current!.createClosedStrandWithInvite('closed-1')).rejects.toThrow();
    });

    expect(getRelayState).toHaveBeenCalled();
  });

  it('founds the strand and returns the encoded invitation when the node is reachable', async () => {
    const sink = await mountStarted();
    h.ctl.node!.multiaddrs = ['/ip4/127.0.0.1/tcp/4002/ws/p2p/relay/p2p-circuit/p2p/peer-1'];
    h.ctl.relay = { ...h.noRelay(), status: 'reserved', circuitAddrs: h.ctl.node!.multiaddrs };
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
  const strandRow = (id: string, type: 'o' | 'c', memberPrivateKey: string | null = null) =>
    ({ Id: id, Type: type, MemberPrivateKey: memberPrivateKey, FounderOwnerKey: null });

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

  it('joins a CLOSED strand only when its row carries the read secret', async () => {
    // With the key: a join the node remembered from an earlier invite, or our own party's
    // closed strand. Without it, the explicit invite handshake is still the only way in.
    const keyed = strandRow('closed-remembered', 'c', 'read-secret');
    const node = nodeWithBacklog(strandRow('closed-keyless', 'c'), keyed);

    await mountStarted();

    expect(joinChatStrand).toHaveBeenCalledTimes(1);
    expect(joinChatStrand).toHaveBeenCalledWith(node, keyed);
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
});

describe('useCadreInternal — resuming the last session at launch', () => {
  beforeEach(resetHarness);

  it('starts with the saved options when the last session ended connected', async () => {
    h.ctl.saved = { options: SAVED_OPTS, autoStart: true } satisfies SavedStartOptions;

    const sink = await mountLaunched();

    expect(startPhoneNode).toHaveBeenCalledTimes(1);
    expect(startPhoneNode).toHaveBeenCalledWith(SAVED_OPTS);
    expect(sink.current!.status).toBe('connected');
    expect(sink.current!.savedStartOptions).toEqual(SAVED_OPTS);
  });

  // A push wake's cold start in this JS runtime finished after the first render (which
  // saw no node) but before the launch read resolved. The hook must adopt that node.
  it('adopts a node a push wake started while the saved options were being read', async () => {
    h.ctl.saved = { options: SAVED_OPTS, autoStart: true } satisfies SavedStartOptions;
    vi.mocked(loadSavedStartOptions).mockImplementationOnce(async () => {
      h.ctl.node = new h.MockNode(++h.ctl.nodeCounter);
      return h.ctl.saved as SavedStartOptions;
    });

    const sink = await mountLaunched();

    expect(h.ctl.nodeCounter).toBe(1);
    expect(sink.current!.node).toBe(h.ctl.node as unknown as UseCadreResult['node']);
    expect(sink.current!.status).toBe('connected');
  });

  it('starts nothing after a Disconnect, but still offers the options to Settings', async () => {
    h.ctl.saved = { options: SAVED_OPTS, autoStart: false } satisfies SavedStartOptions;

    const sink = await mountLaunched();

    expect(startPhoneNode).not.toHaveBeenCalled();
    expect(sink.current!.status).toBe('idle');
    expect(sink.current!.savedStartOptions).toEqual(SAVED_OPTS);
  });
});

/**
 * The relay posture the UI shows is POLLED — `CadreNode` announces neither a
 * reservation gained nor one lost — so the poll is the whole mechanism behind the
 * claim that a relay coming back mid-session starts working with no app restart
 * (`docs/reference-app-rn.md` → "Reachability: configuring a relay"). These cover the
 * wiring; `connection-status.spec.ts` covers the wording it produces.
 */
describe('useCadreInternal — relay posture polling', () => {
  beforeEach(resetHarness);

  it('picks up a relay that lands after start, with no user action', async () => {
    vi.useFakeTimers();
    try {
      const { sink, renderer } = mountCadre();
      await act(async () => {
        await sink.current!.start(OPTS);
        await tick();
      });
      expect(bannerOf(renderer).text).toBe('Connected · 0 strand(s) · 0 participant(s) · no relay — can’t invite');

      // cadre-core's supervisor lands the reservation. Nothing tells the app.
      h.ctl.relay = { ...h.noRelay(), status: 'reserved', circuitAddrs: ['/p2p-circuit/p2p/peer-1'] };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(sink.current!.relayStatus).toBe('reserved');
      expect(bannerOf(renderer).text).toBe('Connected · 0 strand(s) · 0 participant(s)');

      // …and the other direction: a reservation lost mid-session says so again.
      h.ctl.relay = { ...h.noRelay(), status: 'retrying', error: 'relay closed the connection' };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(bannerOf(renderer).text).toBe('Connected · 0 strand(s) · 0 participant(s) · relay offline — can’t invite');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll while backgrounded, and re-reads on the way back', async () => {
    vi.useFakeTimers();
    try {
      const { sink } = mountCadre();
      await act(async () => {
        await sink.current!.start(OPTS);
        await tick();
      });

      await actFlush(() => h.ctl.appState.fire('background'));
      vi.mocked(getRelayState).mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      // A screen-off phone adds no wakeups of its own — the supervisor inside
      // cadre-core keeps its own liveness check, which is not this timer.
      expect(getRelayState).not.toHaveBeenCalled();

      h.ctl.relay = { ...h.noRelay(), status: 'reserved', circuitAddrs: ['/p2p-circuit/p2p/peer-1'] };
      await actFlush(() => h.ctl.appState.fire('active'));
      expect(getRelayState).toHaveBeenCalled();
      expect(sink.current!.relayStatus).toBe('reserved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to "no relay" once the node is stopped', async () => {
    const sink = await mountStarted();
    h.ctl.relay = { ...h.noRelay(), status: 'reserved', circuitAddrs: ['/p2p-circuit/p2p/peer-1'] };
    await actFlush(() => {
      void sink.current!.relayStatus;
    });

    await act(async () => {
      await sink.current!.stop();
      await tick();
    });

    // No node, no posture to report — and nothing left polling a dead one.
    expect(sink.current!.relayStatus).toBe('none');
  });
});
