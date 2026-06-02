/**
 * cadre-web.ts — CadreNode lifecycle for the browser reference.
 *
 * This is the browser counterpart to `reference-app-rn/src/cadre-phone.ts`. It
 * brings up a real Sereus stack in the browser:
 *   CadreNode → control network (`CadreControl`) → signed open chat strand.
 *
 * Browser specifics vs the phone:
 *   - WebSocket + circuit-relay + WebRTC(+direct) transports (no TCP in a tab).
 *   - IndexedDB-backed raw storage via `strand-storage.ts` (per-strand handles
 *     pre-opened before the synchronous cadre-core storage provider is hit).
 *   - Ed25519 identity + party id persisted in the control IndexedDB database
 *     across reloads.
 *   - Transaction profile — the browser is an edge node, like the phone.
 *
 * Phase 1 is a **solo** single-node cadre: no control bootstrap, the node
 * self-seeds as its own authority (mirroring `cadre-cli start --authority`),
 * and the chat strand runs in `bootstrap` mode so DML lands on the strand's
 * IndexedDB without any peers. Phase 2 adds control-network bootstrap, consent
 * formation, RBAC, and cross-party convergence.
 */

import { CadreNode, authorityKeyFromLibp2p } from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	StrandInstance,
} from '@serfab/cadre-core';
import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { IRawStorage, Libp2pTransports } from '@optimystic/db-p2p';
import {
	loadOrCreateBrowserPeerKey,
	DEFAULT_PEER_KEY_NAME,
	type OptimysticWebDBHandle,
} from '@optimystic/db-p2p-storage-web';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { loadIceConfig } from './ice-config.js';
import {
	openStores,
	closeStores,
	storageProvider,
	getStoreHandle,
	getStoreStorage,
	CONTROL_STORE_KEY,
} from './strand-storage.js';
import { getChatSAppConfig, CHAT_STRAND_ID } from './chat-strand.js';

/**
 * db-p2p's transport-factory element type. The WebRTC factories from
 * `@libp2p/webrtc` carry a nominally-different `[transportSymbol]` brand than
 * db-p2p's pinned `@libp2p/interface` (the symbol is a global registry key, so
 * they are runtime-identical). `CadreNodeConfig.network.transports` is exactly
 * this `Libp2pTransports`, so we bridge with the same cast the bare-libp2p
 * wiring used — no `any`, no pinning five transitive packages.
 */
type TransportFactory = Libp2pTransports[number];

/** Outcome of the solo authority self-genesis step. */
export type AuthorityState = 'pending' | 'genesis' | 'existing' | 'error';

const PARTY_ID_KEY = 'party-id';
const IDENTITY_FIRST_SEEN_KEY = 'identity-first-seen';

let node: CadreNode | null = null;
let controlStorage: IRawStorage | null = null;
let partyId: string | null = null;
let activeStrandId: string | null = null;
let identityFirstSeenMs: number | null = null;
let authorityState: AuthorityState = 'pending';
let authorityError: string | null = null;

// ── Getters (read by the store + diagnostics) ─────────────────────────────────

export function getCadreNode(): CadreNode | null {
	return node;
}

/** The underlying control-network libp2p node — feeds the existing diagnostics. */
export function getControlNode(): Libp2p | null {
	return node?.getControlNode() ?? null;
}

export function getPartyId(): string | null {
	return partyId;
}

export function getChatStrandId(): string | null {
	return activeStrandId;
}

export function getChatStrand(): StrandInstance | undefined {
	if (!node || !activeStrandId) return undefined;
	return node.getStrand(activeStrandId);
}

/** Control IndexedDB handle — used by diagnostics for per-store row counts. */
export function getControlDbHandle(): OptimysticWebDBHandle | null {
	return getStoreHandle(CONTROL_STORE_KEY);
}

/** Control raw storage — used by diagnostics for the backend label + byte estimate. */
export function getControlStorage(): IRawStorage | null {
	return controlStorage;
}

export function getIdentityFirstSeenMs(): number | null {
	return identityFirstSeenMs;
}

export function getAuthorityState(): { state: AuthorityState; error: string | null } {
	return { state: authorityState, error: authorityError };
}

// ── Persistence helpers (party id + identity-first-seen, on the control DB) ───

async function loadOrCreatePartyId(handle: OptimysticWebDBHandle): Promise<string> {
	const existing = await handle.get('kv', PARTY_ID_KEY);
	if (typeof existing === 'string' && existing.length > 0) {
		return existing;
	}
	const fresh = crypto.randomUUID();
	await handle.put('kv', fresh, PARTY_ID_KEY);
	return fresh;
}

