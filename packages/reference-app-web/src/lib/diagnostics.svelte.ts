/**
 * Diagnostics store for the `/diag` route.
 *
 * Collects cheap, read-only signals from the running libp2p node, the
 * IndexedDB backend, the browser's storage estimate, and a global error
 * ring buffer. The intent is a developer-facing evidence surface: every
 * value here is something a maintainer would want to inspect when
 * "Optimystic doesn't work in a browser" lands as a bug report.
 *
 * Polling cadence is 2 seconds while the route is visible
 * (`document.visibilityState === 'visible'`). The tick performs only
 * cheap probes — no network round-trips, no streaming reads. Anything
 * network-going belongs on a manual refresh button on the page.
 */

import {
	getControlNode,
	getControlDbHandle,
	getControlStorage,
	getIdentityFirstSeenMs,
	getPartyId,
	getCadreNode,
	getChatStrand,
	getChatStrandId,
	getOwnerState,
	getRelayState,
	readControlAuthorizationState,
	attemptUnauthorizedStrandWrite,
	type RelayState,
	type FormationInviteRow,
	type FormationUsageRow,
	type ControlStrandRow,
	type OwnerGateProbe,
} from './cadre-web.js';
import type { Libp2p, Connection } from '@libp2p/interface';
import { IndexedDBRawStorage } from '@optimystic/db-p2p-storage-web';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
	summarizeConnectionPaths,
	emptyConnectionPathSummary,
	type ConnectionPathSummary,
	type ConnectionPathKind,
	type ConnectionTransport,
} from './connection-path.js';

const ERROR_BUFFER_LIMIT = 10;
const POLL_INTERVAL_MS = 2_000;

export interface IdentityInfo {
	peerId: string | null;
	peerIdShort: string | null;
	persisted: boolean;
	firstSeenMs: number | null;
	ageMs: number | null;
}

export interface ConnectivityInfo {
	status: string | null;
	listenAddrs: string[];
	connections: Array<{
		peerId: string;
		peerIdShort: string;
		remoteAddr: string;
		direction: 'inbound' | 'outbound' | string;
		protocols: string[];
		kind: ConnectionPathKind;
		transport: ConnectionTransport;
		stuckOnRelay: boolean;
	}>;
	/** Relayed-vs-direct path summary (counts, per-transport, stuck-on-relay). */
	paths: ConnectionPathSummary;
}

export interface TransportsInfo {
	names: string[];
}

export interface FretInfo {
	available: boolean;
	knownPeerCount: number;
	networkSize: { estimate: number; confidence: number; sources: number } | null;
	churn: number | null;
	partition: boolean | null;
	lastTickMs: number | null;
	myArachnode: {
		ringDepth: number;
		status: string;
		capacityTotal: number;
		capacityUsed: number;
		capacityAvailable: number;
	} | null;
	knownRings: number[];
}

export interface StorageInfo {
	backend: string | null;
	quotaBytes: number | null;
	usageBytes: number | null;
	approxRawBytes: number | null;
	storeCounts: Record<string, number> | null;
	storesError: string | null;
}

export interface CadreStrandInfo {
	id: string | null;
	status: string | null;
	connectedPeers: number | null;
	latencyHint: string | null;
	sAppId: string | null;
	error: string | null;
}

export interface CadreInfo {
	partyId: string | null;
	controlConnected: boolean;
	controlPeerId: string | null;
	controlPeerIdShort: string | null;
	cadrePeerCount: number | null;
	cadrePeerError: string | null;
	owner: string;
	ownerError: string | null;
	strand: CadreStrandInfo | null;
}

/**
 * Control-network authorization ("RBAC") surface: the gates the `CadreControl`
 * schema enforces, made observable. Owner/validation key counts, the
 * formation invite/usage audit rows, per-strand membership type + member-key
 * presence, the relay-dialability posture, and the result of a manual
 * owner-gate probe (an unauthorized write that *should* be rejected).
 */
