import { describe, expect, it } from 'vitest';

import { evaluateHostReachability, evaluateNodeReachability, type NodeVerdictInput } from '../reachability.js';
import type { PortRoute } from '../types.js';

function upnp(internalPort: number): PortRoute {
  return { internalPort, externalPort: internalPort, source: 'upnp', leaseExpiresAt: null, error: null };
}
function manual(internalPort: number): PortRoute {
  return { internalPort, externalPort: 40000, source: 'manual', leaseExpiresAt: null, error: null };
}
function none(internalPort: number, error: string | null = null): PortRoute {
  return { internalPort, externalPort: null, source: null, leaseExpiresAt: null, error };
}

const BASE: NodeVerdictInput = {
  tcp: upnp(10003),
  ws: upnp(10004),
  hostKnown: true,
  cgnatDetected: false,
  upnpEnabled: true,
  gatewayFound: true,
  lanAddress: '192.168.1.20',
};

describe('evaluateNodeReachability', () => {
  it('mapped when both ports have UPnP routes', () => {
    expect(evaluateNodeReachability(BASE)).toEqual({ verdict: 'mapped', reason: null });
  });

  it('manual when either port is forwarded by hand', () => {
    expect(evaluateNodeReachability({ ...BASE, ws: manual(10004) }).verdict).toBe('manual');
  });

  it('a node without a WebSocket port is judged on TCP alone', () => {
    expect(evaluateNodeReachability({ ...BASE, ws: null }).verdict).toBe('mapped');
  });

  it('unreachable when the host part is unknown, whatever the routes', () => {
    const r = evaluateNodeReachability({ ...BASE, hostKnown: false });
    expect(r.verdict).toBe('unreachable');
    expect(r.reason).toContain('public address is unknown');
  });

  it('a refused port names the port, the LAN address and the remedy', () => {
    const r = evaluateNodeReachability({ ...BASE, ws: none(10004, 'mapping table is full') });
    expect(r.verdict).toBe('unreachable');
    expect(r.reason).toBe(
      'Router refused the WebSocket port 10004 mapping (mapping table is full). ' +
      'Forward port 10004 to 192.168.1.20 on your router, then enter the external port here.',
    );
  });

  it('two ports failing for one cause are named in one sentence', () => {
    const r = evaluateNodeReachability({ ...BASE, tcp: none(10003), ws: none(10004), upnpEnabled: false });
    expect(r.reason).toContain('TCP port 10003 and WebSocket port 10004 are not mapped');
    expect(r.reason).toContain('forward ports 10003 and 10004 to 192.168.1.20');
  });

  it('with no gateway the remedy says so and falls back to a generic LAN address', () => {
    const r = evaluateNodeReachability({ ...BASE, tcp: none(10003), ws: none(10004), gatewayFound: false, lanAddress: null });
    expect(r.reason).toContain('No UPnP router answered');
    expect(r.reason).toContain("this machine's LAN address");
  });

  it('a port not yet attempted reads as pending', () => {
    expect(evaluateNodeReachability({ ...BASE, tcp: none(10003) }).reason).toContain('not mapped yet');
  });

  it('under CGNAT a UPnP route is unreachable and a forward will not help; manual routes are fine', () => {
    const r = evaluateNodeReachability({ ...BASE, cgnatDetected: true });
    expect(r.verdict).toBe('unreachable');
    expect(r.reason).toContain('carrier-grade NAT');
    expect(r.reason).toContain('a relay is needed');
    expect(evaluateNodeReachability({ ...BASE, cgnatDetected: true, tcp: manual(10003), ws: manual(10004) }).verdict).toBe('manual');
  });
});

describe('evaluateHostReachability', () => {
  it('unknown with no running nodes', () => {
    expect(evaluateHostReachability([], false)).toBe('unknown');
    expect(evaluateHostReachability([{ running: false, verdict: 'unreachable' }], false)).toBe('unknown');
  });

  it('reachable when every running node is mapped or manual', () => {
    expect(evaluateHostReachability([
      { running: true, verdict: 'mapped' },
      { running: true, verdict: 'manual' },
      { running: false, verdict: 'unreachable' },
    ], false)).toBe('reachable');
  });

  it('unreachable when any running node is', () => {
    expect(evaluateHostReachability([
      { running: true, verdict: 'mapped' },
      { running: true, verdict: 'unreachable' },
    ], false)).toBe('unreachable');
  });

  it('cgnat when detected and no node is reachable through a manual route', () => {
    expect(evaluateHostReachability([{ running: true, verdict: 'unreachable' }], true)).toBe('cgnat');
    expect(evaluateHostReachability([], true)).toBe('cgnat');
    expect(evaluateHostReachability([{ running: true, verdict: 'manual' }], true)).toBe('reachable');
  });
});
