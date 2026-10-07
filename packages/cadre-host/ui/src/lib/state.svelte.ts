/**
 * Single source of truth for the SPA. Pages read from `appState()` and
 * write back via the wired refresh helpers below. The EventSource client
 * (subscribeEvents) calls `applyEvent` to invalidate the relevant slice.
 *
 * One global $state object beats a store library at this scale; mutations
 * are co-located with the API calls that triggered them.
 */

import { apiFetch, ApiError } from './api.js';
import { deriveOverallStatus } from './overall-status.js';

// --- Mirrors of server-side types (kept narrow on purpose) ---

export type ContainerStatus = 'running' | 'stopped';

/** Mirror of the server's `HostRole`: whether this host also runs its own cadre. */
export type HostRole = 'founder' | 'donor';

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
	/** True only on the host's own owner node; every other node is a donated one. */
	owner?: boolean;
}

/** Mirror of cadre-provider's `OrchestratorStats`, the fields the UI shows. */
export interface NodeStats {
	cpuPercent: number;
	/** Resident memory of the node process. */
	memoryBytes: number;
}

/**
 * Mirror of the server's `StrandSummary` (`src/strands/types.ts`). `status` is a
 * raw string the manager only forwards — the UI displays it, never branches on it.
 */
export interface StrandSummary {
	id: string;
	/** `'o'` = open, `'c'` = closed (the row carries this party's membership key). */
	type: 'o' | 'c';
	running: boolean;
	status: string | null;
}

/** Mirror of the server's `StrandRemovalResult`. */
export interface StrandRemovalResult {
	strandId: string;
	published: boolean;
	type: 'o' | 'c' | null;
	removed: boolean;
	alone: boolean;
}

/** Mirror of the server's `DonationStatus` (`src/donation/types.ts`). */
export type DonationStatus = 'provisioning' | 'awaiting_seed' | 'seeded' | 'error' | 'terminated';

/**
 * Mirror of the server's `GrantListing`. `token` is the grant's secret and the
 * key for revoking it; the page keeps it off screen until asked.
 */
