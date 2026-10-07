/**
 * The pure port-set logic behind `HostProcessOrchestrator`: the helpers that
 * allocate, hold, release and reuse one node's set of ports, and the listen
 * addresses a child is started with. No child processes — the behaviour these
 * feed is exercised against a stub child in `orchestrator.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { PortAllocator } from '@serfab/cadre-provider';

import { childListenAddrs } from '../orchestrator/host-process-orchestrator.js';
import {
  allocateNodePorts,
  releaseNodePorts,
  reserveNodePorts,
  reusedNodePorts,
} from '../orchestrator/port-allocator.js';
import type { NodePorts } from '../orchestrator/types.js';

/**
 * A port set as `state.json` hands it back from a build that predates the `ws` key:
 * the type says every key is present, the data does not.
 */
function portsWithoutWs(ports: Omit<NodePorts, 'ws'>): NodePorts {
  return ports as NodePorts;
}

describe('allocateNodePorts', () => {
  it('allocates the four ports in a fixed order', () => {
    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a)).toEqual({ health: 10000, metrics: 10001, p2p: 10002, ws: 10003 });
  });

  // A partial set left reserved would leak from a bounded range on every failed
  // provision — the whole reason this helper exists rather than four allocates.
  it('is all-or-nothing: an exhausted range releases everything it took', () => {
    const a = new PortAllocator(13000, 13002);
    expect(() => allocateNodePorts(a)).toThrow(/No available ports/);
    expect(a.has(13000)).toBe(false);
    expect(a.has(13001)).toBe(false);
    expect(a.has(13002)).toBe(false);
  });

  it('honours an override and reserves it', () => {
    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a, { p2p: 10005 })).toEqual({
      health: 10000,
      metrics: 10001,
      p2p: 10005,
      ws: 10002,
    });
    // Reserved, so no later allocation can hand it out again.
    expect(a.has(10005)).toBe(true);
  });

  // A re-spawn passes its previous set as overrides; every one must come back exactly.
  it('returns a full set of overrides exactly, allocating nothing', () => {
    const a = new PortAllocator(10000, 10010);
    const previous = { health: 10006, metrics: 10007, p2p: 10008, ws: 10009 };
    expect(allocateNodePorts(a, previous)).toEqual(previous);
    expect(a.allocate()).toBe(10000);
  });
});

describe('reserveNodePorts / releaseNodePorts', () => {
  it('hold and then release every key of the set', () => {
    const a = new PortAllocator(10000, 10010);
    const ports = { health: 10000, metrics: 10001, p2p: 10002, ws: 10003 };
    reserveNodePorts(a, ports);
    for (const port of Object.values(ports)) expect(a.has(port)).toBe(true);
    releaseNodePorts(a, ports);
    for (const port of Object.values(ports)) expect(a.has(port)).toBe(false);
  });

  // Rehydrating, or dropping, a `state.json` handle written before `ws` existed.
  it('skip a key the set lacks', () => {
    const a = new PortAllocator(10000, 10010);
    const ports = portsWithoutWs({ health: 10000, metrics: 10001, p2p: 10002 });
    reserveNodePorts(a, ports);
    expect(a.has(undefined as unknown as number)).toBe(false);
    expect(a.allocate()).toBe(10003);
    releaseNodePorts(a, ports);
    expect(a.has(10000)).toBe(false);
    expect(a.has(10003)).toBe(true);
  });
});

describe('reusedNodePorts', () => {
  const previous = { health: 10005, metrics: 10006, p2p: 10007, ws: 10008 };

  it("returns the dropped handle's whole port set", () => {
    expect(reusedNodePorts([{ ports: previous }])).toEqual(previous);
  });

  it('returns nothing when nothing was dropped, so every port is allocated fresh', () => {
    expect(reusedNodePorts([])).toEqual({});
  });

  // A handle persisted before `ws` existed: its other ports come back, `ws` is new.
  it('omits a key the dropped handle lacks', () => {
    const legacy = portsWithoutWs({ health: 10005, metrics: 10006, p2p: 10007 });
    const reused = reusedNodePorts([{ ports: legacy }]);
    expect(reused).toEqual({ health: 10005, metrics: 10006, p2p: 10007 });
    expect('ws' in reused).toBe(false);

    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a, reused)).toEqual({ health: 10005, metrics: 10006, p2p: 10007, ws: 10000 });
  });

  it('takes the last handle when a state holding duplicates dropped several', () => {
    const older = { health: 10000, metrics: 10001, p2p: 10002, ws: 10003 };
    expect(reusedNodePorts([{ ports: older }, { ports: previous }])).toEqual(previous);
  });
});

describe('childListenAddrs', () => {
  it('names a TCP listener on the p2p port and a WebSocket listener on the ws port, on every interface', () => {
    expect(childListenAddrs({ p2p: 10002, ws: 10004 })).toEqual([
      '/ip4/0.0.0.0/tcp/10002',
      '/ip4/0.0.0.0/tcp/10004/ws',
    ]);
  });
});
