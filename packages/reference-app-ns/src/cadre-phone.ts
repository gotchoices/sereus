/**
 * cadre-phone.ts — the phone's one edge node, and the helpers the screens call on its running node.
 *
 * `edge` is `@serfab/cadre-core/edge-node`'s `createEdgeNode` over SQLite (`ns-edge-platform.ts`):
 * it builds, starts, stops and rebuilds the `CadreNode`, runs owner genesis for a party this phone
 * founds, remembers the last start between launches, and joins another cadre by invitation. The
 * view model (`cadre-vm.ts`) drives it; nothing else starts or stops it.
 *
 * Mirrors `@serfab/cadre-rn/phone-node`, which is the same edge node over the secure store and
 * rn-leveldb.
 */

import type {
	ApplySeedResult,
	CadreNode,
	ConnectionPathSummary,
	ControlNetworkSeed,
	StrandConfig,
	StrandInstance,
} from '@serfab/cadre-core';
import type { EdgeNode } from '@serfab/cadre-core/edge-node';
import { multiaddr } from '@multiformats/multiaddr';
import { createNsEdgeNode } from './ns-edge-platform';

export const edge: EdgeNode = createNsEdgeNode();

/** The running node: `edge.node` is null unless the edge node reports it running. */
function runningNode(): CadreNode {
	const node = edge.node;
	if (!node) throw new Error('Phone node not started');
	return node;
}

// ── Seed helpers ────────────────────────────────────────────────────────────────

/**
 * Apply a seed received from the drone (or another owner).
 */
export async function applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
	return runningNode().applySeed(seed);
}

/**
 * Decode a base64url-encoded seed string into a ControlNetworkSeed object.
 */
export function decodeSeed(encoded: string): ControlNetworkSeed {
	return runningNode().decodeSeed(encoded);
}

// ── Peer helpers ──────────────────────────────────────────────────────────────

/**
 * Dial a peer by multiaddr on the running control network node.
 */
export async function dialPeer(addr: string): Promise<void> {
	const libp2p = runningNode().getControlNode();
	if (!libp2p) throw new Error('Control network not available');
	await libp2p.dial(multiaddr(addr));
}

// ── Diagnostics helpers ──────────────────────────────────────────────────────────

/**
 * Classify the node's open connections as relayed vs direct (by transport).
 */
export function getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
	return runningNode().getConnectionPaths(settleWindowMs);
}

// ── Strand helpers ────────────────────────────────────────────────────────────────

/**
 * Add a strand to this node. The strand must already exist in the control
 * database (inserted via seed or direct write).
 */
export async function addStrand(config: StrandConfig): Promise<StrandInstance> {
	return runningNode().addStrand(config);
}
