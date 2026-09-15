/**
 * The pure port-set logic behind `HostProcessOrchestrator`: the allocator, the
 * helpers that allocate, hold, release and reuse one node's set of ports, and the
 * listen addresses a child is started with. No child processes — the behaviour these
 * feed is exercised against a stub child in `orchestrator.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { childListenAddrs } from '../orchestrator/host-process-orchestrator.js';
import {
  allocateNodePorts,
  PortAllocator,
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

describe('PortAllocator', () => {
  it('allocates sequentially, releases, and reuses', () => {
    const a = new PortAllocator(100, 102);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(101);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow(/No available ports/);
    a.release(101);
    expect(a.allocate()).toBe(101);
  });

  it('markUsed reserves ports without allocating', () => {
    const a = new PortAllocator(100, 102);
    a.markUsed(101);
    expect(a.allocate()).toBe(100);
    expect(a.allocate()).toBe(102);
    expect(() => a.allocate()).toThrow();
  });

  // Without the integer check, `undefined` and NaN pass both range comparisons (each
  // is false) and land in the used-set, as would an in-range fraction.
  it('markUsed ignores a non-integer', () => {
    const a = new PortAllocator(100, 101);
    for (const junk of [undefined as unknown as number, Number.NaN, 100.5]) {
      a.markUsed(junk);
      expect(a.has(junk)).toBe(false);
    }
  });
});

describe('allocateNodePorts', () => {
  it('allocates the five ports in a fixed order, the newest key last', () => {
    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a)).toEqual({ health: 10000, metrics: 10001, p2p: 10002, admin: 10003, ws: 10004 });
  });

  // A partial set left reserved would leak from a bounded range on every failed
  // provision — the whole reason this helper exists rather than five allocates.
  it('is all-or-nothing: an exhausted range releases everything it took', () => {
    const a = new PortAllocator(13000, 13002);
    expect(() => allocateNodePorts(a)).toThrow(/No available ports/);
    expect(a.has(13000)).toBe(false);
    expect(a.has(13001)).toBe(false);
    expect(a.has(13002)).toBe(false);
  });

  // Four ports used to be one node's worth. A range sized for that now fails on the
  // fifth, and must neither hand back a set missing `ws` nor keep the four it took.
  it('fails cleanly on a range with room for four ports but not five', () => {
    const a = new PortAllocator(13000, 13003);
    expect(() => allocateNodePorts(a)).toThrow(/No available ports/);
    for (let port = 13000; port <= 13003; port++) expect(a.has(port)).toBe(false);
  });

  // The owner node's p2p port is pinned by the NAT mapping, not allocated.
  it('honours an override and reserves it', () => {
    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a, { p2p: 10005 })).toEqual({
      health: 10000,
      metrics: 10001,
      p2p: 10005,
      admin: 10002,
      ws: 10003,
    });
    // Reserved, so no later allocation can hand it out again.
    expect(a.has(10005)).toBe(true);
  });

  // An out-of-range override is the production case for the owner node: its
  // libp2p port is chosen by NAT config, not by the allocator, so reserving it
  // is a documented no-op rather than an error.
  it('accepts an override outside the managed range without reserving it', () => {
    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a, { p2p: 40000 })).toMatchObject({ p2p: 40000, health: 10000 });
    expect(a.has(40000)).toBe(false);
  });

  // A re-spawn passes its previous set as overrides; every one must come back exactly.
  it('returns a full set of overrides exactly, allocating nothing', () => {
    const a = new PortAllocator(10000, 10010);
    const previous = { health: 10006, metrics: 10007, p2p: 10008, admin: 10009, ws: 10010 };
    expect(allocateNodePorts(a, previous)).toEqual(previous);
    expect(a.allocate()).toBe(10000);
  });
});

describe('reserveNodePorts / releaseNodePorts', () => {
  it('hold and then release every key of the set', () => {
    const a = new PortAllocator(10000, 10010);
    const ports = { health: 10000, metrics: 10001, p2p: 10002, admin: 10003, ws: 10004 };
    reserveNodePorts(a, ports);
    for (const port of Object.values(ports)) expect(a.has(port)).toBe(true);
    releaseNodePorts(a, ports);
    for (const port of Object.values(ports)) expect(a.has(port)).toBe(false);
  });

  // Rehydrating, or dropping, a `state.json` handle written before `ws` existed.
  it('skip a key the set lacks', () => {
    const a = new PortAllocator(10000, 10010);
    const ports = portsWithoutWs({ health: 10000, metrics: 10001, p2p: 10002, admin: 10003 });
    reserveNodePorts(a, ports);
    expect(a.has(undefined as unknown as number)).toBe(false);
    expect(a.allocate()).toBe(10004);
    releaseNodePorts(a, ports);
    expect(a.has(10000)).toBe(false);
    expect(a.has(10004)).toBe(true);
  });
});

describe('reusedNodePorts', () => {
  const previous = { health: 10005, metrics: 10006, p2p: 10007, admin: 10008, ws: 10009 };

  it("returns the dropped handle's whole port set", () => {
    expect(reusedNodePorts([{ ports: previous }])).toEqual(previous);
  });

  it('returns nothing when nothing was dropped, so every port is allocated fresh', () => {
    expect(reusedNodePorts([])).toEqual({});
  });

  // A handle persisted before `ws` existed: its other ports come back, `ws` is new.
  it('omits a key the dropped handle lacks', () => {
    const legacy = portsWithoutWs({ health: 10005, metrics: 10006, p2p: 10007, admin: 10008 });
    const reused = reusedNodePorts([{ ports: legacy }]);
    expect(reused).toEqual({ health: 10005, metrics: 10006, p2p: 10007, admin: 10008 });
    expect('ws' in reused).toBe(false);

    const a = new PortAllocator(10000, 10010);
    expect(allocateNodePorts(a, reused)).toEqual({ health: 10005, metrics: 10006, p2p: 10007, admin: 10008, ws: 10000 });
  });

  it('takes the last handle when a state holding duplicates dropped several', () => {
    const older = { health: 10000, metrics: 10001, p2p: 10002, admin: 10003, ws: 10004 };
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
