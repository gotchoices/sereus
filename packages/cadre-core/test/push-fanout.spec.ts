import { describe, it, expect } from 'vitest';
import { PushFanoutService } from '../src/push-fanout.js';
import type { PushFanoutOptions, FanoutMember } from '../src/push-fanout.js';
import type { StrandInstance, WakeAck, DeviceTokenRecord } from '../src/types.js';
import type { PushMessage, PushSendResult, PushNotifier } from '../src/push-notifier.js';
import { STRAND_WAKE_TYPE } from '../src/strand-wake-payload.js';

// ── Fakes for the injected node primitives + notifier ─────────────────────────

/** Minimal live strand instance — only its presence (the participation gate) matters. */
function stubInstance(strandId: string): StrandInstance {
  return { strandId, status: 'active', connectedPeers: 0, lastActivity: new Date(0), latencyHint: 'interactive', mode: 'networked' };
}

/** A resolvable DeviceToken for a peer (platform defaults to FCM). */
function tokenRecord(peerId: string, platform: 'fcm' | 'apns' = 'fcm'): DeviceTokenRecord {
  return { peerId, platform, token: `tok-${peerId}`, updatedAt: 1, sig: `sig-${peerId}` };
}

interface Harness {
  service: PushFanoutService;
  calls: {
    pushWake: Array<{ peerId: string; strandId: string; reason?: string }>;
    resolve: string[];
    send: PushMessage[];
    expire: string[];
    close: number;
  };
  setClock: (ms: number) => void;
}

/**
 * Build a {@link PushFanoutService} over fakes. `pushWake` REJECTS by default
 * (the suspended-phone case → platform fallback); set `defaultPushWake` /
 * `pushWakeBehavior[peerId]` to a {@link WakeAck} to simulate a reachable peer.
 */
function makeFanout(opts: {
  members?: FanoutMember[];
  self?: string;
  participates?: string[];
  defaultPushWake?: WakeAck | 'reject';
  pushWakeBehavior?: Record<string, WakeAck | 'reject'>;
  tokens?: Record<string, DeviceTokenRecord | null>;
  sendResult?: PushSendResult;
  cooldownMs?: number;
  debounceMs?: number;
  startClock?: number;
} = {}): Harness {
  const members = opts.members ?? [{ peerId: 'peer-a', multiaddr: null }];
  const self = opts.self ?? 'self-peer';
  const participates = new Set(opts.participates ?? ['strand-1']);
  const defaultPushWake = opts.defaultPushWake ?? 'reject';
  const pushWakeBehavior = opts.pushWakeBehavior ?? {};
  const tokens = opts.tokens ?? {};
  const sendResult: PushSendResult = opts.sendResult ?? { ok: true };

  let clock = opts.startClock ?? 1_000;
  const calls: Harness['calls'] = { pushWake: [], resolve: [], send: [], expire: [], close: 0 };

  const notifier: PushNotifier = {
    send: async (msg) => { calls.send.push(msg); return sendResult; },
    close: async () => { calls.close++; },
  };

  const options: PushFanoutOptions = {
    listMembers: async () => members,
    getStrand: (strandId) => (participates.has(strandId) ? stubInstance(strandId) : undefined),
    selfPeerId: () => self,
    pushWake: async (peerId, strandId, reason) => {
      calls.pushWake.push({ peerId, strandId, reason });
      const behavior = pushWakeBehavior[peerId] ?? defaultPushWake;
      if (behavior === 'reject') throw new Error(`no dialable address for ${peerId}`);
      return behavior;
    },
    resolveDeviceToken: async (peerId) => {
      calls.resolve.push(peerId);
      return peerId in tokens ? tokens[peerId] : tokenRecord(peerId);
    },
    expireDeviceToken: async (peerId) => { calls.expire.push(peerId); },
    notifier,
    now: () => clock,
    cooldownMs: opts.cooldownMs,
    debounceMs: opts.debounceMs,
  };

  return { service: new PushFanoutService(options), calls, setClock: (ms) => { clock = ms; } };
}

// ── Participation gate ────────────────────────────────────────────────────────

