/**
 * web-edge-platform.ts — the browser tab's `EdgeNodePlatform`: `@serfab/cadre-core/edge-node`'s
 * `createEdgeNode` over IndexedDB. The key store and the node-local store are
 * `node-local-slots.ts`'s, over the node-local database; each storage scope's node storage is one
 * database, opened on first use (`strand-storage.ts`); the transports are the browser's.
 * Everything else (the transitions, owner genesis, the saved start, joining another cadre,
 * dissolving the one left, acting on a removal) is the edge node's. The browser counterpart of
 * `@serfab/cadre-rn/phone-node`.
 */
import {
	createEdgeNode,
	webrtcListenAddrs,
	type EdgeNode,
	type EdgeNodeStorage,
	type NodeLocalKv,
} from '@serfab/cadre-core/edge-node';
import { resolveStunServers } from '@serfab/cadre-core';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC, webRTCDirect } from '@libp2p/webrtc';
import { closeStores, deleteStore, NODE_LOCAL_STORE_KEY, openHandle, openJournal, openNodeStorage } from './strand-storage.js';
import { nodeLocalKeyStore, nodeLocalKv } from './node-local-slots.js';

/** `EdgeNodeStorage.id`: one tab, one node. Two tabs are two processes, each with an edge node of this id. */
export const WEB_STORAGE_ID = 'sereus-web';

/** Create the tab's edge node. Called once, at module load of `cadre-web.ts`. */
export function createWebEdgeNode(): EdgeNode {
	const openNodeLocal = (): ReturnType<typeof openHandle> => openHandle(NODE_LOCAL_STORE_KEY);
	return createEdgeNode({
		keyStore: nodeLocalKeyStore(openNodeLocal),
		storage: webEdgeStorage(nodeLocalKv(openNodeLocal)),
		transports,
		listenAddrs: webrtcListenAddrs,
		// libp2p's browser default denies dialing plain-WebSocket, private and loopback
		// addresses, which blocks this dev/reference surface from dialing a local or unsecured
		// peer: an out-of-band invitation pointing at a `127.0.0.1/.../ws` responder, or the
		// strand-cohort dial in the formation → convergence e2e (see README).
		allowPrivateDial: true,
	});
}

/**
 * The tab's storage: a database per scope holding all of that scope's node storage — its blocks,
 * the node-local records the node keeps across a reload, its blob pieces and, for a strand, its
 * offline journal — and the tab's own node-local store beside them. No `trustedOwnerSlot`: the
 * anchor is the node-local record cadre-core files under `trusted-owners.<partyId>`, the key tabs
 * used before the edge node.
 *
 * No `allotmentBytes`: IndexedDB reports the origin's storage estimate, so each node measures
 * against what the browser actually gives this origin rather than against a figure the app made up
 * (`docs/cadre/node-storage.md` → "The storage allotment").
 */
function webEdgeStorage(nodeLocal: NodeLocalKv): EdgeNodeStorage {
	return {
		id: WEB_STORAGE_ID,
		nodeStorage: (scope) => openNodeStorage(scope),
		offlineJournal: (scope) => openJournal(scope),
		destroyScope: (scope) => deleteStore(scope),
		nodeLocal: () => nodeLocal,
		close: () => closeStores(),
	};
}

/** WebSocket + circuit relay + WebRTC (and direct) transports: no TCP in a tab. */
function transports(relayAddrs: readonly string[]): Libp2pTransports {
	// STUN for the WebRTC upgrade: each relay is also a STUN server. `[]` with no relay
	// configured and no override (host/LAN candidates still work).
	const iceServers = resolveStunServers(relayAddrs, import.meta.env.VITE_STUN_URLS);
	return [webSockets(), circuitRelayTransport(), webRTC({ rtcConfiguration: { iceServers } }), webRTCDirect()];
}