export interface AuthorizationInfo {
	available: boolean;
	error: string | null;
	ownerKeyCount: number;
	validationKeyCount: number;
	formationInvites: FormationInviteRow[];
	formationUsage: FormationUsageRow[];
	strands: ControlStrandRow[];
	relay: RelayState;
	/** Result of the last manual "verify owner gate" probe (null until run). */
	gateProbe: OwnerGateProbe | null;
}

export interface CryptoSanityInfo {
	cryptoSubtle: boolean;
	cryptoGetRandomValues: boolean;
	eventTarget: boolean;
	promiseWithResolvers: boolean;
	structuredClone: boolean;
	readableStream: boolean;
	bufferGlobal: boolean;
}

export interface ErrorEntry {
	ts: number;
	source: string;
	message: string;
}

export interface DiagSnapshot {
	updatedMs: number | null;
	cadre: CadreInfo;
	authorization: AuthorizationInfo;
	identity: IdentityInfo;
	connectivity: ConnectivityInfo;
	transports: TransportsInfo;
	fret: FretInfo;
	storage: StorageInfo;
	crypto: CryptoSanityInfo;
	errors: ErrorEntry[];
}

function emptyCadre(): CadreInfo {
	return {
		partyId: null,
		controlConnected: false,
		controlPeerId: null,
		controlPeerIdShort: null,
		cadrePeerCount: null,
		cadrePeerError: null,
		owner: 'pending',
		ownerError: null,
		strand: null,
	};
}

function emptyAuthorization(): AuthorizationInfo {
	return {
		available: false,
		error: null,
		ownerKeyCount: 0,
		validationKeyCount: 0,
		formationInvites: [],
		formationUsage: [],
		strands: [],
		relay: { status: 'none', addrs: [], circuitAddrs: [], error: null },
		gateProbe: null,
	};
}

function emptySnapshot(): DiagSnapshot {
	return {
		updatedMs: null,
		cadre: emptyCadre(),
		authorization: emptyAuthorization(),
		identity: {
			peerId: null,
			peerIdShort: null,
			persisted: false,
			firstSeenMs: null,
			ageMs: null,
		},
		connectivity: {
			status: null,
			listenAddrs: [],
			connections: [],
			paths: emptyConnectionPathSummary(),
		},
		transports: { names: [] },
		fret: {
			available: false,
			knownPeerCount: 0,
			networkSize: null,
			churn: null,
			partition: null,
			lastTickMs: null,
			myArachnode: null,
			knownRings: [],
		},
		storage: {
			backend: null,
			quotaBytes: null,
			usageBytes: null,
			approxRawBytes: null,
			storeCounts: null,
			storesError: null,
		},
		crypto: detectCryptoSanity(),
		errors: [],
	};
}

const snapshot = $state<DiagSnapshot>(emptySnapshot());

let tickHandle: ReturnType<typeof setInterval> | null = null;
let visibilityListener: (() => void) | null = null;
let errorListener: ((evt: ErrorEvent) => void) | null = null;
let rejectionListener: ((evt: PromiseRejectionEvent) => void) | null = null;
let attachedNode: Libp2p | null = null;
let nodeListenerOff: (() => void) | null = null;
let refreshInFlight = false;

export function diagnosticsState(): DiagSnapshot {
	return snapshot;
}

export function pushError(source: string, err: unknown): void {
	const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
	const entry: ErrorEntry = { ts: Date.now(), source, message };
	const next = [entry, ...snapshot.errors];
	if (next.length > ERROR_BUFFER_LIMIT) next.length = ERROR_BUFFER_LIMIT;
	snapshot.errors = next;
}

export function clearErrors(): void {
	snapshot.errors = [];
}

export async function refreshDiagnostics(): Promise<void> {
	if (refreshInFlight) return;
	refreshInFlight = true;
	try {
		const node = getControlNode();
		snapshot.cadre = await collectCadre();
		snapshot.authorization = await collectAuthorization();
		snapshot.identity = collectIdentity(node);
		snapshot.connectivity = collectConnectivity(node);
		snapshot.transports = collectTransports(node);
		snapshot.fret = collectFret(node);
		snapshot.storage = await collectStorage();
		// crypto sanity is stable for the lifetime of the page — refresh once on
		// first tick rather than per-tick.
		snapshot.updatedMs = Date.now();
		attachNodeListenersIfNeeded(node);
	} catch (err) {
		pushError('diagnostics.refresh', err);
	} finally {
		refreshInFlight = false;
	}
}

