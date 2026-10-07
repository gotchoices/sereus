/**
 * Reachability verdicts: one per hosted node, and the host-level roll-up the
 * dashboard badge shows. Heuristics over the mapping table, not a dial-back —
 * libp2p AutoNAT is a later ticket.
 */

import type {
  DirectReachability,
  NodeReachability,
  NodeVerdict,
  PortKind,
  PortRoute,
} from './types.js';

export interface NodeVerdictInput {
  tcp: PortRoute;
  /** Null for a handle persisted by an older build without a WebSocket port. */
  ws: PortRoute | null;
  /** Whether a public host part exists: a DDNS hostname, or a public IPv4. */
  hostKnown: boolean;
  cgnatDetected: boolean;
  upnpEnabled: boolean;
  gatewayFound: boolean;
  /** The address a user forwards to; null when no gateway was found. */
  lanAddress: string | null;
}

export interface NodeVerdictResult {
  verdict: NodeVerdict;
  reason: string | null;
}

/**
 * `unreachable` when either port has no usable route or the host part is
 * unknown; otherwise `manual` when either port is forwarded by hand, else
 * `mapped`. A UPnP route under CGNAT is not usable: the router's mapping is on
 * a carrier-private address.
 */
export function evaluateNodeReachability(input: NodeVerdictInput): NodeVerdictResult {
  const ports = portRoutes(input);
  const failing = ports.filter(({ route }) => !usable(route, input.cgnatDetected));
  if (!input.hostKnown) {
    return { verdict: 'unreachable', reason: HOST_UNKNOWN_REASON };
  }
  if (failing.length > 0) {
    return { verdict: 'unreachable', reason: describeFailures(failing, input) };
  }
  const manual = ports.some(({ route }) => route.source === 'manual');
  return { verdict: manual ? 'manual' : 'mapped', reason: null };
}

/**
 * Host roll-up: `cgnat` when CGNAT is detected and no node is reachable
 * through a manual route; `unknown` with no running nodes; `reachable` when
 * every running node is `mapped`/`manual`; else `unreachable`.
 */
export function evaluateHostReachability(
  nodes: ReadonlyArray<Pick<NodeReachability, 'running' | 'verdict'>>,
  cgnatDetected: boolean,
): DirectReachability {
  const running = nodes.filter((n) => n.running);
  if (cgnatDetected && !running.some((n) => n.verdict === 'manual')) return 'cgnat';
  if (running.length === 0) return 'unknown';
  return running.every((n) => n.verdict !== 'unreachable') ? 'reachable' : 'unreachable';
}

const HOST_UNKNOWN_REASON =
  "This host's public address is unknown: no dynamic DNS hostname is set and no public IPv4 address was detected. " +
  'Set a DDNS hostname, or check that this machine can reach the internet.';

interface PortEntry {
  kind: PortKind;
  route: PortRoute;
}

function portRoutes(input: NodeVerdictInput): PortEntry[] {
  const out: PortEntry[] = [{ kind: 'tcp', route: input.tcp }];
  if (input.ws) out.push({ kind: 'ws', route: input.ws });
  return out;
}

function usable(route: PortRoute, cgnatDetected: boolean): boolean {
  if (route.externalPort === null || route.source === null) return false;
  return !(cgnatDetected && route.source === 'upnp');
}

type FailureCause = 'cgnat' | 'refused' | 'upnp_off' | 'no_gateway' | 'pending';

function causeOf(route: PortRoute, input: NodeVerdictInput): FailureCause {
  if (input.cgnatDetected && route.source === 'upnp') return 'cgnat';
  if (route.error) return 'refused';
  if (!input.upnpEnabled) return 'upnp_off';
  if (!input.gatewayFound) return 'no_gateway';
  return 'pending';
}

/** One sentence per distinct cause, each naming every port that failed for it. */
function describeFailures(failing: PortEntry[], input: NodeVerdictInput): string {
  const byCause = new Map<FailureCause, PortEntry[]>();
  for (const entry of failing) {
    const cause = causeOf(entry.route, input);
    byCause.set(cause, [...(byCause.get(cause) ?? []), entry]);
  }
  return [...byCause.entries()].map(([cause, entries]) => describeCause(cause, entries, input)).join(' ');
}

function describeCause(cause: FailureCause, entries: PortEntry[], input: NodeVerdictInput): string {
  const names = entries.map(({ kind, route }) => `${kindLabel(kind)} port ${route.internalPort}`);
  const lan = input.lanAddress ?? "this machine's LAN address";
  const forwardHint = `Forward ${entries.length === 1 ? 'port' : 'ports'} ${listPorts(entries)} to ${lan} on your router, then enter the external ${entries.length === 1 ? 'port' : 'ports'} here.`;
  switch (cause) {
    case 'cgnat':
      return `This host is behind carrier-grade NAT, so the router's mapping of the ${joinNames(names)} cannot be reached from outside and a port forward on your router will not help; a relay is needed.`;
    case 'refused': {
      const errors = entries.map(({ route }) => route.error).filter((e): e is string => !!e);
      return `Router refused the ${joinNames(names)} mapping (${errors.join('; ')}). ${forwardHint}`;
    }
    case 'upnp_off':
      return `UPnP is off, so the ${joinNames(names)} ${entries.length === 1 ? 'is' : 'are'} not mapped. Turn UPnP on, or: ${lowerFirst(forwardHint)}`;
    case 'no_gateway':
      return `No UPnP router answered, so the ${joinNames(names)} ${entries.length === 1 ? 'is' : 'are'} not mapped. Enable UPnP on your router, or: ${lowerFirst(forwardHint)}`;
    case 'pending':
      return `The ${joinNames(names)} ${entries.length === 1 ? 'is' : 'are'} not mapped yet; the router is being asked.`;
  }
}

function kindLabel(kind: PortKind): string {
  return kind === 'tcp' ? 'TCP' : 'WebSocket';
}

function listPorts(entries: PortEntry[]): string {
  return joinNames(entries.map(({ route }) => String(route.internalPort)));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