describe('PushFanoutService — participation gate', () => {
  it('no-ops (zero pushWake/send) for a strand this node does not participate in', async () => {
    const h = makeFanout({ participates: [] });
    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toEqual([]);
    expect(h.calls.send).toEqual([]);
    expect(h.calls.resolve).toEqual([]);
  });
});

// ── Direct dial vs platform fallback ──────────────────────────────────────────

describe('PushFanoutService — direct dial vs platform fallback', () => {
  it('reachable peer: direct pushWake resolves → no platform push; cooldown is armed', async () => {
    const h = makeFanout({ defaultPushWake: { accepted: true, status: 'active' }, debounceMs: 0 });

    await h.service.notify('strand-1');
    expect(h.calls.pushWake.map((c) => c.peerId)).toEqual(['peer-a']);
    expect(h.calls.resolve).toEqual([]); // reached over control net → never resolve/send
    expect(h.calls.send).toEqual([]);

    // Cooldown was armed by the (successful) direct wake: a second pass past the
    // debounce window still skips peer-a — no second dial.
    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toHaveLength(1);
  });

  it('suspended peer: pushWake rejects → resolve → send the exact strand-wake payload + platform', async () => {
    const h = makeFanout({ tokens: { 'peer-a': tokenRecord('peer-a', 'apns') } });

    await h.service.notify('strand-1', 'new-tx');

    expect(h.calls.pushWake.map((c) => c.peerId)).toEqual(['peer-a']);
    expect(h.calls.resolve).toEqual(['peer-a']);
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.send[0]).toEqual({
      token: 'tok-peer-a',
      platform: 'apns',
      payload: { type: STRAND_WAKE_TYPE, strandId: 'strand-1', reason: 'new-tx' },
    });
  });

  it('non-mobile peer: pushWake rejects, resolveDeviceToken → null → no send', async () => {
    const h = makeFanout({ tokens: { 'peer-a': null } });
    await h.service.notify('strand-1');
    expect(h.calls.pushWake.map((c) => c.peerId)).toEqual(['peer-a']);
    expect(h.calls.resolve).toEqual(['peer-a']);
    expect(h.calls.send).toEqual([]);
  });

  it('ack-rejected ≠ dial-failed: a WakeAck with accepted:false does NOT fall back to platform push', async () => {
    const h = makeFanout({ defaultPushWake: { accepted: false, reason: 'unknown strand' } });
    await h.service.notify('strand-1');
    expect(h.calls.pushWake.map((c) => c.peerId)).toEqual(['peer-a']);
    expect(h.calls.resolve).toEqual([]); // reached the peer; receiver declined — not a transport failure
    expect(h.calls.send).toEqual([]);
  });
});

// ── Self-exclusion ────────────────────────────────────────────────────────────

describe('PushFanoutService — self-exclusion', () => {
  it('never wakes our own peerId', async () => {
    const h = makeFanout({
      members: [{ peerId: 'self-peer', multiaddr: null }, { peerId: 'peer-a', multiaddr: null }],
      tokens: { 'peer-a': tokenRecord('peer-a') },
    });
    await h.service.notify('strand-1');
    expect(h.calls.pushWake.map((c) => c.peerId)).toEqual(['peer-a']);
    expect(h.calls.send.map((m) => m.token)).toEqual(['tok-peer-a']);
  });
});

// ── Cooldown (per peer,strand) ────────────────────────────────────────────────

describe('PushFanoutService — per-(peer,strand) cooldown', () => {
  it('skips a peer woken within cooldownMs and wakes again once it elapses', async () => {
    const h = makeFanout({ cooldownMs: 1_000, debounceMs: 0, startClock: 1_000 });

    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toHaveLength(1);
    expect(h.calls.send).toHaveLength(1);

    // Within cooldown (and debounce is 0, so debounce does not mask it): no new wake.
    h.setClock(1_500);
    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toHaveLength(1);
    expect(h.calls.send).toHaveLength(1);

    // Past cooldown: wakes again.
    h.setClock(2_001);
    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toHaveLength(2);
    expect(h.calls.send).toHaveLength(2);
  });

  it('cooldown is independent per strand', async () => {
    const h = makeFanout({ participates: ['strand-1', 'strand-2'], cooldownMs: 60_000, debounceMs: 0 });
    await h.service.notify('strand-1');
    await h.service.notify('strand-2');
    // Same peer, two different strands → two independent wakes.
    expect(h.calls.pushWake.map((c) => c.strandId)).toEqual(['strand-1', 'strand-2']);
  });
});

