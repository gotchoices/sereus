import { describe, it, expect, afterEach } from 'vitest';
import { TurnRelayTracker } from '../src/diagnostics/webrtc-turn-tracker.js';

/**
 * Unit tests for the WebRTC TURN-relay tracker. The Node test environment has no
 * `globalThis.RTCPeerConnection`, so the "inert" path is exercised as-is and the
 * detection path installs a minimal fake `RTCPeerConnection` (an `EventTarget`
 * subclass that emits `connectionstatechange` and returns canned `getStats()`).
 */

type StatEntry = [string, Record<string, unknown>];

/** Minimal fake RTCPeerConnection: drives connectionstatechange + getStats. */
class FakeRTCPeerConnection extends EventTarget {
  connectionState = 'new';
  statsEntries: StatEntry[] = [];

  getStats(): Promise<{ forEach: (cb: (value: unknown, key: string) => void) => void }> {
    const entries = this.statsEntries;
    return Promise.resolve({
      forEach(cb: (value: unknown, key: string) => void): void {
        for (const [key, value] of entries) cb(value, key);
      },
    });
  }

  /** Transition to a state and emit the change event the tracker listens for. */
  settle(state = 'connected'): void {
    this.connectionState = state;
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}

const GLOBAL = globalThis as { RTCPeerConnection?: typeof RTCPeerConnection };
const ORIGINAL = GLOBAL.RTCPeerConnection;

/**
 * Flush the macrotask/microtask hops the async getStats settlement runs on. Two
 * ticks cover both the resolved-stats path and the (extra-hop) rejected path.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Install the fake global and return a constructed (tracked) connection. */
function newTrackedConnection(): FakeRTCPeerConnection {
  const Ctor = GLOBAL.RTCPeerConnection as unknown as new () => unknown;
  return new Ctor() as FakeRTCPeerConnection;
}

const RELAY_STATS: StatEntry[] = [
  ['T1', { type: 'transport', selectedCandidatePairId: 'P1' }],
  ['P1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' }],
  ['L1', { type: 'local-candidate', candidateType: 'relay' }],
  ['R1', { type: 'remote-candidate', candidateType: 'host' }],
];

const HOST_STATS: StatEntry[] = [
  ['P1', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' }],
  ['L1', { type: 'local-candidate', candidateType: 'host' }],
  ['R1', { type: 'remote-candidate', candidateType: 'srflx' }],
];

afterEach(() => {
  // Restore whatever was on the global before each test (undefined in Node).
  if (ORIGINAL === undefined) {
    delete GLOBAL.RTCPeerConnection;
  } else {
    GLOBAL.RTCPeerConnection = ORIGINAL;
  }
});

describe('TurnRelayTracker — inert on Node.js (no RTCPeerConnection)', () => {
  it('install/consume/dispose never throw and consume returns null', () => {
    delete GLOBAL.RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    expect(() => tracker.install()).not.toThrow();
    expect(tracker.consume(1000)).toBeNull();
    expect(() => tracker.dispose()).not.toThrow();
    // The global is left untouched (no wrapper installed).
    expect(GLOBAL.RTCPeerConnection).toBeUndefined();
  });
});

describe('TurnRelayTracker — detection', () => {
  it('detects a TURN relay candidate pair → consume returns true', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.statsEntries = RELAY_STATS;
    pc.settle('connected');
    await flush();

    expect(tracker.consume(1000)).toBe(true);
    // The entry was popped — a second consume finds nothing.
    expect(tracker.consume(1000)).toBeNull();
    tracker.dispose();
  });

  it('detects a non-relay (host/srflx) candidate pair → consume returns false', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.statsEntries = HOST_STATS;
    pc.settle('connected');
    await flush();

    expect(tracker.consume(1000)).toBe(false);
    tracker.dispose();
  });

  it('records nothing until the connection reaches connected', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.statsEntries = RELAY_STATS;
    pc.settle('connecting');
    await flush();
    expect(tracker.consume(1000)).toBeNull();

    pc.settle('connected');
    await flush();
    expect(tracker.consume(1000)).toBe(true);
    tracker.dispose();
  });

  it('treats a getStats rejection as not-relayed (safe default)', async () => {
    class ThrowingPeerConnection extends FakeRTCPeerConnection {
      override getStats(): Promise<{ forEach: (cb: (value: unknown, key: string) => void) => void }> {
        return Promise.reject(new Error('stats unavailable'));
      }
    }
    GLOBAL.RTCPeerConnection = ThrowingPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.settle('connected');
    await flush();

    expect(tracker.consume(1000)).toBe(false);
    tracker.dispose();
  });

  it('consume returns null for an entry older than the window', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.statsEntries = RELAY_STATS;
    pc.settle('connected');
    await flush();

    // A zero-width window can never contain a past settlement.
    expect(tracker.consume(0)).toBeNull();
    tracker.dispose();
  });

  it('dispose restores the original RTCPeerConnection', () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();
    // The global is now the tracker's subclass, not the bare fake.
    expect(GLOBAL.RTCPeerConnection).not.toBe(FakeRTCPeerConnection);
    tracker.dispose();
    expect(GLOBAL.RTCPeerConnection).toBe(FakeRTCPeerConnection as unknown as typeof RTCPeerConnection);
  });

  it('consume pops the most recent settlement first (newest → oldest)', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    // Two settlements within the window: a relay then a non-relay. consume()
    // returns the most recent (the non-relay) first, then the older relay.
    const relayPc = newTrackedConnection();
    relayPc.statsEntries = RELAY_STATS;
    relayPc.settle('connected');
    await flush();

    const hostPc = newTrackedConnection();
    hostPc.statsEntries = HOST_STATS;
    hostPc.settle('connected');
    await flush();

    expect(tracker.consume(1000)).toBe(false); // most recent (host)
    expect(tracker.consume(1000)).toBe(true);  // older (relay)
    expect(tracker.consume(1000)).toBeNull();
    tracker.dispose();
  });

  it('records a single settlement even if connected fires repeatedly', async () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();

    const pc = newTrackedConnection();
    pc.statsEntries = RELAY_STATS;
    // A flapping/duplicate connectionstatechange must not double-count (guarded by
    // the per-connection `observed` WeakSet).
    pc.settle('connected');
    pc.settle('connected');
    await flush();

    expect(tracker.consume(1000)).toBe(true);
    expect(tracker.consume(1000)).toBeNull();
    tracker.dispose();
  });

  it('install is idempotent — a single dispose restores the original', () => {
    GLOBAL.RTCPeerConnection = FakeRTCPeerConnection as unknown as typeof RTCPeerConnection;
    const tracker = new TurnRelayTracker();
    tracker.install();
    const wrapped = GLOBAL.RTCPeerConnection;
    tracker.install(); // second install is a NOP — must not re-wrap the wrapper
    expect(GLOBAL.RTCPeerConnection).toBe(wrapped);
    tracker.dispose();
    expect(GLOBAL.RTCPeerConnection).toBe(FakeRTCPeerConnection as unknown as typeof RTCPeerConnection);
  });
});
