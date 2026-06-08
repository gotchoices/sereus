/**
 * Single source of truth for the SPA. Pages read from `appState()` and
 * write back via the wired refresh helpers below. The EventSource client
 * (subscribeEvents) calls `applyEvent` to invalidate the relevant slice.
 *
 * One global $state object beats a store library at this scale; mutations
 * are co-located with the API calls that triggered them.
 */

import { apiFetch, ApiError } from './api.js';

// --- Mirrors of server-side types (kept narrow on purpose) ---

export type ContainerStatus = 'running' | 'stopped';

export type PortForwardMode =
	| 'auto-upnp'
	| 'auto-natpmp'
	| 'manual'
	| 'failed'
	| 'disabled';
export type DirectReachability = 'reachable' | 'unreachable' | 'unknown' | 'cgnat';

export interface NodeInfo {
	id: string;
	dockerId: string;
	partyId: string;
	profile: 'storage' | 'transaction';
	status: ContainerStatus;
	spawnedAt: string;
	workdir: string;
	ports: { health: number; metrics: number; p2p: number };
}

export interface NodeStats {
	cpu: number;
	rssBytes: number;
}

export interface TrustCircleMember {
	peerId: string;
	label: string;
	addedAt: string;
	self?: boolean;
}

export interface PendingInvite {
	token: string;
	label: string;
	createdAt: string;
	expiresAt?: string;
}

export interface NatStatusSnapshot {
	portMode: PortForwardMode;
	externalPort: number;
	internalPort: number;
	routerExternalIp: string | null;
	mappingLeaseExpiresAt: string | null;
	externalIp: string | null;
	externalIpDetectedAt: string | null;
	cgnatDetected: boolean;
	directReachability: DirectReachability;
	lastTestedAt: string | null;
	ddns: {
		providerId: string | null;
		hostname: string | null;
		externallyManaged: boolean;
		lastUpdateAt: string | null;
		lastUpdateOk: boolean | null;
		lastError: string | null;
	};
}

export interface StatusResponse {
	service: { name: 'cadre-host'; version: string; uptimeSeconds: number };
	nodes: Array<{
		id: string;
		partyId: string;
		status: ContainerStatus;
		profile: 'storage' | 'transaction';
	}>;
	trustCircle: { members: number; pending: number };
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
	version: 1;
	installId: string;
	installedAt: string;
	installerVersion?: string;
	dataDir: string;
	identityPath: string;
	uiPort: number;
	libp2pPort: number;
	upnpEnabled: boolean;
	updates: {
		autoApply: boolean;
		manifestUrl?: string;
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

interface AppState {
	status: OverallStatus;
	service: StatusResponse['service'] | null;
	nodes: NodeInfo[];
	nodeStats: Record<string, NodeStats | null>;
	trustCircle: { members: TrustCircleMember[]; pending: PendingInvite[] };
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
	trustCircle: { members: [], pending: [] },
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

export function reportError(scope: string, err: unknown): void {
	const code = err instanceof ApiError ? err.code : 'error';
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[cadre-host-ui] ${scope}:`, err);
	pushToast('error', `${scope}: ${msg} (${code})`);
}

// --- Overall status derivation ---

function deriveOverallStatus(
	connectivity: NatStatusSnapshot | null,
	nodes: NodeInfo[],
	update: UpdateState | null,
): OverallStatus {
	if (!connectivity) return 'loading';
	const reachability = connectivity.directReachability;
	const anyStopped = nodes.some((n) => n.status !== 'running');
	if (reachability === 'unreachable' || reachability === 'cgnat') return 'warn';
	if (anyStopped) return 'warn';
	if (update?.lastError) return 'warn';
	return 'ok';
}

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
				ports: { health: 0, metrics: 0, p2p: 0 },
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

export async function refreshNodeDetail(id: string): Promise<{ node: NodeInfo; stats: NodeStats | null } | null> {
	try {
		const r = await apiFetch<{ node: NodeInfo; stats: NodeStats | null }>(`/api/nodes/${encodeURIComponent(id)}`);
		state.nodes = state.nodes.map((n) => (n.id === id ? r.node : n));
		state.nodeStats = { ...state.nodeStats, [id]: r.stats };
		return r;
	} catch (err) {
		reportError(`node ${id}`, err);
		return null;
	}
}

export async function refreshTrustCircle(): Promise<void> {
	try {
		const r = await apiFetch<{ members: TrustCircleMember[]; pending: PendingInvite[] }>(
			'/auth/trust-circle',
		);
		state.trustCircle = r;
	} catch (err) {
		reportError('trust-circle', err);
	}
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
			break;
		}
		case 'trust-circle-changed':
			void refreshTrustCircle();
			break;
		case 'connectivity-changed':
			void refreshConnectivity();
			break;
		case 'update-available': {
			const version = payload['version'] as string | undefined;
			const releaseNotesUrl = payload['releaseNotesUrl'] as string | undefined;
			if (version) {
				state.update = {
					...(state.update ?? { version: 1 }),
					available: {
						version,
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

// --- Test-only seam ---

export const __test__ = { deriveOverallStatus, recomputeStatus, state };
