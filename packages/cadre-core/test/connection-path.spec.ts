import { describe, it, expect } from 'vitest';
import {
  classifyTransport,
  classifyConnectionPath,
  summarizeConnectionPaths,
  emptyConnectionPathSummary,
  DEFAULT_SETTLE_WINDOW_MS,
  type ConnectionLike,
  type ConnectionPathKind,
  type ConnectionTransport,
} from '../src/diagnostics/connection-path.js';

// ── Classifier table ──────────────────────────────────────────────────────────
// The same table is mirrored in the web parity spec
// (reference-app-web/e2e/solo/connection-path-parity.spec.ts) to guard the two
// copies against drift.
export const CLASSIFIER_TABLE: Array<{
  addr: string;
  kind: ConnectionPathKind;
  transport: ConnectionTransport;
  /**
   * The externally-set TURN-relay hint. When set, the row is classified via
   * {@link classifyConnectionPath} (the hint-aware classifier) rather than the
   * pure {@link classifyTransport}, which cannot see it.
   */
  turnRelayed?: boolean;
}> = [
  {
    addr: '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/p2p/QmTarget',
    kind: 'relayed',
    transport: 'circuit-relay',
  },
  {
    // Browser-to-browser WebRTC dialed over a relay: the connection keeps the
    // circuit prefix but its data path is direct, so it must classify as
    // direct/webrtc (WebRTC checks precede /p2p-circuit). Regression guard.
    addr: '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmTarget',
    kind: 'direct',
    transport: 'webrtc',
  },
  {
    addr: '/ip4/1.2.3.4/udp/9/webrtc-direct/certhash/uEiAabc/p2p/QmTarget',
    kind: 'direct',
    transport: 'webrtc-direct',
  },
  {
    addr: '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmTarget',
    kind: 'direct',
    transport: 'webrtc',
  },
  {
    addr: '/ip4/127.0.0.1/tcp/4001/ws/p2p/QmTarget',
    kind: 'direct',
    transport: 'websocket',
  },
  {
    addr: '/ip4/127.0.0.1/tcp/4001/p2p/QmTarget',
    kind: 'direct',
    transport: 'tcp',
  },
  { addr: '', kind: 'direct', transport: 'unknown' },
  { addr: 'not-a-multiaddr', kind: 'direct', transport: 'unknown' },
  {
    // WebRTC whose ICE selected a TURN relay candidate: the turnRelayed hint
    // promotes it from direct/webrtc to relayed/webrtc-turn. Not expressible as a
    // pure addr→class mapping, so it is asserted via classifyConnectionPath only.
    addr: '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmTurn',
    turnRelayed: true,
    kind: 'relayed',
    transport: 'webrtc-turn',
  },
];

describe('classifyTransport', () => {
  // Pure addr→class rows only — the TURN hint is not expressible as a string.
  for (const { addr, kind, transport, turnRelayed } of CLASSIFIER_TABLE) {
    if (turnRelayed) continue;
    it(`classifies "${addr || '(empty)'}" as ${kind}/${transport}`, () => {
      expect(classifyTransport(addr)).toEqual({ kind, transport });
    });
  }

  it('never throws on garbage input', () => {
    expect(() => classifyTransport(undefined as unknown as string)).not.toThrow();
    expect(classifyTransport(undefined as unknown as string)).toEqual({
      kind: 'direct',
      transport: 'unknown',
    });
  });

  it('is unchanged by the TURN hint: a webrtc addr stays direct/webrtc (pure string fn)', () => {
    // classifyTransport takes only the addr string and can never see turnRelayed.
    expect(classifyTransport('/ip4/1.2.3.4/udp/9/webrtc/p2p/QmX')).toEqual({
      kind: 'direct',
      transport: 'webrtc',
    });
  });
});

