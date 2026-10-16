/**
 * `createPhoneNode` — `@serfab/cadre-core/edge-node`'s `createEdgeNode` over the phone's secure
 * store and rn-leveldb: identity, owner key, joined-strand and strand-move records in the secure
 * store through `SecureStoreKeyStore`, the trusted-owner anchor there too in a slot of its own
 * (`anchorSlotKey`), and a LevelDB database per storage scope plus one for the node-local
 * records. Everything else (the transitions, owner genesis, the saved start, joining another
 * cadre, dissolving the one left, acting on a removal) is the edge node's.
 *
 * Nothing native is imported here. The app passes in its secure store, `rn-leveldb`'s two
 * constructors and its transports, so a Node test runs this code over fakes.
 */

import {
	createEdgeNode,
	DEFAULT_EDGE_NODE_NAMES,
	type EdgeNode,
	type EdgeNodeNames,
	type EdgeNodePlatform,
	type RemovableSlot,
} from '@serfab/cadre-core/edge-node';
import { forwardedSecureStoreOptions, SecureStoreKeyStore, type SecureStoreApi, type SecureStoreKeyStoreOptions } from '../key-store.js';
import { anchorSlotKey, secureStoreSlot } from '../node-local.js';
import { LevelDBEdgeStorage, type LevelDBNative } from './leveldb-storage.js';

/** What the app's platform provides: the edge node's platform, the key store and storage replaced by their phone backends. */
export interface PhoneNodePlatform extends Omit<EdgeNodePlatform, 'keyStore' | 'storage' | 'names'> {
	/**
	 * `expo-secure-store`, or an adapter over the app's own secure store (see `/key-store`). Holds
	 * the identity, the owner key (in its own slot) and the trusted-owner anchor.
	 */
	secureStore: SecureStoreApi;
	/**
	 * One options object for the identity, the owner key and the trusted-owner anchor, so they
	 * cannot drift into different gating. `{ keychainAccessible: AFTER_FIRST_UNLOCK }` lets a
	 * background or push-wake start read them while the device is locked; leave
	 * `requireAuthentication` off, since background owner writes sign with no user present.
	 */
	secureStoreOptions?: SecureStoreKeyStoreOptions;
	/** `rn-leveldb`'s two constructors, through which every database is opened, and its `destroyDB`. */
	leveldb: LevelDBNative;
	/**
	 * Storage names. Each is a persistence contract: renaming one orphans every installed phone's
	 * records. The defaults are the reference app's; an app that names its own should pin them in
	 * a test.
	 */
	names?: Partial<PhoneNodeNames>;
}

/** The edge node's keys inside the node-local database, plus the LevelDB names that are the phone's. */
export interface PhoneNodeNames extends EdgeNodeNames {
	/** Prefix of each cadre-core storage scope's LevelDB database name. */
	storagePrefix: string;
	/** The LevelDB database holding the non-trust-bearing node-local records and the saved start. */
	nodeLocalDb: string;
	/** Key prefix inside {@link PhoneNodeNames.nodeLocalDb}. */
	nodeLocalKvPrefix: string;
}

export const DEFAULT_PHONE_NODE_NAMES: PhoneNodeNames = {
	storagePrefix: 'sereus-',
	nodeLocalDb: 'sereus-node-local',
	nodeLocalKvPrefix: 'sereus:node-local:',
	...DEFAULT_EDGE_NODE_NAMES,
};

/** The phone's edge node. */
export type PhoneNode = EdgeNode;

/**
 * Create the app's phone node. Call once per app. Throws when a phone node over the same storage
 * prefix is starting or running in this process; a stopped or failed one is replaced (a
 * development reload re-runs the module that calls this).
 */
export function createPhoneNode(platform: PhoneNodePlatform): PhoneNode {
	const { secureStore, secureStoreOptions, leveldb, names: overrides, ...shared } = platform;
	const names: PhoneNodeNames = { ...DEFAULT_PHONE_NODE_NAMES, ...overrides };
	const storage = new LevelDBEdgeStorage(leveldb, names, (partyId) => anchorSlot(secureStore, secureStoreOptions, partyId));
	return createEdgeNode({ ...shared, keyStore: new SecureStoreKeyStore(secureStore, secureStoreOptions), storage, names });
}

/** The party's trusted-owner anchor in the secure store, under the same gating as the identity. */
function anchorSlot(secureStore: SecureStoreApi, options: SecureStoreKeyStoreOptions | undefined, partyId: string): RemovableSlot {
	const key = anchorSlotKey(partyId);
	return {
		...secureStoreSlot(secureStore, key, options),
		remove: () => secureStore.deleteItemAsync(key, forwardedSecureStoreOptions(options ?? {})),
	};
}