export function startDiagnostics(): void {
	if (tickHandle) return;

	// Hook global error/rejection streams so we have an evidence trail even
	// when a stack frame doesn't run through our explicit try/catch sites.
	errorListener = (evt) => pushError('window.error', evt.error ?? evt.message);
	rejectionListener = (evt) =>
		pushError('unhandledrejection', evt.reason ?? '(no reason)');
	window.addEventListener('error', errorListener);
	window.addEventListener('unhandledrejection', rejectionListener);

	// Visibility-gated tick: pause polling when the tab is hidden so we don't
	// burn cycles on an off-screen surface.
	const startTicking = () => {
		if (tickHandle) return;
		void refreshDiagnostics();
		tickHandle = setInterval(() => {
			void refreshDiagnostics();
		}, POLL_INTERVAL_MS);
	};
	const stopTicking = () => {
		if (!tickHandle) return;
		clearInterval(tickHandle);
		tickHandle = null;
	};

	visibilityListener = () => {
		if (document.visibilityState === 'visible') startTicking();
		else stopTicking();
	};
	document.addEventListener('visibilitychange', visibilityListener);

	if (document.visibilityState === 'visible') {
		startTicking();
	}
}

export function stopDiagnostics(): void {
	if (tickHandle) {
		clearInterval(tickHandle);
		tickHandle = null;
	}
	if (visibilityListener) {
		document.removeEventListener('visibilitychange', visibilityListener);
		visibilityListener = null;
	}
	if (errorListener) {
		window.removeEventListener('error', errorListener);
		errorListener = null;
	}
	if (rejectionListener) {
		window.removeEventListener('unhandledrejection', rejectionListener);
		rejectionListener = null;
	}
	if (nodeListenerOff) {
		nodeListenerOff();
		nodeListenerOff = null;
	}
	attachedNode = null;
}

function detectCryptoSanity(): CryptoSanityInfo {
	const hasGlobal = typeof globalThis !== 'undefined';
	const cryptoRef = (
		globalThis as { crypto?: { subtle?: unknown; getRandomValues?: unknown } }
	).crypto;
	return {
		cryptoSubtle: hasGlobal && typeof cryptoRef?.subtle === 'object',
		cryptoGetRandomValues:
			hasGlobal && typeof cryptoRef?.getRandomValues === 'function',
		eventTarget: hasGlobal && typeof EventTarget !== 'undefined',
		promiseWithResolvers:
			hasGlobal &&
			typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers ===
				'function',
		structuredClone: hasGlobal && typeof structuredClone === 'function',
		readableStream: hasGlobal && typeof ReadableStream !== 'undefined',
		bufferGlobal:
			hasGlobal &&
			typeof (globalThis as { Buffer?: unknown }).Buffer === 'function',
	};
}

/**
 * Cadre-level state: party id, control connection + peer id, CadrePeer
 * membership count, owner self-genesis outcome, and the chat strand's
 * status / peers / latency / error. The CadrePeer count is a best-effort
 * control-DB read (local on a solo node) guarded so a transactor hiccup never
 * sinks the tick.
 */
