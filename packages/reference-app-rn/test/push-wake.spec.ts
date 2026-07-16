import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CadreNode, PushPlatform, ServiceWakeResult } from '@serfab/cadre-core';
import {
  parseStrandWakePayload,
  extractPushData,
  pushPlatformFromTokenType,
  createPushWakeHandler,
  createDeviceTokenRegistrar,
  awaitControlConnected,
  STRAND_WAKE_TYPE,
} from '../src/push-wake';

// ── Test double ──────────────────────────────────────────────────────────────

/** CadreNode stub exposing only the surface the push-wake core touches. */
class MockNode {
  running = true;
  controlConnected = true;
  serviceWake = vi.fn(
    async (strandId: string, _opts?: { windowMs?: number }): Promise<ServiceWakeResult> => ({
      strandId,
      serviced: true,
      hadActivity: false,
    }),
  );
  wakeStrand = vi.fn(async (_strandId: string): Promise<void> => {});
  recordStrandActivity = vi.fn((_strandId: string): void => {});
  registerDeviceToken = vi.fn(async (_p: PushPlatform, _t: string): Promise<void> => {});
  clearDeviceToken = vi.fn(async (): Promise<void> => {});

  private handlers = new Map<string, Set<() => void>>();
  on(event: string, handler: () => void): void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
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

const VALID = { type: STRAND_WAKE_TYPE, strandId: 'strand-123', reason: 'activity' };

// ── Parser ─────────────────────────────────────────────────────────────────

describe('parseStrandWakePayload', () => {
  it('parses a valid strand-wake payload', () => {
    expect(parseStrandWakePayload(VALID)).toEqual({
      type: 'strand-wake',
      strandId: 'strand-123',
      reason: 'activity',
    });
  });

  it('defaults a missing reason to "unknown"', () => {
    expect(parseStrandWakePayload({ type: STRAND_WAKE_TYPE, strandId: 's1' })?.reason).toBe('unknown');
  });

  it.each([
    ['wrong type', { type: 'other', strandId: 's1' }],
    ['missing type', { strandId: 's1' }],
    ['missing strandId', { type: STRAND_WAKE_TYPE }],
    ['empty strandId', { type: STRAND_WAKE_TYPE, strandId: '' }],
    ['non-string strandId', { type: STRAND_WAKE_TYPE, strandId: 42 }],
    ['null', null],
    ['string', 'strand-wake'],
  ])('returns null for %s (no throw)', (_label, input) => {
    expect(parseStrandWakePayload(input)).toBeNull();
  });
});

// ── Data extraction ──────────────────────────────────────────────────────────

describe('extractPushData', () => {
  it('parses Android-style data.dataString JSON', () => {
    const payload = { data: { dataString: JSON.stringify(VALID) } };
    expect(extractPushData(payload)).toEqual(VALID);
  });

  it('returns the data object directly when no dataString (iOS-style)', () => {
    const payload = { data: VALID };
    expect(extractPushData(payload)).toEqual(VALID);
  });

  it('returns null for malformed dataString JSON (no throw)', () => {
    expect(extractPushData({ data: { dataString: '{not json' } })).toBeNull();
  });

  it.each([[null], [undefined], ['str'], [{}], [{ data: null }], [{ data: 7 }]])(
    'returns null for non-data payload %o',
    (input) => {
      expect(extractPushData(input)).toBeNull();
    },
  );
});

// ── Platform mapping ─────────────────────────────────────────────────────────

describe('pushPlatformFromTokenType', () => {
  it('maps ios → apns and android → fcm', () => {
    expect(pushPlatformFromTokenType('ios')).toBe('apns');
    expect(pushPlatformFromTokenType('android')).toBe('fcm');
  });
  it('returns null for unsupported types', () => {
    expect(pushPlatformFromTokenType('web')).toBeNull();
    expect(pushPlatformFromTokenType('')).toBeNull();
  });
});

// ── awaitControlConnected ─────────────────────────────────────────────────────

describe('awaitControlConnected', () => {
  it('resolves true immediately when already connected', async () => {
    const node = new MockNode();
    await expect(awaitControlConnected(asNode(node), 1000)).resolves.toBe(true);
  });

  it('resolves true on a control:connected edge and cleans up its listener', async () => {
    const node = new MockNode();
    node.controlConnected = false;
    const p = awaitControlConnected(asNode(node), 1000);
    expect(node.listenerCount('control:connected')).toBe(1);
    node.controlConnected = true;
    node.emit('control:connected');
    await expect(p).resolves.toBe(true);
    expect(node.listenerCount('control:connected')).toBe(0);
  });

  it('resolves false on timeout', async () => {
    vi.useFakeTimers();
    try {
      const node = new MockNode();
      node.controlConnected = false;
      const p = awaitControlConnected(asNode(node), 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe(false);
      expect(node.listenerCount('control:connected')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Handler ──────────────────────────────────────────────────────────────────

describe('createPushWakeHandler', () => {
  let node: MockNode;
  beforeEach(() => {
    node = new MockNode();
  });

  it('background valid payload → serviceWake called once with the conservative window', async () => {
    const handler = createPushWakeHandler({
      getNode: () => asNode(node),
      isForeground: () => false,
      windowMs: 2500,
    });
    const outcome = await handler.handle(VALID);
    expect(node.serviceWake).toHaveBeenCalledTimes(1);
    expect(node.serviceWake).toHaveBeenCalledWith('strand-123', { windowMs: 2500 });
    expect(outcome).toMatchObject({ handled: true, mode: 'service-wake', strandId: 'strand-123' });
    expect(node.wakeStrand).not.toHaveBeenCalled();
  });

  it('unknown strand (serviced:false) → no error, outcome carries the result', async () => {
    node.serviceWake.mockResolvedValueOnce({ strandId: 'strand-123', serviced: false, hadActivity: false });
    const handler = createPushWakeHandler({ getNode: () => asNode(node), isForeground: () => false });
    const outcome = await handler.handle(VALID);
    expect(outcome).toMatchObject({ handled: true, mode: 'service-wake' });
    if (outcome.handled && outcome.mode === 'service-wake') {
      expect(outcome.result.serviced).toBe(false);
    }
  });

  it('foreground → routes to wakeStrand + recordStrandActivity, not serviceWake', async () => {
    const handler = createPushWakeHandler({ getNode: () => asNode(node), isForeground: () => true });
    const outcome = await handler.handle(VALID);
    expect(node.wakeStrand).toHaveBeenCalledWith('strand-123');
    expect(node.recordStrandActivity).toHaveBeenCalledWith('strand-123');
    expect(node.serviceWake).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ handled: true, mode: 'foreground' });
  });

  it('malformed payload → handled:false, no node calls', async () => {
    const handler = createPushWakeHandler({ getNode: () => asNode(node), isForeground: () => false });
    const outcome = await handler.handle({ type: 'nope' });
    expect(outcome).toEqual({ handled: false, reason: 'malformed' });
    expect(node.serviceWake).not.toHaveBeenCalled();
  });

  it('background with no node and no ensureNode → no-node no-op', async () => {
    const handler = createPushWakeHandler({ getNode: () => null, isForeground: () => false });
    const outcome = await handler.handle(VALID);
    expect(outcome).toEqual({ handled: false, reason: 'no-node' });
  });

  it('cold start: ensureNode brings the node up, then serviceWake runs', async () => {
    let current: MockNode | null = null;
    const ensureNode = vi.fn(async () => {
      current = node;
    });
    const handler = createPushWakeHandler({
      getNode: () => (current ? asNode(current) : null),
      ensureNode,
      isForeground: () => false,
    });
    const outcome = await handler.handle(VALID);
    expect(ensureNode).toHaveBeenCalledTimes(1);
    expect(node.serviceWake).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ handled: true, mode: 'service-wake' });
  });

  it('awaits control before serviceWake on a cold/disconnected wake', async () => {
    vi.useFakeTimers();
    try {
      node.controlConnected = false;
      const handler = createPushWakeHandler({
        getNode: () => asNode(node),
        isForeground: () => false,
        controlSettleTimeoutMs: 5000,
      });
      const p = handler.handle(VALID);
      await Promise.resolve();
      // Not yet serviced — still awaiting the control edge.
      expect(node.serviceWake).not.toHaveBeenCalled();
      node.controlConnected = true;
      node.emit('control:connected');
      await p;
      expect(node.serviceWake).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('foreground with no node → no-node no-op (never throws, no node calls)', async () => {
    const handler = createPushWakeHandler({ getNode: () => null, isForeground: () => true });
    const outcome = await handler.handle(VALID);
    expect(outcome).toEqual({ handled: false, reason: 'no-node' });
    expect(node.serviceWake).not.toHaveBeenCalled();
    expect(node.wakeStrand).not.toHaveBeenCalled();
  });

  it('foreground wakeStrand failure is swallowed → still handled, no recordStrandActivity', async () => {
    node.wakeStrand.mockRejectedValueOnce(new Error('strand gone'));
    const handler = createPushWakeHandler({ getNode: () => asNode(node), isForeground: () => true });
    const outcome = await handler.handle(VALID);
    expect(outcome).toMatchObject({ handled: true, mode: 'foreground' });
    // The throw short-circuits before recordStrandActivity; serviceWake is never reached.
    expect(node.recordStrandActivity).not.toHaveBeenCalled();
    expect(node.serviceWake).not.toHaveBeenCalled();
  });

  it('cold start: a stopped (not-running) node is restarted via ensureNode before serviceWake', async () => {
    node.running = false;
    const ensureNode = vi.fn(async () => {
      node.running = true;
    });
    const handler = createPushWakeHandler({
      getNode: () => asNode(node),
      ensureNode,
      isForeground: () => false,
    });
    const outcome = await handler.handle(VALID);
    expect(ensureNode).toHaveBeenCalledTimes(1);
    expect(node.serviceWake).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ handled: true, mode: 'service-wake' });
  });

  it('background: ensureNode that fails to bring a node up → no-node no-op', async () => {
    const ensureNode = vi.fn(async () => {
      /* never starts a node */
    });
    const handler = createPushWakeHandler({
      getNode: () => null,
      ensureNode,
      isForeground: () => false,
    });
    const outcome = await handler.handle(VALID);
    expect(ensureNode).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ handled: false, reason: 'no-node' });
  });
});

// ── Registrar ────────────────────────────────────────────────────────────────

describe('createDeviceTokenRegistrar', () => {
  let node: MockNode;
  beforeEach(() => {
    node = new MockNode();
  });

  it('register → calls registerDeviceToken with the raw token and returns true', async () => {
    const reg = createDeviceTokenRegistrar({ getNode: () => asNode(node) });
    await expect(reg.register('fcm', 'token-abc')).resolves.toBe(true);
    expect(node.registerDeviceToken).toHaveBeenCalledWith('fcm', 'token-abc');
  });

  it('register defers (false) when the node is not running, without calling through', async () => {
    node.running = false;
    const reg = createDeviceTokenRegistrar({ getNode: () => asNode(node) });
    await expect(reg.register('apns', 't')).resolves.toBe(false);
    expect(node.registerDeviceToken).not.toHaveBeenCalled();
  });

  it('register defers (false) when registerDeviceToken throws (pre-membership)', async () => {
    node.registerDeviceToken.mockRejectedValueOnce(new Error('no owner-seeded row yet'));
    const reg = createDeviceTokenRegistrar({ getNode: () => asNode(node) });
    await expect(reg.register('fcm', 't')).resolves.toBe(false);
  });

  it('clear → calls clearDeviceToken', async () => {
    const reg = createDeviceTokenRegistrar({ getNode: () => asNode(node) });
    await reg.clear();
    expect(node.clearDeviceToken).toHaveBeenCalledTimes(1);
  });

  it('clear is a no-op when the node is stopped', async () => {
    node.running = false;
    const reg = createDeviceTokenRegistrar({ getNode: () => asNode(node) });
    await reg.clear();
    expect(node.clearDeviceToken).not.toHaveBeenCalled();
  });
});