describe('classifyConnectionPath', () => {
  // The full table, including the TURN-hint row, drives the hint-aware classifier.
  for (const { addr, kind, transport, turnRelayed } of CLASSIFIER_TABLE) {
    const label = turnRelayed ? ` (turnRelayed)` : '';
    it(`classifies "${addr || '(empty)'}"${label} as ${kind}/${transport}`, () => {
      const conn = makeConn({ remoteAddr: addr, turnRelayed });
      expect(classifyConnectionPath(conn)).toEqual({ kind, transport });
    });
  }

  it('delegates to classifyTransport when no TURN hint is set', () => {
    const conn = makeConn({ remoteAddr: '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmX' });
    expect(classifyConnectionPath(conn)).toEqual({ kind: 'direct', transport: 'webrtc' });
  });

  it('promotes webrtc → webrtc-turn (relayed) when turnRelayed is true', () => {
    const conn = makeConn({ remoteAddr: WEBRTC_ADDR, turnRelayed: true });
    expect(classifyConnectionPath(conn)).toEqual({ kind: 'relayed', transport: 'webrtc-turn' });
  });

  it('does NOT promote webrtc-direct even with a turnRelayed hint (ICE not used)', () => {
    const conn = makeConn({
      remoteAddr: '/ip4/1.2.3.4/udp/9/webrtc-direct/certhash/uEiAabc/p2p/QmX',
      turnRelayed: true,
    });
    expect(classifyConnectionPath(conn)).toEqual({ kind: 'direct', transport: 'webrtc-direct' });
  });

  it('ignores turnRelayed:false (stays direct/webrtc)', () => {
    const conn = makeConn({ remoteAddr: WEBRTC_ADDR, turnRelayed: false });
    expect(classifyConnectionPath(conn)).toEqual({ kind: 'direct', transport: 'webrtc' });
  });
});

// ── Synthetic Connection helpers ──────────────────────────────────────────────

interface MakeConnOpts {
  peerId?: string;
  remoteAddr?: string;
  direction?: 'inbound' | 'outbound';
  openedAtMs?: number | null;
  metrics?: { bytesReceived?: number; bytesSent?: number };
  turnRelayed?: boolean;
}

function makeConn(opts: MakeConnOpts): ConnectionLike {
  const conn: ConnectionLike & { metrics?: MakeConnOpts['metrics'] } = {
    remotePeer: { toString: () => opts.peerId ?? 'QmDefaultPeer' },
    remoteAddr: { toString: () => opts.remoteAddr ?? '' },
    direction: opts.direction ?? 'outbound',
    timeline: opts.openedAtMs === null ? {} : { open: opts.openedAtMs ?? Date.now() },
    turnRelayed: opts.turnRelayed,
  };
  if (opts.metrics) conn.metrics = opts.metrics;
  return conn;
}

const RELAY_ADDR = '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/p2p/QmPeerA';
const WEBRTC_ADDR = '/ip4/1.2.3.4/udp/9/webrtc/p2p/QmPeerA';
// Browser-to-browser WebRTC keeps the relay's circuit prefix but is direct.
const WEBRTC_OVER_CIRCUIT_ADDR =
  '/ip4/1.2.3.4/tcp/443/wss/p2p/QmRelay/p2p-circuit/webrtc/p2p/QmPeerA';
const WS_ADDR = '/ip4/127.0.0.1/tcp/4001/ws/p2p/QmPeerB';

