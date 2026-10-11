/**
 * Single source of truth for the SPA. Pages read from `appState()` and
 * write back via the wired refresh helpers below. The EventSource client
 * (subscribeEvents) calls `applyEvent` to invalidate the relevant slice.
 *
 * One global $state object beats a store library at this scale; mutations
 * are co-located with the API calls that triggered them.
 */

import { apiDelete, apiFetch, apiPost, apiPut, ApiError } from './api.js';
import { deriveOverallStatus } from './overall-status.js';

// --- Mirrors of server-side types (kept narrow on purpose) ---

export type ContainerStatus = 'running' | 'stopped';

export type DirectReachability = 'reachable' | 'unreachable' | 'unknown' | 'cgnat';
export type NodeVerdict = 'mapped' | 'manual' | 'unreachable';

export interface NodeInfo {
	id: string;
	dockerId: string;
	partyId: string;
	profile: 'storage' | 'transaction';
	status: ContainerStatus;
	spawnedAt: string;
	workdir: string;
	ports: { health: number; metrics: number; p2p: number; ws: number };
}

/** Mirror of cadre-provider's `OrchestratorStats`, the fields the UI shows. */
export interface NodeStats {
	cpuPercent: number;
	/** Resident memory of the node process. */
	memoryBytes: number;
}

/** Mirror of the server's `PortRoute` (`src/nat/types.ts`): how one of a node's ports is reached from outside. */
export interface PortRoute {
	internalPort: number;
	/** Null when there is no route. */
	externalPort: number | null;
	source: 'upnp' | 'manual' | null;
	leaseExpiresAt: string | null;
	/** Last mapping failure in plain language. */
	error: string | null;
}

/** Mirror of the server's `NodeReachability`. */
export interface NodeReachability {
	nodeId: string;
	running: boolean;
	verdict: NodeVerdict;
	/** Plain-language reason and remedy when unreachable. */
	reason: string | null;
	tcp: PortRoute;
	/** Null for a node without a WebSocket port. */
	ws: PortRoute | null;
	publicAddrs: string[];
}

/** Mirror of the server's `ManualForwardPatch`: the external ports forwarded by hand; `null` clears one. */
export interface ManualForwardPatch {
	tcp?: number | null;
	ws?: number | null;
}

export interface NatStatusSnapshot {
	upnpEnabled: boolean;
	gateway: {
		found: boolean;
		/** This machine's address on the router's network — the one to forward to. */
		lanAddress: string | null;
		routerExternalIp: string | null;
		lastError: string | null;
	};
	externalIp: string | null;
	externalIpDetectedAt: string | null;
	cgnatDetected: boolean;
	directReachability: DirectReachability;
	lastTestedAt: string | null;
	nodes: NodeReachability[];
	ddns: {
		providerId: string | null;
		hostname: string | null;
		externallyManaged: boolean;
		lastUpdateAt: string | null;
		lastUpdateOk: boolean | null;
		lastError: string | null;
	};
}

/** Mirror of the server's `HostedNodeStatus` (`src/hosted/types.ts`). */
export type HostedNodeStatus = 'spawning' | 'unclaimed' | 'joining' | 'joined' | 'error';

/**
 * Mirror of the server's `HostedNodeView`, the fields the UI shows. The wire shape never
 * carries the claim secret or the invitation.
 */
export interface HostedNodeView {
	id: string;
	/** `claim`: started waiting for a phone to scan its code; `invitation`: started redeeming a pasted invitation. */
	join: { kind: 'claim' | 'invitation' };
	/** A claim node: the placeholder `unclaimed` until the claim names the party. An invitation node: its cadre from the start. */
	partyId: string;
	status: HostedNodeStatus;
	peerId?: string;
	/** Set when the node joins: the claimant's key, or the invitation's issuer. */
	ownerKey?: string;
	/** An invitation node, once joined: the member that admitted it. */
	memberPeerId?: string;
	/** The node holds at least one control connection. */
	connected?: boolean;
	error?: string;
	/** Set with `error` when an invitation failed: true when no member could be reached and Retry may help. */
	retryable?: boolean;
	createdAt: string;
	updatedAt: string;
}

