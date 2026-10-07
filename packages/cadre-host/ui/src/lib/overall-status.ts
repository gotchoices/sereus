/**
 * The one-word health summary shown in the header and on Home.
 *
 * A plain module (not inside `state.svelte.ts`) so it is unit testable without
 * the Svelte compiler.
 */

import type {
	NatStatusSnapshot,
	NodeInfo,
	OverallStatus,
	UpdateState,
} from './state.svelte.js';

/**
 * Every node the host runs is mapped through the router, so a host whose nodes
 * cannot be reached from outside is a warning, and so is any stopped node. Until
 * the connectivity is known nothing is decided.
 */
export function deriveOverallStatus(
	connectivity: NatStatusSnapshot | null,
	nodes: NodeInfo[],
	update: UpdateState | null,
): OverallStatus {
	if (!connectivity) return 'loading';
	const reachability = connectivity.directReachability;
	if (reachability === 'unreachable' || reachability === 'cgnat') return 'warn';
	if (nodes.some((n) => n.status !== 'running')) return 'warn';
	if (update?.lastError) return 'warn';
	return 'ok';
}