async function collectCadre(): Promise<CadreInfo> {
	const node = getCadreNode();
	const control = getControlNode();
	const strandId = getChatStrandId();
	const strand = getChatStrand();
	const auth = getOwnerState();

	let cadrePeerCount: number | null = null;
	let cadrePeerError: string | null = null;
	if (node?.isRunning) {
		try {
			const peers = await node.getControlDatabase()?.queryCadrePeers();
			cadrePeerCount = peers ? peers.length : null;
		} catch (err) {
			cadrePeerError = err instanceof Error ? err.message : String(err);
		}
	}

	const controlPeerId = control?.peerId.toString() ?? null;
	return {
		partyId: getPartyId(),
		controlConnected: !!node?.isRunning,
		controlPeerId,
		controlPeerIdShort: shortPeerId(controlPeerId),
		cadrePeerCount,
		cadrePeerError,
		owner: auth.state,
		ownerError: auth.error,
		strand: strandId
			? {
					id: strandId,
					status: strand?.status ?? null,
					connectedPeers: strand?.connectedPeers ?? null,
					latencyHint: strand?.latencyHint ?? null,
					sAppId: strand?.sAppInfo?.id ?? null,
					error: strand?.error ?? null,
				}
			: null,
	};
}

// Manual owner-gate probe result persists across polls (it is button-driven,
// not part of the cheap per-tick read).
let lastGateProbe: OwnerGateProbe | null = null;

/**
 * Control-network authorization ("RBAC") state. Cheap read-only SQL over the
 * control database's Quereus handle (no network), guarded so a transactor hiccup
 * surfaces as `error` rather than sinking the whole tick. Carries the relay
 * posture and the most recent manual owner-gate probe result.
 */
async function collectAuthorization(): Promise<AuthorizationInfo> {
	const node = getCadreNode();
	const relay = getRelayState();
	if (!node?.isRunning) {
		return { ...emptyAuthorization(), relay, gateProbe: lastGateProbe };
	}
	try {
		const state = await readControlAuthorizationState();
		return { available: true, error: null, ...state, relay, gateProbe: lastGateProbe };
	} catch (err) {
		return {
			...emptyAuthorization(),
			error: err instanceof Error ? err.message : String(err),
			relay,
			gateProbe: lastGateProbe,
		};
	}
}

/**
 * Run the owner-gate demonstration: attempt an unauthorized control write
 * and record whether the `CadreControl` constraints rejected it. The result is
 * stashed so it survives the next poll, and pushed to the snapshot immediately.
 */
export async function runOwnerGateProbe(): Promise<void> {
	try {
		lastGateProbe = await attemptUnauthorizedStrandWrite();
	} catch (err) {
		// An unexpected throw (node not started, control db missing) is itself a
		// failed probe — record it rather than letting it escape to the UI handler.
		lastGateProbe = { rejected: false, error: err instanceof Error ? err.message : String(err) };
		pushError('ownerGateProbe', err);
	}
	snapshot.authorization = { ...snapshot.authorization, gateProbe: lastGateProbe };
}

