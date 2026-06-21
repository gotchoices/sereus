/**
 * connection-path.ts — classify each open libp2p connection as relayed
 * (`/p2p-circuit`) vs direct, tag its transport, and summarise counts plus a
 * "stuck on relay" condition.
 *
 * ── DELIBERATE DUPLICATE ──────────────────────────────────────────────────────
 * The canonical implementation lives in cadre-core at
 * `packages/cadre-core/src/diagnostics/connection-path.ts`. This file is a
 * line-for-line copy of its logic.
 *
 * NOTE: as of the cadre-node rebase the web app now DOES depend on
 * `@serfab/cadre-core`, so this duplicate could be collapsed by importing
 * cadre-core's `summarizeConnectionPaths` / `classifyTransport` instead. It is
 * deliberately kept as a standalone copy for now (the ticket scoped this file as
 * "reused, unchanged"); the e2e/parity test guards the two copies against drift.
 * Collapsing it into a single import is a tracked follow-up cleanup. Both copies
 * operate on the `@libp2p/interface` `Connection` type, so the logic is identical.
 */

export type ConnectionPathKind = 'relayed' | 'direct';

export type ConnectionTransport =
  | 'circuit-relay'
  | 'webrtc'
  | 'webrtc-turn'   // WebRTC session whose ICE selected a TURN relay candidate
  | 'webrtc-direct'
  | 'websocket'
  | 'tcp'
  | 'unknown';

export interface ConnectionPath {
  /** remotePeer.toString() */
  peerId: string;
  remoteAddr: string;
  kind: ConnectionPathKind;
  transport: ConnectionTransport;
  direction: 'inbound' | 'outbound';
  /** connection.timeline.open ?? null */
  openedAtMs: number | null;
  /** now - openedAtMs */
  ageMs: number | null;
  /** relayed && age > settleWindow && no direct conn to same peer */
  stuckOnRelay: boolean;
}

export interface ConnectionPathSummary {
  total: number;
  relayed: number;
  direct: number;
  stuckOnRelay: number;
  byTransport: Record<ConnectionTransport, number>;
  /** best-effort; null when libp2p exposes no byte counter */
  bytesOverRelay: number | null;
  paths: ConnectionPath[];
  settleWindowMs: number;
}

/**
 * The minimal connection shape the classifier needs. The stock libp2p
 * `Connection` (from `@libp2p/interface`) satisfies this structurally, and
 * tests can build small synthetic objects against it.
 */
export interface ConnectionLike {
  remotePeer?: { toString(): string };
  remoteAddr?: { toString(): string };
  direction?: 'inbound' | 'outbound';
  timeline?: { open?: number };
  /**
   * Set externally when ICE selected a TURN relay candidate for this `/webrtc`
   * session. `undefined` = unknown (the multiaddr alone cannot reveal it). Only
   * honoured for the `webrtc` transport — see {@link classifyConnectionPath}.
   */
  turnRelayed?: boolean;
}

export const DEFAULT_SETTLE_WINDOW_MS = 10_000;

const ALL_TRANSPORTS: readonly ConnectionTransport[] = [
  'circuit-relay',
  'webrtc',
  'webrtc-turn',
  'webrtc-direct',
  'websocket',
  'tcp',
  'unknown',
];

interface TransportClass {
  kind: ConnectionPathKind;
  transport: ConnectionTransport;
}

/**
 * Classify a remote multiaddr string into a (kind, transport) pair. Order
 * matters — first match wins (see cadre-core original for the full table).
 * WebRTC is checked before `/p2p-circuit`: a browser-to-browser WebRTC
 * connection keeps the relay's circuit prefix in its remoteAddr
 * (`…/p2p-circuit/webrtc/…`) yet its data path is direct.
 */
export function classifyTransport(remoteAddr: string): TransportClass {
  const addr = remoteAddr ?? '';
  if (addr.includes('/webrtc-direct')) return { kind: 'direct', transport: 'webrtc-direct' };
  if (addr.includes('/webrtc')) return { kind: 'direct', transport: 'webrtc' };
  if (addr.includes('/p2p-circuit')) return { kind: 'relayed', transport: 'circuit-relay' };
  if (addr.includes('/ws')) return { kind: 'direct', transport: 'websocket' };
  if (addr.includes('/tcp')) return { kind: 'direct', transport: 'tcp' };
  return { kind: 'direct', transport: 'unknown' };
}

/** Read a connection's remote address as a string, never throwing. */
function addrString(conn: ConnectionLike): string {
  try {
    return conn.remoteAddr?.toString?.() ?? '';
  } catch {
    return '';
  }
}

