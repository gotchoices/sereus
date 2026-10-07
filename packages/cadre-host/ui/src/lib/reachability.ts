/**
 * Pure helpers for showing one hosted node's reachability from outside the
 * home network — kept out of the components so they run in a plain Vitest
 * environment.
 */

import type { NatStatusSnapshot, NodeReachability, NodeVerdict, PortRoute } from './state.svelte.js';

export type PortKind = 'tcp' | 'ws';

export const PORT_KIND_LABEL: Record<PortKind, string> = { tcp: 'TCP', ws: 'WebSocket' };

export const VERDICT_LABEL: Record<NodeVerdict, string> = {
	mapped: 'reachable (UPnP)',
	manual: 'reachable (forwarded by hand)',
	unreachable: 'not reachable from outside',
};

/** An unreachable node still works on the home network, so it is a warning, as in `overall-status.ts`. */
export function verdictTone(verdict: NodeVerdict): 'ok' | 'warn' {
	return verdict === 'unreachable' ? 'warn' : 'ok';
}

export function routeLabel(route: PortRoute | null): string {
	if (!route) return 'not available';
	if (route.externalPort === null) return `${route.internalPort} → not mapped`;
	return `${route.internalPort} → ${route.externalPort} (${route.source === 'manual' ? 'forwarded by hand' : 'UPnP'})`;
}

/** The node's ports in display order; a node from an older build has no WebSocket port. */
export function portsOf(node: NodeReachability): Array<{ kind: PortKind; route: PortRoute }> {
	const out: Array<{ kind: PortKind; route: PortRoute }> = [{ kind: 'tcp', route: node.tcp }];
	if (node.ws) out.push({ kind: 'ws', route: node.ws });
	return out;
}

/**
 * The forward to make on the router, in words, or null when a forward would
 * not fix the node: it is reachable, every port already has a route (the
 * host's public address is what is missing, which the node's reason says), or
 * the host is behind CGNAT, which the page explains on its own.
 */
export function forwardInstruction(
	node: NodeReachability,
	connectivity: Pick<NatStatusSnapshot, 'cgnatDetected' | 'gateway'>,
): string | null {
	if (node.verdict !== 'unreachable' || connectivity.cgnatDetected) return null;
	const unrouted = portsOf(node).filter(({ route }) => route.externalPort === null);
	if (unrouted.length === 0) return null;
	const lan = connectivity.gateway.lanAddress;
	const forwards = unrouted.map(({ kind, route }) => {
		const port = route.internalPort;
		return `${PORT_KIND_LABEL[kind]} port ${port} to ${lan ? `${lan}:${port}` : `port ${port} on this machine's LAN address`}`;
	});
	return `On your router, forward ${forwards.join(' and ')}, then enter the external ${unrouted.length === 1 ? 'port' : 'ports'} below.`;
}

/** The external port the user forwarded by hand, as form text; blank when the port has no manual forward. */
export function manualPortText(route: PortRoute | null): string {
	return route?.source === 'manual' && route.externalPort !== null ? String(route.externalPort) : '';
}

/**
 * One external-port field: blank means no forward (`null`), otherwise a whole
 * number from 1 to 65535. Anything else is `undefined`, refused before sending.
 */
export function parsePortField(text: string): number | null | undefined {
	const trimmed = text.trim();
	if (trimmed === '') return null;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const port = Number(trimmed);
	return port >= 1 && port <= 65535 ? port : undefined;
}
