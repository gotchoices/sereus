/**
 * cadre-phone.ts — CadreNode configured for a NativeScript phone node.
 *
 * - WebSocket + circuit-relay transports (NativeScript clients cannot listen,
 *   and have no TCP transport)
 * - SQLite-backed storage via @optimystic/db-p2p-storage-ns (lazy per-strand
 *   proxy — see ns-storage.ts)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Stable Ed25519 identity persisted in SQLite (key 'peer-private-key')
 *
 * Mirrors packages/reference-app-rn/src/cadre-phone.ts with NS storage/identity.
 */

import { CadreNode } from '@serfab/cadre-core';
import type {
	CadreNodeConfig,
	ControlNetworkSeed,
	ApplySeedResult,
	StrandInstance,
	StrandConfig,
	ConnectionPathSummary,
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { PrivateKey } from '@libp2p/interface';
import { loadOrCreateNSPeerKey, openOptimysticNSDb } from '@optimystic/db-p2p-storage-ns';
import { makeLazyNsStorage } from './ns-storage';

// ── Peer identity ─────────────────────────────────────────────────────────────
// Persist a single Ed25519 keypair so the node keeps the same PeerId across
// restarts. The key lives as a BLOB in the `kv` table of a dedicated SQLite db
// (not Keychain/Keystore — secure storage is a future hardening step).

const PEER_IDENTITY_DB_NAME = 'sereus-peer-identity';

async function loadOrCreatePhoneKey(): Promise<PrivateKey> {
	const db = await openOptimysticNSDb(PEER_IDENTITY_DB_NAME);
	try {
		return await loadOrCreateNSPeerKey(db);
	} finally {
		await db.close();
	}
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let node: CadreNode | null = null;

export interface PhoneNodeOptions {
	/** Party ID — identifies this cadre. Generated on first run. */
	partyId: string;
	/** Bootstrap multiaddrs for the drone (WebSocket). Empty for solo/forming. */
	bootstrapAddrs: string[];
}

/**
 * Get the CadreNode singleton, or null if not started.
 */
export function getPhoneNode(): CadreNode | null {
	return node;
}

/**
 * Start the phone CadreNode. Idempotent — returns the existing node if running.
 */
export async function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
	if (node?.isRunning) return node;

	const privateKey = await loadOrCreatePhoneKey();

	const config: CadreNodeConfig = {
		privateKey,
		controlNetwork: {
			partyId: opts.partyId,
			bootstrapNodes: opts.bootstrapAddrs,
		},
		profile: 'transaction',
		storage: {
			provider: (strandId: string) => makeLazyNsStorage(strandId),
		},
		network: {
			transports: [webSockets(), circuitRelayTransport()],
			listenAddrs: [], // NativeScript clients cannot listen for inbound connections
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		// Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an
		// ed25519 author key — see getChatSAppConfig). Relax the fail-closed schema
		// policy so the demo can form strands. Production nodes must leave this unset.
		requireSignedSchemas: false,
	};

	node = new CadreNode(config);
	await node.start();
	return node;
}

/**
 * Start in solo/forming mode — no drone, no network. The node forms its own
 * cadre and can create a local strand. This is the runtime-validation core of
 * the NS parity effort (createChatStrand → insertMessage → queryMessages).
 */
export async function startSolo(partyId: string): Promise<CadreNode> {
	return startPhoneNode({ partyId, bootstrapAddrs: [] });
}

/**
 * Stop the phone CadreNode and release resources.
 */
export async function stopPhoneNode(): Promise<void> {
	if (node) {
		await node.stop();
		node = null;
	}
}

// ── Seed helpers ────────────────────────────────────────────────────────────────

/**
 * Apply a seed received from the drone (or another authority).
 */
export async function applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
	if (!node) throw new Error('Phone node not started');
	return node.applySeed(seed);
}

/**
 * Decode a base64url-encoded seed string into a ControlNetworkSeed object.
 */
export function decodeSeed(encoded: string): ControlNetworkSeed {
	if (!node) throw new Error('Phone node not started');
	return node.decodeSeed(encoded);
}

// ── Peer helpers ──────────────────────────────────────────────────────────────

/**
 * Dial a peer by multiaddr on the running control network node.
 */
export async function dialPeer(addr: string): Promise<void> {
	if (!node) throw new Error('Phone node not started');
	const libp2p = node.getControlNode();
	if (!libp2p) throw new Error('Control network not available');
	await libp2p.dial(multiaddr(addr));
}

// ── Diagnostics helpers ──────────────────────────────────────────────────────────

/**
 * Classify the node's open connections as relayed vs direct (by transport).
 */
export function getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
	if (!node) throw new Error('Phone node not started');
	return node.getConnectionPaths(settleWindowMs);
}

// ── Strand helpers ────────────────────────────────────────────────────────────────

/**
 * Add a strand to this node. The strand must already exist in the control
 * database (inserted via seed or direct write).
 */
export async function addStrand(config: StrandConfig): Promise<StrandInstance> {
	if (!node) throw new Error('Phone node not started');
	return node.addStrand(config);
}
