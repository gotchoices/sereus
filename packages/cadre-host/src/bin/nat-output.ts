/**
 * Human-readable output of the `cadre-host nat` commands: the host-level NAT
 * state, then one block per hosted node, with the forward to make on the
 * router when a node cannot be reached from outside.
 *
 * The types are loose mirrors of `NatStatusSnapshot` (`../nat/types.ts`): the
 * body arrives over HTTP from whichever cadre-host version is running, so every
 * field is optional and a missing one prints as `?`.
 */

export interface NatPortRouteLike {
  internalPort?: number;
  externalPort?: number | null;
  source?: string | null;
  error?: string | null;
}

export interface NatNodeLike {
  nodeId?: string;
  running?: boolean;
  verdict?: string;
  reason?: string | null;
  tcp?: NatPortRouteLike;
  ws?: NatPortRouteLike | null;
  publicAddrs?: string[];
}

export interface NatStatusLike {
  network?: { setting?: string; mode?: string; publicInterfaceIp?: string | null };
  upnpEnabled?: boolean;
  gateway?: {
    found?: boolean;
    lanAddress?: string | null;
    routerExternalIp?: string | null;
    lastError?: string | null;
  };
  externalIp?: string | null;
  cgnatDetected?: boolean;
  directReachability?: string;
  lastTestedAt?: string | null;
  nodes?: NatNodeLike[];
  ddns?: {
    providerId?: string | null;
    hostname?: string | null;
    externallyManaged?: boolean;
    lastUpdateAt?: string | null;
    lastUpdateOk?: boolean | null;
    lastError?: string | null;
  };
}

type PortKind = 'tcp' | 'ws';

interface PortEntry {
  kind: PortKind;
  route: NatPortRouteLike;
}

const KIND_LABEL: Record<PortKind, string> = { tcp: 'TCP', ws: 'WebSocket' };

/** Width of the label column inside a node block. */
const FIELD_WIDTH = 11;

/**
 * A forward changes the node's public addresses only when it changes the
 * external port or makes a port routable, and the restart that follows is
 * rate-limited per node (`NAT_ADDRESS_RESTART_MIN_INTERVAL_MS`).
 */
const FORWARD_RESTART_NOTE =
  'If its public addresses changed, the node restarts to announce them; a node already restarted ' +
  'for an address change in the last 10 minutes waits until those 10 minutes are up.';

export function printNatStatus(s: NatStatusLike): void {
  printHostLines(s);
  printDdns(s);
  const nodes = s.nodes ?? [];
  console.log(nodes.length === 0 ? '\nNodes: none' : '\nNodes:');
  for (const n of nodes) printNodeReachability(n, s);
}

/** The block for the node a forward was saved for, then what happens next. */
export function printForwardResult(nodeId: string, s: NatStatusLike): void {
  const node = s.nodes?.find((n) => n.nodeId === nodeId);
  if (node) printNodeReachability(node, s);
  console.log(`\n${FORWARD_RESTART_NOTE}`);
}

function printHostLines(s: NatStatusLike): void {
  const network = s.network ?? {};
  const how = network.setting === 'auto' || network.setting === undefined ? 'detected' : 'set';
  if (network.mode === 'public') {
    console.log(`Network:      public IP ${network.publicInterfaceIp ?? s.externalIp ?? '?'} on this machine (${how}); no router, so no UPnP`);
    console.log(`External IP:  ${s.externalIp ?? network.publicInterfaceIp ?? '(unknown)'}`);
    console.log(`Reachability: ${s.directReachability ?? 'unknown'}${s.lastTestedAt ? `  (tested ${s.lastTestedAt})` : ''}`);
    return;
  }
  console.log(`Network:      behind a router (${how})`);
  const gateway = s.gateway ?? {};
  const gatewayLine = gateway.found
    ? `found (this machine is ${gateway.lanAddress ?? '?'} on its network)`
    : `not found${gateway.lastError ? ` — ${gateway.lastError}` : ''}`;
  console.log(`UPnP:         ${s.upnpEnabled === false ? 'off' : 'on'}; router ${gatewayLine}`);
  if (gateway.routerExternalIp) {
    console.log(`Router IP:    ${gateway.routerExternalIp}`);
  }
  console.log(`External IP:  ${s.externalIp ?? '(unknown)'}${s.cgnatDetected ? '  [CGNAT detected]' : ''}`);
  console.log(`Reachability: ${s.directReachability ?? 'unknown'}${s.lastTestedAt ? `  (tested ${s.lastTestedAt})` : ''}`);
}

