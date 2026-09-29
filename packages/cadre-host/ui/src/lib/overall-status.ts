/**
 * The one-word health summary shown in the header and on Home.
 *
 * A plain module (not inside `state.svelte.ts`) so it is unit testable without
 * the Svelte compiler.
 */

import type {
	HostRole,
	NatStatusSnapshot,
	NodeInfo,
	OverallStatus,
	UpdateState,
} from './state.svelte.js';

/**
 * Connectivity counts only for a founder: a donor host runs no NAT service, so
 * its `connectivity` stays null for good and must not hold the status at
 * `'loading'`. Until the role is known nothing is decided.
 *
 * A donor ignores its owner node: one left stopped by an earlier founder run
 * stays listed (its state persists on disk) but is off by the owner's choice.
 */
export function deriveOverallStatus(
	role: HostRole | null,
	connectivity: NatStatusSnapshot | null,
	nodes: NodeInfo[],
	update: UpdateState | null,
): OverallStatus {
	if (role === null) return 'loading';
	if (role === 'founder') {
		if (!connectivity) return 'loading';
		const reachability = connectivity.directReachability;
		if (reachability === 'unreachable' || reachability === 'cgnat') return 'warn';
	}
	if (nodes.some((n) => n.status !== 'running' && !(role === 'donor' && n.owner))) return 'warn';
	if (update?.lastError) return 'warn';
	return 'ok';
}