/**
 * Mirror of the server's `ClaimDetails`. `payload` carries the claim secret, so
 * this lives in the state of the component showing the code, never in the
 * global slice and never in browser storage.
 */
export interface ClaimDetails {
	payload: string;
	peerId: string;
	multiaddrs: string[];
	reachability: NodeReachability | null;
}

export interface StatusResponse {
	service: { name: 'cadre-host'; version: string; uptimeSeconds: number };
	nodes: Array<{
		id: string;
		partyId: string;
		status: ContainerStatus;
		profile: 'storage' | 'transaction';
	}>;
	connectivity: NatStatusSnapshot;
	update?: { available?: string; lastChecked?: string };
}

export interface UpdateState {
	version: 1;
	lastChecked?: string;
	available?: {
		version: string;
		publishedAt: string;
		releaseNotesUrl?: string;
	};
	applyInProgress?: {
		fromVersion: string;
		toVersion: string;
		startedAt: string;
	};
	lastError?: { code: string; message: string; at: string };
}

export interface HostConfigFile {
	version: 3;
	installId: string;
	installedAt: string;
	installerVersion?: string;
	dataDir: string;
	uiPort: number;
	upnpEnabled: boolean;
	updates: {
		autoApply: boolean;
		manifestUrl?: string;
	};
	/** Which addresses claim codes carry; absent ⇒ automatic. */
	claimAddresses?: {
		/** 'auto', 'none' or an IP address. */
		lan?: string;
		/** Exact addresses instead of the automatic choice. */
		addrs?: string[];
	};
}

// --- Application state ---

export type OverallStatus = 'loading' | 'ok' | 'warn' | 'error';

export interface Toast {
	id: string;
	kind: 'info' | 'error' | 'success';
	text: string;
	expiresAt: number;
}

/**
 * The hosted-nodes slice. `loaded` and `error` exist because an unfetched list
 * is not an empty one: without them a failed fetch would read as "no nodes".
 */
interface HostedNodesState {
	list: HostedNodeView[];
	/** True once a fetch has succeeded at least once. */
	loaded: boolean;
	/** Message from the most recent failed fetch; cleared by the next success. */
	error: string | null;
}

interface AppState {
	status: OverallStatus;
	service: StatusResponse['service'] | null;
	nodes: NodeInfo[];
	nodeStats: Record<string, NodeStats | null>;
	hostedNodes: HostedNodesState;
	connectivity: NatStatusSnapshot | null;
	update: UpdateState | null;
	settings: HostConfigFile | null;
	toasts: Toast[];
}

const state = $state<AppState>({
	status: 'loading',
	service: null,
	nodes: [],
	nodeStats: {},
	hostedNodes: { list: [], loaded: false, error: null },
	connectivity: null,
	update: null,
	settings: null,
	toasts: [],
});

export function appState(): AppState {
	return state;
}

// --- Toast helpers ---

const TOAST_TTL_MS = 6_000;
let toastCounter = 0;

export function pushToast(kind: Toast['kind'], text: string): void {
	const id = `t${++toastCounter}`;
	const toast: Toast = { id, kind, text, expiresAt: Date.now() + TOAST_TTL_MS };
	state.toasts.push(toast);
	setTimeout(() => dismissToast(id), TOAST_TTL_MS);
}

export function dismissToast(id: string): void {
	state.toasts = state.toasts.filter((t) => t.id !== id);
}

export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		pushToast('success', 'Copied to clipboard');
	} catch (err) {
		pushToast('error', `Copy failed: ${(err as Error).message}`);
	}
}

