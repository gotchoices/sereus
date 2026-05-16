import { describe, expect, it, vi } from 'vitest';

import { NatError } from '../types.js';
import {
  PortMapperService,
  type PortMapper,
  type PortMappingResult,
} from '../port-mapper.js';

interface FakeOpts {
  mapShouldThrow?: Error;
  verifyResult?: boolean;
  verifyShouldThrow?: Error;
  externalIp?: string | null;
}

function makeFakeMapper(initial: FakeOpts = {}): PortMapper & {
  calls: { map: number; verify: number; unmap: number; stop: number };
  options: FakeOpts;
} {
  const opts = { ...initial };
  const calls = { map: 0, verify: 0, unmap: 0, stop: 0 };
  return {
    options: opts,
    calls,
    async map(o): Promise<PortMappingResult> {
      calls.map++;
      if (opts.mapShouldThrow) throw opts.mapShouldThrow;
      return {
        mode: 'auto-upnp',
        externalIp: opts.externalIp ?? '203.0.113.1',
        externalPort: o.externalPort,
        internalPort: o.internalPort,
        protocol: o.protocol ?? 'tcp',
        leaseExpiresAt: new Date(Date.now() + (o.ttlMs ?? 60_000)),
      };
    },
    async verify() {
      calls.verify++;
      if (opts.verifyShouldThrow) throw opts.verifyShouldThrow;
      return opts.verifyResult ?? true;
    },
    async externalIp() {
      return opts.externalIp ?? '203.0.113.1';
    },
    async unmap() {
      calls.unmap++;
    },
    async stop() {
      calls.stop++;
    },
  };
}

function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (h: NodeJS.Timeout) => void;
  fire(): void;
  pending: number;
} {
  let callback: (() => void) | null = null;
  return {
    setTimer: (fn) => {
      callback = fn;
      return {} as NodeJS.Timeout;
    },
    clearTimer: () => {
      callback = null;
    },
    fire: () => {
      const cb = callback;
      callback = null;
      cb?.();
    },
    get pending() { return callback ? 1 : 0; },
  };
}

describe('PortMapperService', () => {
  it('installs the mapping on start and records mode + externalIp', async () => {
    const mapper = makeFakeMapper({ externalIp: '203.0.113.42' });
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper,
      externalPort: 4001,
      internalPort: 4001,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await svc.start();
    const state = svc.getState();
    expect(state.mode).toBe('auto-upnp');
    expect(state.routerExternalIp).toBe('203.0.113.42');
    expect(state.externalPort).toBe(4001);
    expect(state.lastError).toBeNull();
    expect(mapper.calls.map).toBe(1);
  });

  it('flips to mode=failed when the mapper throws', async () => {
    const mapper = makeFakeMapper({ mapShouldThrow: new NatError('mapping_failed', 'router said no') });
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper,
      externalPort: 4001,
      internalPort: 4001,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await svc.start();
    expect(svc.getState().mode).toBe('failed');
    expect(svc.getState().lastError).toContain('router said no');
  });

  it('unmaps and stops the mapper on stop()', async () => {
    const mapper = makeFakeMapper();
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper,
      externalPort: 4001,
      internalPort: 4001,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await svc.start();
    await svc.stop();
    expect(mapper.calls.unmap).toBeGreaterThanOrEqual(1);
    expect(mapper.calls.stop).toBeGreaterThanOrEqual(1);
    expect(svc.getState().mode).toBe('disabled');
  });

  it('stop() is idempotent', async () => {
    const mapper = makeFakeMapper();
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper, externalPort: 4001, internalPort: 4001,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    await svc.start();
    await svc.stop();
    await svc.stop();
    expect(mapper.calls.unmap).toBe(1);
  });

  it('refresh() re-maps when verify fails', async () => {
    const mapper = makeFakeMapper({ verifyResult: false });
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper, externalPort: 4001, internalPort: 4001,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    await svc.start();
    expect(mapper.calls.map).toBe(1);

    await svc.refresh();
    // verify=false → re-map
    expect(mapper.calls.map).toBe(2);
  });

  it('refresh() re-issues the mapping when verify succeeds (extends lease)', async () => {
    const mapper = makeFakeMapper({ verifyResult: true });
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper, externalPort: 4001, internalPort: 4001,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    await svc.start();
    expect(mapper.calls.map).toBe(1);
    await svc.refresh();
    expect(mapper.calls.map).toBe(2);
    expect(mapper.calls.verify).toBe(1);
  });

  it('schedules a refresh timer', async () => {
    const mapper = makeFakeMapper();
    const timers = fakeTimers();
    const svc = new PortMapperService({
      mapper, externalPort: 4001, internalPort: 4001,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    await svc.start();
    expect(timers.pending).toBe(1);

    // Fire the timer — should re-arm after the inner refresh resolves.
    timers.fire();
    // Wait for the async refresh chain to complete.
    await new Promise((r) => setTimeout(r, 0));
    expect(timers.pending).toBe(1);
  });
});
