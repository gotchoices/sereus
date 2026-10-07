import { describe, it, expect } from 'vitest';

import { EventBus } from '../events/bus.js';
import type { LocalUiEvent } from '../events/types.js';

describe('EventBus', () => {
  it('delivers events to subscribers in order', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'grants-changed', kind: 'issued' });
    bus.publish({ type: 'grants-changed', kind: 'revoked' });
    expect(received).toEqual([
      { type: 'grants-changed', kind: 'issued' },
      { type: 'grants-changed', kind: 'revoked' },
    ]);
  });

  it('unsubscribe stops further deliveries', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'grants-changed', kind: 'issued' });
    unsub();
    bus.publish({ type: 'grants-changed', kind: 'terminated' });
    expect(received).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('one listener throwing does not block others', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'grants-changed', kind: 'issued' });
    expect(received).toHaveLength(1);
  });
});