function shortPeerId(id: string | null): string | null {
	if (!id) return null;
	if (id.length <= 14) return id;
	return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function collectIdentity(node: Libp2p | null): IdentityInfo {
	if (!node) {
		return {
			peerId: null,
			peerIdShort: null,
			persisted: false,
			firstSeenMs: null,
			ageMs: null,
		};
	}
	const peerId = node.peerId.toString();
	const firstSeen = getIdentityFirstSeenMs();
	return {
		peerId,
		peerIdShort: shortPeerId(peerId),
		persisted: true,
		firstSeenMs: firstSeen,
		ageMs: firstSeen != null ? Math.max(0, Date.now() - firstSeen) : null,
	};
}

function collectConnectivity(node: Libp2p | null): ConnectivityInfo {
	if (!node) {
		return {
			status: null,
			listenAddrs: [],
			connections: [],
			paths: emptyConnectionPathSummary(),
		};
	}
	const status = typeof node.status === 'string' ? node.status : 'unknown';
	const listenAddrs = (node.getMultiaddrs?.() ?? []).map((ma) => ma.toString());
	const conns = node.getConnections?.() ?? [];
	// Classify all connections in one pass — `paths[i]` lines up with `conns[i]`,
	// so we can zip the per-connection path facts back onto the table rows.
	const paths = summarizeConnectionPaths(conns);
	const connections = conns.map((c: Connection, i: number) => {
		const peerId = c.remotePeer.toString();
		const remoteAddr = c.remoteAddr?.toString?.() ?? '';
		const protocols = streamProtocols(c);
		const path = paths.paths[i];
		return {
			peerId,
			peerIdShort: shortPeerId(peerId) ?? peerId,
			remoteAddr,
			direction: c.direction ?? 'unknown',
			protocols,
			kind: path?.kind ?? 'direct',
			transport: path?.transport ?? 'unknown',
			stuckOnRelay: path?.stuckOnRelay ?? false,
		};
	});
	return { status, listenAddrs, connections, paths };
}

function streamProtocols(connection: Connection): string[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local dedup set, converted to a sorted array and discarded; never held in reactive $state.
	const seen = new Set<string>();
	const streams = (connection as unknown as { streams?: Array<{ protocol?: string }> }).streams ?? [];
	for (const stream of streams) {
		if (stream.protocol) seen.add(stream.protocol);
	}
	return Array.from(seen).sort();
}

function collectTransports(node: Libp2p | null): TransportsInfo {
	if (!node) return { names: [] };
	const transportManager = (
		node as unknown as {
			components?: { transportManager?: { getTransports?: () => unknown[] } };
		}
	).components?.transportManager;
	const transports = transportManager?.getTransports?.() ?? [];
	const names = transports
		.map((t) => {
			const tag = (t as { [Symbol.toStringTag]?: string })[Symbol.toStringTag];
			if (typeof tag === 'string' && tag.length > 0) return tag;
			const ctor = (t as { constructor?: { name?: string } }).constructor?.name;
			return ctor ?? 'unknown';
		})
		.sort();
	return { names };
}

interface FretLikeService {
	listPeers?: () => Array<{ id: string; metadata?: Record<string, unknown> }>;
	getNetworkSizeEstimate?: () => {
		size_estimate: number;
		confidence: number;
		sources: number;
	};
	getNetworkChurn?: () => number;
	detectPartition?: () => boolean;
}

function collectFret(node: Libp2p | null): FretInfo {
	const fret = (node as unknown as { services?: { fret?: FretLikeService } })?.services
		?.fret;
	if (!fret) {
		return {
			available: false,
			knownPeerCount: 0,
			networkSize: null,
			churn: null,
			partition: null,
			lastTickMs: null,
			myArachnode: null,
			knownRings: [],
		};
	}

	const peers = safeCall(() => fret.listPeers?.() ?? []) ?? [];
	const knownPeerCount = peers.length;
	const rawSize = safeCall(() => fret.getNetworkSizeEstimate?.());
	const networkSize = rawSize
		? {
				estimate: rawSize.size_estimate,
				confidence: rawSize.confidence,
				sources: rawSize.sources,
			}
		: null;
	const churn = safeCall(() => fret.getNetworkChurn?.()) ?? null;
	const partition = safeCall(() => fret.detectPartition?.()) ?? null;

	const myPeerId = node?.peerId.toString();
	const myArachnode = myPeerId
		? extractArachnode(peers.find((p) => p.id === myPeerId))
		: null;

	const knownRings = collectKnownRings(peers);

	return {
		available: true,
		knownPeerCount,
		networkSize,
		churn,
		partition,
		lastTickMs: Date.now(),
		myArachnode,
		knownRings,
	};
}

interface ArachnodeShape {
	ringDepth?: number;
	status?: string;
	capacity?: { total?: number; used?: number; available?: number };
}

function extractArachnode(
	peer: { metadata?: Record<string, unknown> } | undefined,
): FretInfo['myArachnode'] {
	const info = peer?.metadata?.['arachnode'] as ArachnodeShape | undefined;
	if (!info || typeof info.ringDepth !== 'number') return null;
	return {
		ringDepth: info.ringDepth,
		status: info.status ?? 'unknown',
		capacityTotal: info.capacity?.total ?? 0,
		capacityUsed: info.capacity?.used ?? 0,
		capacityAvailable: info.capacity?.available ?? 0,
	};
}

function collectKnownRings(
	peers: Array<{ metadata?: Record<string, unknown> }>,
): number[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local dedup set, converted to a sorted array and discarded; never held in reactive $state.
	const rings = new Set<number>();
	for (const peer of peers) {
		const info = peer.metadata?.['arachnode'] as ArachnodeShape | undefined;
		if (typeof info?.ringDepth === 'number') rings.add(info.ringDepth);
	}
	return Array.from(rings).sort((a, b) => a - b);
}

const OBJECT_STORE_NAMES = [
	'metadata',
	'revisions',
	'pending',
	'transactions',
	'materialized',
	'kv',
] as const;

// Stable, minification-safe labels for IRawStorage implementations. Falling
// back to `constructor.name` would break in production, where Vite mangles
// class identifiers.
function storageBackendLabel(storage: IRawStorage | null): string | null {
	if (!storage) return null;
	if (storage instanceof IndexedDBRawStorage) return 'IndexedDBRawStorage';
	return 'unknown';
}

async function collectStorage(): Promise<StorageInfo> {
	const storage = getControlStorage();
	const db = getControlDbHandle();

	const backend = storageBackendLabel(storage);

	let quotaBytes: number | null = null;
	let usageBytes: number | null = null;
	const estimateApi = (
		navigator as Navigator & {
			storage?: { estimate?: () => Promise<StorageEstimate> };
		}
	).storage?.estimate;
	if (estimateApi) {
		try {
			const est = await estimateApi.call(navigator.storage);
			quotaBytes = est.quota ?? null;
			usageBytes = est.usage ?? null;
		} catch (err) {
			pushError('navigator.storage.estimate', err);
		}
	}

	let approxRawBytes: number | null = null;
	if (storage?.getApproximateBytesUsed) {
		try {
			approxRawBytes = await storage.getApproximateBytesUsed();
		} catch (err) {
			pushError('IRawStorage.getApproximateBytesUsed', err);
		}
	}

	let storeCounts: Record<string, number> | null = null;
	let storesError: string | null = null;
	if (db) {
		try {
			const counts: Record<string, number> = {};
			for (const name of OBJECT_STORE_NAMES) {
				counts[name] = await db.count(name);
			}
			storeCounts = counts;
		} catch (err) {
			storesError = err instanceof Error ? err.message : String(err);
		}
	}

	return {
		backend,
		quotaBytes,
		usageBytes,
		approxRawBytes,
		storeCounts,
		storesError,
	};
}

function safeCall<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch (err) {
		void err;
		return null;
	}
}

