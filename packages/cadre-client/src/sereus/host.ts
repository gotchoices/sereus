/**
 * What an app supplies to run the cadre client: its running node, behind a small host
 * interface, and where it keeps its owner key.
 *
 * The app builds and owns the node (on React Native, `@serfab/cadre-rn`'s
 * `createPhoneNode`; on the web or NativeScript, cadre-core's `createEdgeNode`); the client
 * never constructs one. A host over an edge node is a thin adapter: `node`, `on` and the
 * relay calls map onto it directly.
 */
import type { CadreNode, CadreNodeEvents, KeyStore } from '@serfab/cadre-core';

export interface CadreNodeHost {
	/** The running node, or null while stopped or starting. */
	readonly node: CadreNode | null;
	/**
	 * Subscribe to node events for the life of the host, not of one node: the host
	 * re-attaches the handler to every node it builds, so a restart drops nothing.
	 */
	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void;
	/**
	 * Relays live in the node's start options. These read them, and change them
	 * (restarting the node if it runs: libp2p reads relays only when a node is built).
	 */
	getRelayAddrs(): Promise<string[]>;
	applyRelays(addrs: string[]): Promise<void>;
	/** This party's id: the node's, or the one the next start will use. */
	partyId(): string | null;
	/** This device is an enrolled owner (owner genesis ran), so it can sign claims. */
	ownerEnrolled(): boolean;
	/** The relay reservation's status now (`RelayReservationState.status`), or null with no node. */
	relayStatus(): string | null;
	/** This device's addresses changed (a reservation granted, lost or moved), or its node restarted. */
	onReachabilityChange(callback: () => void): () => void;
}

export interface CadreHost {
	node: CadreNodeHost;
	/**
	 * Where this device keeps its owner key (cadre-core's owner slot, `DEFAULT_OWNER_KEY_ID`),
	 * separate from the machine's identity since sereus 1.17. Read only to export the key for
	 * backup; absent, there is nothing to export.
	 */
	ownerKeyStore?: KeyStore;
	/**
	 * Where this device keeps its cadron preferences (preferred bootstrap cadrons, their names,
	 * how many addresses an invitation names): one small text value. Absent, they last for the
	 * session only.
	 */
	preferences?: { load(): Promise<string | undefined>; save(text: string): Promise<void> };
}