export function reportError(scope: string, err: unknown): void {
	const code = err instanceof ApiError ? err.code : 'error';
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[cadre-host-ui] ${scope}:`, err);
	pushToast('error', `${scope}: ${msg} (${code})`);
}

// --- Overall status derivation ---

function recomputeStatus(): void {
	state.status = deriveOverallStatus(state.connectivity, state.nodes, state.update);
}

// --- Refresh helpers — called by pages on enter and after actions ---

export async function refreshStatus(): Promise<void> {
	try {
		const r = await apiFetch<StatusResponse>('/api/status');
		state.service = r.service;
		state.connectivity = r.connectivity;
		// status returns a thin per-node summary; the Nodes page hydrates the
		// full list separately. Keep what's already in state.nodes if it's
		// non-empty, otherwise project the summary.
		if (state.nodes.length === 0) {
			state.nodes = r.nodes.map((n) => ({
				id: n.id,
				dockerId: '',
				partyId: n.partyId,
				profile: n.profile,
				status: n.status,
				spawnedAt: '',
				workdir: '',
				ports: { health: 0, metrics: 0, p2p: 0, ws: 0 },
			}));
		}
		recomputeStatus();
	} catch (err) {
		reportError('status', err);
		state.status = 'error';
	}
}

export async function refreshNodes(): Promise<void> {
	try {
		const r = await apiFetch<{ nodes: NodeInfo[] }>('/api/nodes');
		state.nodes = r.nodes;
		recomputeStatus();
	} catch (err) {
		reportError('nodes', err);
	}
}

/**
 * One node's orchestrator handle and stats. A 404 is an answer, not a failure: a
 * hosted node with no child (a spawn that failed) or one removed meanwhile has no
 * handle, and its page renders from the hosted-node record alone.
 */
export async function refreshNodeDetail(id: string): Promise<{ node: NodeInfo; stats: NodeStats | null } | null> {
	try {
		const r = await apiFetch<{ node: NodeInfo; stats: NodeStats | null }>(`/api/nodes/${encodeURIComponent(id)}`);
		// Upsert: a node spawned after the last list fetch (e.g. one reached from a
		// link elsewhere) is not in the list yet, and the detail page renders from it.
		state.nodes = state.nodes.some((n) => n.id === id)
			? state.nodes.map((n) => (n.id === id ? r.node : n))
			: [...state.nodes, r.node];
		state.nodeStats = { ...state.nodeStats, [id]: r.stats };
		return r;
	} catch (err) {
		if (err instanceof ApiError && err.status === 404) {
			state.nodes = state.nodes.filter((n) => n.id !== id);
		} else {
			reportError(`node ${id}`, err);
		}
		return null;
	}
}

// Sequence numbers so an older list answer landing after a newer one is
// dropped: events, page mounts and mutations each start a fetch, and the Join
// page's state line must not step back to "waiting" after the claim.
let hostedNodesRequested = 0;
let hostedNodesApplied = 0;

export async function refreshHostedNodes(): Promise<void> {
	const seq = ++hostedNodesRequested;
	try {
		const r = await apiFetch<{ nodes: HostedNodeView[] }>('/api/hosted-nodes');
		if (seq < hostedNodesApplied) return;
		hostedNodesApplied = seq;
		state.hostedNodes = { list: r.nodes, loaded: true, error: null };
	} catch (err) {
		reportError('hosted nodes', err);
		if (seq < hostedNodesApplied) return;
		state.hostedNodes = { ...state.hostedNodes, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Re-read what a hosted-node change touches: the records, the orchestrator
 * handles, and the NAT snapshot, which gains or loses the node's reachability entry.
 */
function refreshAfterHostedChange(): Promise<unknown> {
	return Promise.all([refreshHostedNodes(), refreshNodes(), refreshConnectivity()]);
}

/**
 * "Join a cadre": start a node waiting to be claimed, or, given a pasted invitation, one
 * that redeems it. Resolves with the new record once the child is spawned (seconds);
 * errors reach the caller as `ApiError` (`invalid_request` for an invitation that does
 * not decode).
 */
export async function joinCadre(invitation?: string): Promise<HostedNodeView> {
	const r = await apiPost<{ node: HostedNodeView }>('/api/hosted-nodes', invitation === undefined ? undefined : { invitation });
	await refreshAfterHostedChange();
	return r.node;
}

/** Start an invitation node again after no member could be reached. Errors reach the caller as `ApiError`. */
export async function retryHostedNode(id: string): Promise<HostedNodeView> {
	const r = await apiPost<{ node: HostedNodeView }>(`/api/hosted-nodes/${encodeURIComponent(id)}/retry`);
	await refreshAfterHostedChange();
	return r.node;
}

/** Stop a hosted node and delete its data on this machine. Errors reach the caller as `ApiError`. */
export async function removeHostedNode(id: string): Promise<void> {
	await apiDelete(`/api/hosted-nodes/${encodeURIComponent(id)}`);
	await refreshAfterHostedChange();
}

/** Remove a hosted node and start a fresh one with a new code. Resolves with the fresh record, which has a new id. */
export async function resetHostedNode(id: string): Promise<HostedNodeView> {
	const r = await apiPost<{ node: HostedNodeView }>(`/api/hosted-nodes/${encodeURIComponent(id)}/reset`);
	await refreshAfterHostedChange();
	return r.node;
}

/**
 * The code for an unclaimed node. Throws `ApiError`: `node_unavailable` (503)
 * while the child is starting, which callers retry; `invalid_state` (409) once
 * the node is no longer waiting to be claimed.
 */
export function fetchClaimDetails(id: string): Promise<ClaimDetails> {
	return apiFetch<ClaimDetails>(`/api/hosted-nodes/${encodeURIComponent(id)}/claim`);
}

export async function refreshConnectivity(): Promise<void> {
	try {
		const r = await apiFetch<NatStatusSnapshot>('/nat/status');
		state.connectivity = r;
		recomputeStatus();
	} catch (err) {
		reportError('connectivity', err);
	}
}

/**
 * Store the external ports the user forwarded by hand for one node. The route
 * answers with the whole snapshot, which replaces the slice. Errors reach the
 * caller as `ApiError` (404 `unknown_node` for a node that is gone, 400
 * `invalid_config` for a bad port) so the form can say which.
 */
export async function saveForward(nodeId: string, patch: ManualForwardPatch): Promise<void> {
	state.connectivity = await apiPut<NatStatusSnapshot>(`/nat/nodes/${encodeURIComponent(nodeId)}/forward`, patch);
	recomputeStatus();
}

export async function refreshUpdate(): Promise<void> {
	try {
		const r = await apiFetch<UpdateState>('/update');
		state.update = r;
		recomputeStatus();
	} catch {
		// /update may be absent if UpdateService isn't wired (older host); silent.
		state.update = null;
	}
}

export async function refreshSettings(): Promise<void> {
	try {
		const r = await apiFetch<HostConfigFile>('/api/settings');
		state.settings = r;
	} catch (err) {
		reportError('settings', err);
	}
}

// --- Event dispatcher — wired in App.svelte to subscribeEvents() ---

export function applyEvent(event: { type: string; data: string }): void {
	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(event.data) as Record<string, unknown>;
	} catch {
		// Malformed payload — ignore (heartbeats don't go through this path).
		return;
	}
	switch (event.type) {
		case 'node-state-changed': {
			const nodeId = payload['nodeId'] as string | undefined;
			const status = payload['status'] as ContainerStatus | undefined;
			if (nodeId && status) {
				state.nodes = state.nodes.map((n) =>
					n.id === nodeId ? { ...n, status } : n,
				);
				recomputeStatus();
			}
			// A respawn drops the record's `connected` until the watcher reads the new child.
			void refreshHostedNodes();
			break;
		}
		case 'connectivity-changed':
			void refreshConnectivity();
			break;
		// A join adds an orchestrator handle and a NAT entry and a removal drops them, so
		// all three are re-read. The event's id is not looked up: a `removed` for an id
		// the slice never held (a handle no record named) is just another refresh.
		case 'hosted-nodes-changed':
			void refreshAfterHostedChange();
			break;
		case 'update-available': {
			const version = payload['version'] as string | undefined;
			const releaseNotesUrl = payload['releaseNotesUrl'] as string | undefined;
			if (version) {
				state.update = {
					...(state.update ?? { version: 1 }),
					available: {
						version,
						// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient Date, immediately serialized to a string and discarded; never held or mutated in reactive state.
						publishedAt: state.update?.available?.publishedAt ?? new Date().toISOString(),
						...(releaseNotesUrl ? { releaseNotesUrl } : {}),
					},
				};
				recomputeStatus();
			}
			break;
		}
		default:
			// Unknown event type — ignore.
			break;
	}
}