function attachNodeListenersIfNeeded(node: Libp2p | null): void {
	if (!node || attachedNode === node) return;
	// Tear down previous bindings before attaching to the new node.
	if (nodeListenerOff) {
		nodeListenerOff();
		nodeListenerOff = null;
	}

	// libp2p's node-level `connection:close` event detail is the `Connection`
	// itself and carries no error. The error (if any) lives on the
	// `Connection`'s own `close` event as `StreamCloseEvent.error`. Attach a
	// one-shot close listener to every newly opened connection so we capture
	// non-graceful closures.
	const onConnectionOpen = (evt: CustomEvent<Connection>) => {
		const conn = evt.detail;
		const remote = conn.remotePeer?.toString?.() ?? 'unknown';
		const onClose = (closeEvt: Event) => {
			const err = (closeEvt as Event & { error?: Error }).error;
			if (err) {
				pushError(
					'connection:close',
					`${shortPeerId(remote) ?? remote}: ${err.message}`,
				);
			}
		};
		conn.addEventListener('close', onClose, { once: true });
	};

	node.addEventListener('connection:open', onConnectionOpen as EventListener);

	nodeListenerOff = () => {
		node.removeEventListener('connection:open', onConnectionOpen as EventListener);
	};
	attachedNode = node;
}

export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (err) {
		pushError('clipboard.writeText', err);
		return false;
	}
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes)) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ${sec % 60}s`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ${min % 60}m`;
	const day = Math.floor(hr / 24);
	return `${day}d ${hr % 24}h`;
}

export function formatTimestamp(ms: number | null | undefined): string {
	if (ms == null) return '—';
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient Date, immediately serialized to a string and discarded; never held or mutated in reactive state.
	return new Date(ms).toLocaleString();
}
