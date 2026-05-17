import { describe, it, expect } from 'vitest';

import { EventBus } from '../events/bus.js';
import type { LocalUiEvent } from '../events/types.js';

describe('EventBus', () => {
  it('delivers events to subscribers in order', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'trust-circle-changed', kind: 'invited' });
    bus.publish({ type: 'trust-circle-changed', kind: 'revoked' });
    expect(received).toEqual([
      { type: 'trust-circle-changed', kind: 'invited' },
      { type: 'trust-circle-changed', kind: 'revoked' },
    ]);
  });

  it('unsubscribe stops further deliveries', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'trust-circle-changed', kind: 'invited' });
    unsub();
    bus.publish({ type: 'trust-circle-changed', kind: 'redeemed' });
    expect(received).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('one listener throwing does not block others', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'trust-circle-changed', kind: 'invited' });
    expect(received).toHaveLength(1);
  });
});
