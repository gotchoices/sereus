/**
 * Pure helpers for showing hosted nodes — kept out of the components so they
 * run in a plain Vitest environment.
 */

import type { HostedNodeStatus, HostedNodeView, NodeInfo } from './state.svelte.js';

/** Statuses of a node that has not been claimed yet and whose code is (or will be) shown. */
export function isWaiting(status: HostedNodeStatus): boolean {
	return status === 'spawning' || status === 'unclaimed';
}

/** The first 8 characters of an owner key, as `cadre-host join` and `node list` print it. */
export function ownerFingerprint(ownerKey: string | undefined): string {
	return ownerKey ? ownerKey.slice(0, 8) : '—';
}

/** The cadre the node joined, or null before the claim. The claim sets the party and the owner key together. */
export function claimedCadre(node: Pick<HostedNodeView, 'partyId' | 'ownerKey'>): string | null {
	return node.ownerKey ? node.partyId : null;
}

/** Whether a claimed node holds a control connection; meaningless before the claim. */
export function connectedText(node: Pick<HostedNodeView, 'status' | 'connected'>): string {
	if (node.status !== 'joined') return '—';
	return node.connected ? 'yes' : 'no';
}

/** Where the node is in its lifecycle, in words: the Join page's live line and the node page's status. */
export function stateLine(node: Pick<HostedNodeView, 'status' | 'partyId' | 'ownerKey' | 'connected' | 'error'>): string {
	switch (node.status) {
		case 'spawning':
			return 'Starting the node…';
		case 'unclaimed':
			return 'Waiting for a phone to claim this node';
		case 'joined':
			return node.connected
				? 'Connected to the cadre'
				: `Claimed by owner ${ownerFingerprint(node.ownerKey)} into cadre ${node.partyId}`;
		case 'error':
			return `Stopped after a failure: ${node.error ?? 'no detail recorded'}`;
	}
}

export const STATUS_BADGE: Record<HostedNodeStatus, { text: string; tone: 'ok' | 'warn' | 'err' | 'info' }> = {
	spawning: { text: 'starting', tone: 'info' },
	unclaimed: { text: 'waiting', tone: 'info' },
	joined: { text: 'joined', tone: 'ok' },
	error: { text: 'failed', tone: 'err' },
};

/** Who a node is for, as the Connectivity page labels it. */
export function hostedLabel(node: HostedNodeView | undefined): string {
	if (!node) return 'hosted node';
	const cadre = claimedCadre(node);
	if (cadre) return `hosted node for cadre ${cadre}`;
	return isWaiting(node.status) ? 'waiting to be claimed' : 'hosted node';
}

/** One row of the Nodes list: a hosted-node record, its orchestrator handle, or both. */
export interface NodeRow {
	id: string;
	hosted: HostedNodeView | null;
	handle: NodeInfo | null;
}

/**
 * Hosted-node records joined by id with the orchestrator's handles. A record
 * may have no handle (its spawn failed) and a handle no record (the record file
 * was lost); either still gets a row, since `Remove` cleans up both. Records
 * come first, oldest first.
 */
export function joinNodeRows(hosted: HostedNodeView[], handles: NodeInfo[]): NodeRow[] {
	const byId = new Map(handles.map((h) => [h.id, h]));
	const rows: NodeRow[] = [...hosted]
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.map((h) => ({ id: h.id, hosted: h, handle: byId.get(h.id) ?? null }));
	const recorded = new Set(hosted.map((h) => h.id));
	for (const handle of handles) {
		if (!recorded.has(handle.id)) rows.push({ id: handle.id, hosted: null, handle });
	}
	return rows;
}