/**
 * Per-connection classifier. Starts from the pure multiaddr classification, then
 * applies the TURN override: a `/webrtc` session whose ICE selected a TURN relay
 * candidate (`conn.turnRelayed === true`, set externally) is reclassified
 * `relayed`/`webrtc-turn`. The `transport === 'webrtc'` guard means `webrtc-direct`
 * is never promoted (it uses no ICE), and `undefined` degrades safely to the
 * multiaddr result.
 */
export function classifyConnectionPath(conn: ConnectionLike): TransportClass {
  const { kind, transport } = classifyTransport(addrString(conn));
  if (transport === 'webrtc' && conn.turnRelayed === true) {
    return { kind: 'relayed', transport: 'webrtc-turn' };
  }
  return { kind, transport };
}

/**
 * Best-effort per-connection byte counter. The stock libp2p `Connection`
 * interface carries no byte counter, so unless a metrics implementation is
 * wired into the node this returns `null`. Never throws.
 */
function readConnectionBytes(conn: ConnectionLike): number | null {
  try {
    const metrics = (conn as { metrics?: { bytesReceived?: number; bytesSent?: number } }).metrics;
    if (!metrics) return null;
    const received = typeof metrics.bytesReceived === 'number' ? metrics.bytesReceived : 0;
    const sent = typeof metrics.bytesSent === 'number' ? metrics.bytesSent : 0;
    const total = received + sent;
    return Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

function zeroByTransport(): Record<ConnectionTransport, number> {
  const out = {} as Record<ConnectionTransport, number>;
  for (const t of ALL_TRANSPORTS) out[t] = 0;
  return out;
}

/** An all-zero summary, used when no node/connections are available. */
export function emptyConnectionPathSummary(
  settleWindowMs: number = DEFAULT_SETTLE_WINDOW_MS,
): ConnectionPathSummary {
  return {
    total: 0,
    relayed: 0,
    direct: 0,
    stuckOnRelay: 0,
    byTransport: zeroByTransport(),
    bytesOverRelay: null,
    paths: [],
    settleWindowMs,
  };
}

/**
 * Build a {@link ConnectionPathSummary} from the node's current connections.
 * See the cadre-core original for the stuck-on-relay semantics.
 */
export function summarizeConnectionPaths(
  conns: Iterable<ConnectionLike> | null | undefined,
  settleWindowMs: number = DEFAULT_SETTLE_WINDOW_MS,
): ConnectionPathSummary {
  const now = Date.now();
  const list = conns ? Array.from(conns) : [];

  const classified = list.map((conn) => {
    const remoteAddr = addrString(conn);
    // classifyConnectionPath (not classifyTransport) so the externally-set
    // turnRelayed hint promotes webrtc → webrtc-turn (relayed).
    const { kind, transport } = classifyConnectionPath(conn);
    const openedAtMs = typeof conn.timeline?.open === 'number' ? conn.timeline.open : null;
    const ageMs = openedAtMs != null ? Math.max(0, now - openedAtMs) : null;
    const peerId = safePeerId(conn);
    const direction: 'inbound' | 'outbound' = conn.direction === 'inbound' ? 'inbound' : 'outbound';
    return { conn, peerId, remoteAddr, kind, transport, openedAtMs, ageMs, direction };
  });

  const directPeerSet = new Set(
    classified.filter((c) => c.kind === 'direct').map((c) => c.peerId),
  );

  const byTransport = zeroByTransport();
  let relayed = 0;
  let direct = 0;
  let stuckCount = 0;
  let bytesOverRelay: number | null = null;

  const paths: ConnectionPath[] = classified.map((c) => {
    byTransport[c.transport] += 1;
    if (c.kind === 'relayed') {
      relayed += 1;
      const bytes = readConnectionBytes(c.conn);
      if (bytes != null) bytesOverRelay = (bytesOverRelay ?? 0) + bytes;
    } else {
      direct += 1;
    }

    const stuckOnRelay =
      c.kind === 'relayed' &&
      c.ageMs != null &&
      c.ageMs > settleWindowMs &&
      !directPeerSet.has(c.peerId);
    if (stuckOnRelay) stuckCount += 1;

    return {
      peerId: c.peerId,
      remoteAddr: c.remoteAddr,
      kind: c.kind,
      transport: c.transport,
      direction: c.direction,
      openedAtMs: c.openedAtMs,
      ageMs: c.ageMs,
      stuckOnRelay,
    };
  });

  return {
    total: list.length,
    relayed,
    direct,
    stuckOnRelay: stuckCount,
    byTransport,
    bytesOverRelay,
    paths,
    settleWindowMs,
  };
}

function safePeerId(conn: ConnectionLike): string {
  try {
    return conn.remotePeer?.toString?.() ?? '';
  } catch {
    return '';
  }
}