function printDdns(s: NatStatusLike): void {
  const ddns = s.ddns ?? {};
  if (!ddns.providerId && !ddns.hostname) {
    console.log('DDNS:         not configured');
    return;
  }
  console.log(`DDNS:         ${ddns.hostname ?? '(no hostname)'} via ${ddns.providerId ?? '(no provider)'}${ddns.externallyManaged ? '  [externally managed]' : ''}`);
  if (ddns.lastUpdateAt) {
    const ok = ddns.lastUpdateOk ? 'OK' : 'FAIL';
    console.log(`DDNS update:  ${ok} at ${ddns.lastUpdateAt}${ddns.lastError ? `  — ${ddns.lastError}` : ''}`);
  }
}

function printNodeReachability(n: NatNodeLike, s: NatStatusLike): void {
  console.log(`  ${n.nodeId ?? '?'}: ${n.verdict ?? '?'}${n.running === false ? '  [stopped]' : ''}`);
  printField('TCP', [formatRoute(n.tcp)]);
  printField('WebSocket', [n.ws ? formatRoute(n.ws) : 'not available']);
  printField('Public', n.publicAddrs?.length ? n.publicAddrs : ['none']);
  if (n.reason) printField(n.verdict === 'direct' ? 'Firewall' : 'Why', [n.reason]);
  const advice = forwardAdvice(n, s);
  if (advice.length > 0) printField('To fix', advice);
}

function printField(label: string, values: string[]): void {
  values.forEach((value, i) => console.log(`    ${(i === 0 ? label : '').padEnd(FIELD_WIDTH)}${value}`));
}

function formatRoute(r: NatPortRouteLike | undefined): string {
  if (!r) return '?';
  const internal = `internal ${r.internalPort ?? '?'}`;
  if (r.externalPort == null) return `${internal} → not mapped${r.error ? ` (${r.error})` : ''}`;
  const failed = r.error ? `; last attempt failed: ${r.error}` : '';
  if (r.source === 'direct') return `${internal} → public, as-is${failed}`;
  return `${internal} → external ${r.externalPort} (${r.source === 'manual' ? 'forwarded by hand' : 'UPnP'}${failed})`;
}

/**
 * What to do for an unreachable node, one line per array entry. Behind CGNAT a
 * router forward does not help, but the detection can misfire, so the forward
 * command is still offered for every port. With every port routed there is
 * nothing to forward: what is missing is the host's public address, which the
 * reason already explains.
 *
 * NOTE: the UI builds the same sentence (`forwardInstruction` in
 * `ui/src/lib/reachability.ts`); if the rule for which ports to forward
 * changes, have the server send the port list in `NodeReachability` instead
 * of changing both copies.
 */
function forwardAdvice(n: NatNodeLike, s: NatStatusLike): string[] {
  if (n.verdict !== 'unreachable') return [];
  const nodeId = n.nodeId ?? '<node-id>';
  const ports = portsOf(n);
  if (s.cgnatDetected) {
    return [
      'Carrier-grade NAT detected: a forward on your router will not help, and cadre-host cannot reserve a relay for its nodes yet.',
      'If the detection is wrong and you did forward ports, tell cadre-host with:',
      `  ${forwardCommand(nodeId, ports)}`,
    ];
  }
  const unrouted = ports.filter(({ route }) => route.externalPort == null);
  if (unrouted.length === 0) return [];
  const lan = s.gateway?.lanAddress ?? null;
  const forwards = unrouted.map(({ kind, route }) => {
    const port = route.internalPort ?? '?';
    return `${KIND_LABEL[kind]} port ${port} to ${lan ? `${lan}:${port}` : `port ${port} on this machine's LAN address`}`;
  });
  return [`On your router, forward ${forwards.join(' and ')}, then run:`, `  ${forwardCommand(nodeId, unrouted)}`];
}

function portsOf(n: NatNodeLike): PortEntry[] {
  const out: PortEntry[] = [];
  if (n.tcp) out.push({ kind: 'tcp', route: n.tcp });
  if (n.ws) out.push({ kind: 'ws', route: n.ws });
  return out;
}

function forwardCommand(nodeId: string, ports: PortEntry[]): string {
  return ['cadre-host nat forward', nodeId, ...ports.map(({ kind }) => `--${kind} <external port>`)].join(' ');
}