// ── Debounce + concurrency coalescing (per strand) ────────────────────────────

describe('PushFanoutService — debounce + concurrency', () => {
  it('two notify(strandId) within debounceMs collapse to one fan-out pass', async () => {
    const h = makeFanout({ debounceMs: 10_000, startClock: 1_000 });
    await h.service.notify('strand-1');
    await h.service.notify('strand-1'); // same clock → debounced
    expect(h.calls.pushWake).toHaveLength(1);
    expect(h.calls.send).toHaveLength(1);
  });

  it('concurrent notify for the same strand joins one in-flight pass', async () => {
    // debounceMs:0 isolates the in-flight guard from the debounce path.
    const h = makeFanout({ debounceMs: 0 });
    await Promise.all([h.service.notify('strand-1'), h.service.notify('strand-1')]);
    expect(h.calls.pushWake).toHaveLength(1);
    expect(h.calls.send).toHaveLength(1);
  });
});

// ── Stale-token expiry ────────────────────────────────────────────────────────

describe('PushFanoutService — unregistered token expiry', () => {
  it('on send→unregistered, expires the token and skips resolve→send on the next pass', async () => {
    const h = makeFanout({
      cooldownMs: 1_000,
      debounceMs: 0,
      startClock: 1_000,
      sendResult: { ok: false, unregistered: true, error: 'gone' },
    });

    await h.service.notify('strand-1');
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.expire).toEqual(['peer-a']);

    // Next pass past cooldown: the dead-token set short-circuits before resolve→send,
    // even though the direct dial is re-attempted (and still rejects).
    h.setClock(2_001);
    await h.service.notify('strand-1');
    expect(h.calls.pushWake).toHaveLength(2);
    expect(h.calls.resolve).toHaveLength(1); // not resolved a second time
    expect(h.calls.send).toHaveLength(1);     // not sent a second time
    expect(h.calls.expire).toEqual(['peer-a']);
  });

  it('a transient (non-unregistered) failure does NOT expire the token', async () => {
    const h = makeFanout({ sendResult: { ok: false, unregistered: false, error: 'backend 500' } });
    await h.service.notify('strand-1');
    expect(h.calls.send).toHaveLength(1);
    expect(h.calls.expire).toEqual([]);
  });
});

// ── Best-effort: never throws to the trigger ──────────────────────────────────

describe('PushFanoutService — best-effort', () => {
  it('notify never rejects even if a node primitive throws', async () => {
    const h = makeFanout();
    // Make listMembers throw mid-pass.
    const opts = (h.service as unknown as { deps: PushFanoutOptions }).deps;
    opts.listMembers = async () => { throw new Error('control DB unavailable'); };
    await expect(h.service.notify('strand-1')).resolves.toBeUndefined();
  });

  it('a concurrent joiner does not reject when the in-flight pass rejects', async () => {
    // Regression: a second notify that joins an in-flight pass via `return inflight`
    // must not adopt that pass's rejection (it would escape notify's own try/catch
    // and surface as an unhandled rejection at the `void notify(...)` trigger).
    const h = makeFanout({ debounceMs: 0 });
    const opts = (h.service as unknown as { deps: PushFanoutOptions }).deps;
    let rejectMembers: (e: Error) => void = () => {};
    opts.listMembers = () => new Promise<FanoutMember[]>((_resolve, reject) => { rejectMembers = reject; });

    // First call parks awaiting listMembers (pass in flight); second joins it.
    const first = h.service.notify('strand-1');
    const second = h.service.notify('strand-1');
    rejectMembers(new Error('control DB unavailable'));

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('close() releases the notifier transport', async () => {
    const h = makeFanout();
    await h.service.close();
    expect(h.calls.close).toBe(1);
  });
});
