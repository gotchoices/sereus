import { describe, it, expect } from 'vitest';

import { EventBus } from '../events/bus.js';
import type { LocalUiEvent } from '../events/types.js';

describe('EventBus', () => {
  it('delivers events to subscribers in order', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'hosted-nodes-changed', kind: 'added', nodeId: 'hn_a' });
    bus.publish({ type: 'hosted-nodes-changed', kind: 'claimed', nodeId: 'hn_a' });
    expect(received).toEqual([
      { type: 'hosted-nodes-changed', kind: 'added', nodeId: 'hn_a' },
      { type: 'hosted-nodes-changed', kind: 'claimed', nodeId: 'hn_a' },
    ]);
  });

  it('unsubscribe stops further deliveries', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'hosted-nodes-changed', kind: 'added', nodeId: 'hn_a' });
    unsub();
    bus.publish({ type: 'hosted-nodes-changed', kind: 'removed', nodeId: 'hn_a' });
    expect(received).toHaveLength(1);
    expect(bus.listenerCount()).toBe(0);
  });

  it('one listener throwing does not block others', () => {
    const bus = new EventBus();
    const received: LocalUiEvent[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    bus.subscribe((e) => received.push(e));
    bus.publish({ type: 'hosted-nodes-changed', kind: 'added', nodeId: 'hn_a' });
    expect(received).toHaveLength(1);
  });
});