describe('summarizeConnectionPaths', () => {
  it('returns an all-zero summary for an empty connection list', () => {
    const summary = summarizeConnectionPaths([]);
    expect(summary).toEqual(emptyConnectionPathSummary());
    expect(summary.total).toBe(0);
    expect(summary.paths).toEqual([]);
    expect(summary.settleWindowMs).toBe(DEFAULT_SETTLE_WINDOW_MS);
  });

  it('handles null/undefined connection input without throwing', () => {
    expect(() => summarizeConnectionPaths(null)).not.toThrow();
    expect(summarizeConnectionPaths(undefined).total).toBe(0);
  });

  it('flags an aged relayed conn with no direct sibling as stuck', () => {
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: RELAY_ADDR,
      openedAtMs: Date.now() - 20_000,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.total).toBe(1);
    expect(summary.relayed).toBe(1);
    expect(summary.direct).toBe(0);
    expect(summary.stuckOnRelay).toBe(1);
    expect(summary.paths[0]!.stuckOnRelay).toBe(true);
    expect(summary.paths[0]!.kind).toBe('relayed');
    expect(summary.paths[0]!.transport).toBe('circuit-relay');
  });

  it('does NOT flag a relayed conn when the same peer also has a direct conn (upgrade succeeded)', () => {
    const relayed = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: RELAY_ADDR,
      openedAtMs: Date.now() - 20_000,
    });
    const direct = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: WEBRTC_ADDR,
      openedAtMs: Date.now() - 1_000,
    });
    const summary = summarizeConnectionPaths([relayed, direct], 10_000);

    expect(summary.total).toBe(2);
    expect(summary.relayed).toBe(1);
    expect(summary.direct).toBe(1);
    expect(summary.stuckOnRelay).toBe(0);
    const relayedPath = summary.paths.find((p) => p.kind === 'relayed');
    expect(relayedPath!.stuckOnRelay).toBe(false);
  });

  it('treats an aged webrtc-over-circuit conn as direct, never stuck (hole-punch succeeded)', () => {
    // The successful WebRTC connection retains the circuit prefix in its
    // remoteAddr; it must still be classified direct/webrtc and never flagged
    // stuck, even with no separate direct sibling and an age past the window.
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: WEBRTC_OVER_CIRCUIT_ADDR,
      openedAtMs: Date.now() - 20_000,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.total).toBe(1);
    expect(summary.direct).toBe(1);
    expect(summary.relayed).toBe(0);
    expect(summary.stuckOnRelay).toBe(0);
    expect(summary.byTransport.webrtc).toBe(1);
    expect(summary.byTransport['circuit-relay']).toBe(0);
    expect(summary.paths[0]!.kind).toBe('direct');
    expect(summary.paths[0]!.transport).toBe('webrtc');
    expect(summary.paths[0]!.stuckOnRelay).toBe(false);
  });

  it('promotes a turnRelayed webrtc conn to relayed/webrtc-turn and counts it relayed', () => {
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: WEBRTC_ADDR,
      turnRelayed: true,
      openedAtMs: Date.now() - 1_000,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.total).toBe(1);
    expect(summary.relayed).toBe(1);
    expect(summary.direct).toBe(0);
    expect(summary.byTransport['webrtc-turn']).toBe(1);
    expect(summary.byTransport.webrtc).toBe(0);
    expect(summary.paths[0]!.kind).toBe('relayed');
    expect(summary.paths[0]!.transport).toBe('webrtc-turn');
    // Young (within the settle window) → not yet stuck.
    expect(summary.stuckOnRelay).toBe(0);
  });

  it('flags an aged turnRelayed webrtc-turn conn with no direct sibling as stuck', () => {
    // A long-lived TURN session that never upgraded to a direct path is the
    // intended stuck-on-relay signal (webrtc-turn has kind === relayed).
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: WEBRTC_ADDR,
      turnRelayed: true,
      openedAtMs: Date.now() - 20_000,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.relayed).toBe(1);
    expect(summary.stuckOnRelay).toBe(1);
    expect(summary.paths[0]!.transport).toBe('webrtc-turn');
    expect(summary.paths[0]!.stuckOnRelay).toBe(true);
  });

  it('does NOT flag a turnRelayed conn when the same peer also has a direct conn', () => {
    const turnRelayed = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: WEBRTC_ADDR,
      turnRelayed: true,
      openedAtMs: Date.now() - 20_000,
    });
    const direct = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: '/ip4/9.9.9.9/udp/9/webrtc-direct/certhash/uEiAabc/p2p/QmPeerA',
      openedAtMs: Date.now() - 1_000,
    });
    const summary = summarizeConnectionPaths([turnRelayed, direct], 10_000);

    expect(summary.relayed).toBe(1);
    expect(summary.direct).toBe(1);
    expect(summary.byTransport['webrtc-turn']).toBe(1);
    expect(summary.byTransport['webrtc-direct']).toBe(1);
    expect(summary.stuckOnRelay).toBe(0);
  });

  it('does NOT flag a relayed conn younger than the settle window (still settling)', () => {
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: RELAY_ADDR,
      openedAtMs: Date.now() - 1_000,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.relayed).toBe(1);
    expect(summary.stuckOnRelay).toBe(0);
    expect(summary.paths[0]!.stuckOnRelay).toBe(false);
  });

  it('does NOT flag a relayed conn with no open timestamp (unknown age)', () => {
    const conn = makeConn({
      peerId: 'QmPeerA',
      remoteAddr: RELAY_ADDR,
      openedAtMs: null,
    });
    const summary = summarizeConnectionPaths([conn], 10_000);

    expect(summary.paths[0]!.ageMs).toBeNull();
    expect(summary.paths[0]!.openedAtMs).toBeNull();
    expect(summary.stuckOnRelay).toBe(0);
  });

  it('counts byTransport and relayed/direct/total consistently', () => {
    const conns = [
      makeConn({ peerId: 'A', remoteAddr: RELAY_ADDR }),
      makeConn({ peerId: 'B', remoteAddr: WEBRTC_ADDR }),
      makeConn({ peerId: 'C', remoteAddr: WS_ADDR }),
      makeConn({ peerId: 'D', remoteAddr: '/ip4/9.9.9.9/tcp/4001/p2p/QmTcp' }),
    ];
    const summary = summarizeConnectionPaths(conns);

    expect(summary.total).toBe(4);
    expect(summary.relayed).toBe(1);
    expect(summary.direct).toBe(3);
    expect(summary.byTransport['circuit-relay']).toBe(1);
    expect(summary.byTransport.webrtc).toBe(1);
    expect(summary.byTransport.websocket).toBe(1);
    expect(summary.byTransport.tcp).toBe(1);
    expect(summary.byTransport['webrtc-direct']).toBe(0);
    expect(summary.byTransport.unknown).toBe(0);

    // byTransport sums to total; relayed + direct == total.
    const transportSum = Object.values(summary.byTransport).reduce((a, b) => a + b, 0);
    expect(transportSum).toBe(summary.total);
    expect(summary.relayed + summary.direct).toBe(summary.total);
  });

  it('reports bytesOverRelay as null when connections expose no byte counter', () => {
    const conn = makeConn({ peerId: 'A', remoteAddr: RELAY_ADDR });
    const summary = summarizeConnectionPaths([conn]);
    expect(summary.bytesOverRelay).toBeNull();
  });

  it('sums bytesOverRelay best-effort when a metrics counter is present, and never throws', () => {
    const conns = [
      makeConn({
        peerId: 'A',
        remoteAddr: RELAY_ADDR,
        metrics: { bytesReceived: 100, bytesSent: 50 },
      }),
      // direct conn with metrics must NOT count toward bytesOverRelay
      makeConn({
        peerId: 'B',
        remoteAddr: WEBRTC_ADDR,
        metrics: { bytesReceived: 999, bytesSent: 999 },
      }),
    ];
    let summary: ReturnType<typeof summarizeConnectionPaths>;
    expect(() => {
      summary = summarizeConnectionPaths(conns);
    }).not.toThrow();
    expect(summary!.bytesOverRelay).toBe(150);
  });

  it('preserves direction and computes ageMs from openedAtMs', () => {
    const openedAtMs = Date.now() - 5_000;
    const conn = makeConn({
      peerId: 'A',
      remoteAddr: WEBRTC_ADDR,
      direction: 'inbound',
      openedAtMs,
    });
    const summary = summarizeConnectionPaths([conn]);
    const path = summary.paths[0]!;
    expect(path.direction).toBe('inbound');
    expect(path.openedAtMs).toBe(openedAtMs);
    expect(path.ageMs).toBeGreaterThanOrEqual(5_000);
  });
});