async function trackIdentityFirstSeen(
	handle: OptimysticWebDBHandle,
	keyName: string,
): Promise<number> {
	const existingFirstSeen = await handle.get('kv', IDENTITY_FIRST_SEEN_KEY);
	if (typeof existingFirstSeen === 'string') {
		const parsed = Number(existingFirstSeen);
		if (Number.isFinite(parsed)) return parsed;
	}
	const now = Date.now();
	await handle.put('kv', String(now), IDENTITY_FIRST_SEEN_KEY);
	// Touch the identity key so the first-seen we record is anchored to the same
	// db the peer key lives in. (Same caveat as the bare-libp2p version: on an
	// upgrade where the key predates tracking, "first seen" understates age.)
	void keyName;
	return now;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start (or return the running) browser CadreNode and bring the control network
 * up. Idempotent. Does NOT start the chat strand — call {@link addChatStrand}
 * after this resolves so the caller can subscribe to events first.
 */
export async function startCadre(): Promise<CadreNode> {
	if (node) return node;

	// Pre-open the control network's IndexedDB handle before start() — cadre-core
	// hits the synchronous storage provider with key 'control' during start.
	await openStores([CONTROL_STORE_KEY]);
	const controlHandle = getStoreHandle(CONTROL_STORE_KEY)!;

	partyId = await loadOrCreatePartyId(controlHandle);
	identityFirstSeenMs = await trackIdentityFirstSeen(controlHandle, DEFAULT_PEER_KEY_NAME);
	const privateKey = await loadOrCreateBrowserPeerKey(controlHandle);
	controlStorage = getStoreStorage(CONTROL_STORE_KEY);

	// ICE servers (STUN/TURN) from the runtime manifest. Never throws; `[]` when
	// no manifest is configured (host/LAN candidates still work).
	const iceServers = await loadIceConfig();

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId,
			bootstrapNodes: [], // solo bring-up; Phase 2 adds cadre bootstrap
		},
		profile: 'transaction', // browser is an edge node, like the phone
		storage: { provider: storageProvider },
		network: {
			transports: [
				webSockets(),
				circuitRelayTransport(),
				// Brand-skew bridge — runtime-safe, see TransportFactory above.
				webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
				webRTCDirect() as unknown as TransportFactory,
			],
			listenAddrs: [], // solo; Phase 2 sets ['/p2p-circuit', '/webrtc']
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
	};

	node = new CadreNode(config);
	await node.start();

	exposeDebugHook(node);
	await runAuthorityGenesis(node, privateKey);

	return node;
}

/**
 * Solo authority self-genesis. A single-node cadre must seed itself as the
 * authority before it can author control-network writes. This reproduces the
 * `cadre-cli start --authority` path: bridge the libp2p identity into a
 * base64url authority keypair, run the idempotent genesis `AuthorityKey` insert,
 * then initialize seed-bootstrap.
 *
 * Fail-soft: the Phase-1 chat round-trip runs in `bootstrap` mode and does not
 * depend on authority, so a genesis failure is captured for diagnostics rather
 * than aborting node startup.
 */
async function runAuthorityGenesis(cadre: CadreNode, privateKey: PrivateKey): Promise<void> {
	try {
		const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(privateKey);
		const controlDb = cadre.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot run authority genesis');
		}
		const inserted = await controlDb.ensureAuthorityKey(publicKeyB64);
		cadre.initializeSeedBootstrap(privateKeyB64);
		authorityState = inserted ? 'genesis' : 'existing';
		authorityError = null;
	} catch (err) {
		authorityState = 'error';
		authorityError = err instanceof Error ? err.message : String(err);
		console.warn('[reference-app-web] authority self-genesis failed:', err);
	}
}

/**
 * Add the signed open chat strand. Pre-opens the strand's IndexedDB handle
 * (the provider is synchronous), then `addStrand`s an open strand. On a solo
 * node the strand auto-selects `bootstrap` mode (no other cadre peers), so DML
 * lands on the strand's IndexedDB local transactor with no peers needed.
 *
 * Throws `SchemaVerificationError` if the sApp signature does not match its
 * schema/version — the signature gate the reference is meant to exercise.
 */
export async function addChatStrand(): Promise<StrandInstance> {
	if (!node) throw new Error('CadreNode not started');
	await openStores([CHAT_STRAND_ID]);
	const instance = await node.addStrand({
		strandRow: { Id: CHAT_STRAND_ID, MemberPrivateKey: null, Type: 'o' },
		sAppConfig: getChatSAppConfig(),
	});
	activeStrandId = CHAT_STRAND_ID;
	return instance;
}

/** Stop the node and release all IndexedDB handles. */
export async function stopCadre(): Promise<void> {
	if (node) {
		await node.stop();
		node = null;
	}
	clearDebugHook();
	await closeStores();
	controlStorage = null;
	partyId = null;
	activeStrandId = null;
	identityFirstSeenMs = null;
	authorityState = 'pending';
	authorityError = null;
}

// ── Debug hook ────────────────────────────────────────────────────────────────

/**
 * Read-only `__cadre` global for devtools / future e2e — mirrors the old
 * `__optimystic` hook but surfaces cadre state (party id, control peer id +
 * connection count, chat strand status) without reaching into module scope.
 */
function exposeDebugHook(cadre: CadreNode): void {
	if (typeof window === 'undefined') return;
	(window as unknown as { __cadre?: unknown }).__cadre = {
		getPartyId: () => partyId,
		getControlPeerId: () => cadre.getControlNode()?.peerId.toString() ?? null,
		getConnectionCount: () => cadre.getControlNode()?.getConnections().length ?? 0,
		getStrandStatus: () => getChatStrand()?.status ?? null,
		getAuthorityState: () => authorityState,
	};
}

function clearDebugHook(): void {
	if (typeof window === 'undefined') return;
	delete (window as unknown as { __cadre?: unknown }).__cadre;
}
