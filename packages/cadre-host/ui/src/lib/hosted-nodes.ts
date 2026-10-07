/**
 * Pure helpers for showing hosted nodes — kept out of the components so they
 * run in a plain Vitest environment.
 */

import type { HostedNodeStatus, HostedNodeView, NodeInfo } from './state.svelte.js';

type JoinFacts = Pick<HostedNodeView, 'status' | 'join'>;

/** A node waiting to be claimed, whose code is (or will be) shown. */
export function isWaiting(node: JoinFacts): boolean {
	return node.join.kind === 'claim' && (node.status === 'spawning' || node.status === 'unclaimed');
}

/** A node still on its way into its cadre: waiting to be claimed, or redeeming its invitation. */
export function isPending(node: Pick<HostedNodeView, 'status'>): boolean {
	return node.status === 'spawning' || node.status === 'unclaimed' || node.status === 'joining';
}

/** A failed invitation node that Retry may start again: no member of its cadre could be reached. */
export function canRetryInvitation(node: Pick<HostedNodeView, 'status' | 'retryable'>): boolean {
	return node.status === 'error' && node.retryable === true;
}

/**
 * Shown beside a failed invitation that Retry may help: no member could be reached, which is
 * the usual case for a cadre's first always-on node, whose only members are phones.
 */
export const UNREACHABLE_HINT = 'If this is the cadre\'s first always-on node, no member can be reached yet: '
	+ 'remove this node, use Join a cadre and scan the code from the phone instead. '
	+ 'Otherwise, retry once a member of the cadre is online.';

/** The first 8 characters of an owner key, as `cadre-host join` and `node list` print it. */
export function ownerFingerprint(ownerKey: string | undefined): string {
	return ownerKey ? ownerKey.slice(0, 8) : '—';
}

/** The cadre the node joined, or null before it joined. Joining (a claim, or an accepted invitation) sets the owner key. */
export function claimedCadre(node: Pick<HostedNodeView, 'partyId' | 'ownerKey'>): string | null {
	return node.ownerKey ? node.partyId : null;
}

/** Whether a claimed node holds a control connection; meaningless before the claim. */
export function connectedText(node: Pick<HostedNodeView, 'status' | 'connected'>): string {
	if (node.status !== 'joined') return '—';
	return node.connected ? 'yes' : 'no';
}

/** Where the node is in its lifecycle, in words: the Join page's live line and the node page's status. */
export function stateLine(
	node: Pick<HostedNodeView, 'join' | 'status' | 'partyId' | 'ownerKey' | 'memberPeerId' | 'connected' | 'error'>,
): string {
	switch (node.status) {
		case 'spawning':
			return 'Starting the node…';
		case 'unclaimed':
			return 'Waiting for a phone to claim this node';
		case 'joining':
			return `Joining cadre ${node.partyId}…`;
		case 'joined':
			if (node.connected) return 'Connected to the cadre';
			return node.join.kind === 'invitation'
				? `Joined cadre ${node.partyId} at member ${node.memberPeerId ?? '(unnamed)'}`
				: `Claimed by owner ${ownerFingerprint(node.ownerKey)} into cadre ${node.partyId}`;
		case 'error':
			return node.join.kind === 'invitation' && node.error
				? `Could not join: ${node.error}`
				: `Stopped after a failure: ${node.error ?? 'no detail recorded'}`;
	}
}

export const STATUS_BADGE: Record<HostedNodeStatus, { text: string; tone: 'ok' | 'warn' | 'err' | 'info' }> = {
	spawning: { text: 'starting', tone: 'info' },
	unclaimed: { text: 'waiting', tone: 'info' },
	joining: { text: 'joining', tone: 'info' },
	joined: { text: 'joined', tone: 'ok' },
	error: { text: 'failed', tone: 'err' },
};

/** Who a node is for, as the Connectivity page labels it. */
export function hostedLabel(node: HostedNodeView | undefined): string {
	if (!node) return 'hosted node';
	const cadre = claimedCadre(node);
	if (cadre) return `hosted node for cadre ${cadre}`;
	if (isWaiting(node)) return 'waiting to be claimed';
	return isPending(node) ? `joining cadre ${node.partyId}` : 'hosted node';
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
