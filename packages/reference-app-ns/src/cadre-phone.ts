/**
 * cadre-phone.ts — the phone's one edge node, and the peer dial the Settings screen calls on its running node.
 *
 * `edge` is `@serfab/cadre-core/edge-node`'s `createEdgeNode` over SQLite (`ns-edge-platform.ts`):
 * it builds, starts, stops and rebuilds the `CadreNode`, runs owner genesis for a party this phone
 * founds, remembers the last start between launches, and joins another cadre by invitation. The
 * view model (`cadre-vm.ts`) drives it; only `solo-smoke.ts`'s `startSolo` starts it otherwise.
 *
 * Mirrors `@serfab/cadre-rn/phone-node`, which is the same edge node over the secure store and
 * rn-leveldb.
 */

import type { CadreNode } from '@serfab/cadre-core';
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

/**
 * Dial a peer by multiaddr on the running control network node.
 */
export async function dialPeer(addr: string): Promise<void> {
	const libp2p = runningNode().getControlNode();
	if (!libp2p) throw new Error('Control network not available');
	await libp2p.dial(multiaddr(addr));
}