export interface GrantListing {
	token: string;
	label: string;
	maxNodes: number;
	createdAt: string;
	expiresAt?: string;
	revokedAt?: string;
	/** Donations counting against `maxNodes`. */
	liveNodes: number;
	/** Every donation under the grant not yet terminated — what a revoke would end. */
	donations: Array<{ id: string; status: DonationStatus }>;
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

export interface StatusResponse {
	service: { name: 'cadre-host'; version: string; uptimeSeconds: number };
	role: HostRole;
	nodes: Array<{
		id: string;
		partyId: string;
		status: ContainerStatus;
		profile: 'storage' | 'transaction';
		owner?: true;
	}>;
	/** Present in every role: every hosted node, donated ones included, is mapped. */
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

/**
 * The strands slice. `loaded` and `error` exist because an unfetched list is not
 * an empty one: without them the page would greet a failed fetch with "this party
 * doesn't take part in any shared networks", which is a different claim entirely.
 */
interface StrandsState {
	list: StrandSummary[];
	/**
	 * Open control-network connections the owner node saw at read time. Advisory —
	 * a snapshot, not a subscription, and possibly stale by the time of a click.
	 */
	controlConnections: number;
	/** True once a fetch has succeeded at least once. */
	loaded: boolean;
	/** Message from the most recent failed fetch; cleared by the next success. */
	error: string | null;
}

/** The grants slice. Same `loaded`/`error` reasoning as {@link StrandsState}. */
interface GrantsState {
	list: GrantListing[];
	/** True once a fetch has succeeded at least once. */
	loaded: boolean;
	/** Message from the most recent failed fetch; cleared by the next success. */
	error: string | null;
}

interface AppState {
	status: OverallStatus;
	service: StatusResponse['service'] | null;
	/** Null until the first successful `/api/status`. */
	role: HostRole | null;
	nodes: NodeInfo[];
	nodeStats: Record<string, NodeStats | null>;
	strands: StrandsState;
	grants: GrantsState;
	connectivity: NatStatusSnapshot | null;
	update: UpdateState | null;
	settings: HostConfigFile | null;
	toasts: Toast[];
}

const state = $state<AppState>({
	status: 'loading',
	service: null,
	role: null,
	nodes: [],
	nodeStats: {},
	strands: { list: [], controlConnections: 0, loaded: false, error: null },
	grants: { list: [], loaded: false, error: null },
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

function recomputeStatus(): void {
	state.status = deriveOverallStatus(state.role, state.connectivity, state.nodes, state.update);
}

// --- Refresh helpers — called by pages on enter and after actions ---

export async function refreshStatus(): Promise<void> {
	try {
		const r = await apiFetch<StatusResponse>('/api/status');
		state.service = r.service;
		// NOTE: an open tab learns a role change (config edited, host restarted) only on
		// the next status fetch, and a founder→donor flip leaves the founder slices in
		// state. Fine while `ownCadre` is install-time only; if the role ever becomes
		// switchable at runtime, re-fetch status on SSE reconnect and clear those slices.
		state.role = r.role;
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
				...(n.owner ? { owner: true } : {}),
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
		// Upsert: a node spawned after the last list fetch (e.g. one reached from a
		// Grants page link) is not in the list yet, and the detail page renders from it.
		state.nodes = state.nodes.some((n) => n.id === id)
			? state.nodes.map((n) => (n.id === id ? r.node : n))
			: [...state.nodes, r.node];
		state.nodeStats = { ...state.nodeStats, [id]: r.stats };
		return r;
	} catch (err) {
		reportError(`node ${id}`, err);
		return null;
	}
}

/**
 * Fetch this party's strands.
 *
 * Called from the Strands page's own `onMount` and from the `strands-changed`
 * event — deliberately NOT from App.svelte's global mount: `/api/strands` is
 * mounted only in founder mode, so a boot-time call would put an error toast on
 * every donor-only dashboard before the user has opened anything.
 */
export async function refreshStrands(): Promise<void> {
	// NOTE: overlapping refreshes are last-response-wins, so a slow earlier fetch
	// could land after a newer one and briefly re-show a removed row. Today the only
	// overlap is a removal's own refresh racing its SSE echo, and both are
	// post-delete; if these calls ever get slow, sequence them behind a token.
	try {
		const r = await apiFetch<{ strands: StrandSummary[]; controlConnections: number }>(
			'/api/strands',
		);
		state.strands = {
			list: r.strands,
			controlConnections: r.controlConnections,
			loaded: true,
			error: null,
		};
	} catch (err) {
		reportError('strands', err);
		state.strands = {
			...state.strands,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Fetch the grant list. Called from the Grants page's own `onMount` and from the
 * events below, not at boot — nothing needs it before the page is opened.
 */
export async function refreshGrants(): Promise<void> {
	// NOTE: overlapping refreshes are last-response-wins, as with strands. Every
	// overlap today is post-mutation (an action's own refresh racing its SSE echo),
	// so the result converges; if these calls ever get slow, sequence them.
	try {
		const r = await apiFetch<{ grants: GrantListing[] }>('/grants-admin');
		state.grants = { list: r.grants, loaded: true, error: null };
	} catch (err) {
		reportError('grants', err);
		state.grants = {
			...state.grants,
			error: err instanceof Error ? err.message : String(err),
		};
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
			// Donations change through the grantee's own `/grants` calls and the
			// respawn supervisor too, neither of which publishes `grants-changed`; each
			// writes its record before spawning and after marking it terminated, so the
			// node's state change is late enough to re-read the counts.
			// NOTE: the supervisor's give-up writes `error` after the crash event has
			// already fired, so an open Grants page counts that node live until the next
			// refresh; if that shows, have the supervisor publish `grants-changed`.
			if (state.grants.loaded) void refreshGrants();
			break;
		}
		case 'grants-changed':
			void refreshGrants();
			// A revoke or terminate removes nodes from the orchestrator, but their last
			// `node-state-changed` left them listed as stopped, which reads as unhealthy.
			if (payload['kind'] !== 'issued') void refreshNodes();
			break;
		case 'strands-changed':
			// NOTE: the tab that issued the removal refreshes twice — once explicitly (so
			// its feedback never depends on the SSE round-trip) and once from this echo.
			// Harmless while a party's strand list is small; if lists ever grow big enough
			// for the second fetch to show, tag locally-issued removals and skip their echo.
			void refreshStrands();
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
