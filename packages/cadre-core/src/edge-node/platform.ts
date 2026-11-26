/**
 * What an app supplies to run the edge node (`createEdgeNode`): its key store, its storage, and
 * the platform choices (transports, listen addresses, Noise crypto) that cadre-core cannot make
 * for it. Fixed for the app's lifetime.
 */

import type { IKVStore, Libp2pTransports, NodeStorage, NoiseCryptoInterface } from '@optimystic/db-p2p';
import type { KeyStore } from '../key-store.js';
import type { DurableSlot } from '../node-local-snapshot.js';
import type { CadreNodeConfig } from '../types.js';
import type { NodeLocalKv } from './node-local.js';
import type { NoiseCryptoMode } from './options.js';

export interface EdgeNodePlatform {
	/**
	 * Everything secret: the identity (`DEFAULT_IDENTITY_KEY_ID`), the owner key in its own slot
	 * (`DEFAULT_OWNER_KEY_ID`), the joined-strand records (`KeyStoreJoinedStrandStore`) and the
	 * strand-move records. The phone's is the platform secure store; a browser's or a desktop
	 * app's may be a plaintext database, which is then where its identity already lives.
	 */
	keyStore: KeyStore;
	storage: EdgeNodeStorage;
	/**
	 * libp2p transports, given the relays the node reserves on. Default: WebSockets and circuit
	 * relay. An app with WebRTC adds `webRTC({ rtcConfiguration: { iceServers } })`, `iceServers`
	 * from `resolveStunServers(relayAddrs)`.
	 */
	transports?: (relayAddrs: readonly string[]) => Libp2pTransports;
	/**
	 * Listen addresses besides the bare `/p2p-circuit` entry cadre-core adds for a named relay
	 * (`relay-addrs.ts` → `resolveListenAddrs`). Default `[]`: an edge device binds no socket, so
	 * the only address it then has is the one a relay reservation earns it. An app whose transports
	 * carry WebRTC — a browser tab, a phone — passes `webrtcListenAddrs`, which names `/webrtc`
	 * when the app has a relay: a peer can then open a direct connection to it, and a relayed
	 * connection can upgrade to a direct one.
	 */
	listenAddrs?: (relayAddrs: readonly string[]) => string[];
	/**
	 * Noise crypto built outside libp2p-noise: `build` returns the implementation for a mode,
	 * `defaultMode` the mode used when the start options name none. Absent: libp2p-noise's own
	 * crypto, pure JavaScript on a phone (the React Native kit's `/noise-crypto` is the native one).
	 */
	noiseCrypto?: {
		build: (mode: NoiseCryptoMode) => NoiseCryptoInterface | undefined;
		defaultMode: NoiseCryptoMode;
	};
	/**
	 * The keys inside the node-local store. Each is a persistence contract: renaming one orphans
	 * every installed app's records. The defaults are the reference apps'; an app that names its
	 * own should pin them in a test.
	 */
	names?: Partial<EdgeNodeNames>;
	/**
	 * Dial loopback, private and plain `ws://` addresses. Default `true`: see the
	 * `connectionGater` comment in `buildEdgeNodeConfig`.
	 */
	allowPrivateDial?: boolean;
	/** Bound on owner genesis; default 60 s. See `runOwnerGenesis`. */
	ownerGenesisTimeoutMs?: number;
	/**
	 * A version naming the format of the data this build writes, for example the stack version it
	 * was built against. Saved with each successful start and reported by `loadSavedStart` as
	 * `writtenBy`, so a later build can tell data it cannot use from data it can.
	 */
	dataVersion?: string;
	/**
	 * The last word on the config the edge node built: strand filter, schema-signing policy,
	 * hibernation, `linkRoundTripMs`, or anything the parameters above do not cover.
	 */
	configure?: (config: CadreNodeConfig) => CadreNodeConfig;
}

/** The keys inside the node-local store (`EdgeNodeStorage.nodeLocal`) that are the edge node's. */
export interface EdgeNodeNames {
	/**
	 * Key of the saved-start record. One per app, not per party: it is what names the party every
	 * other record is filed under. Dot-free, so it cannot collide with the `<record>.<partyId>`
	 * keys of `node-local.ts`.
	 */
	savedStartKey: string;
	/**
	 * Key of the record naming a party whose dissolve has begun. Dot-free and one per app, as
	 * {@link EdgeNodeNames.savedStartKey} is.
	 */
	dissolveMarkerKey: string;
	/**
	 * Key of the join request this app opened as a link to another app (`LinkRequestStore` in
	 * `@serfab/cadre-rn/app-link`). Dot-free and one per app, as {@link EdgeNodeNames.savedStartKey} is.
	 */
	linkRequestKey: string;
	/**
	 * Key of the apps the user allowed to join before they asked (`AppRecommendationStore` in
	 * `@serfab/cadre-rn/app-link`). Dot-free and one per app, as {@link EdgeNodeNames.savedStartKey}
	 * is; each entry names its party.
	 */
	recommendationsKey: string;
}

/**
 * The storage allotment a platform declares when its backend reports no free space of its own —
 * what {@link EdgeNodeStorage.allotmentBytes} is set to on React Native (LevelDB) and
 * NativeScript (SQLite). Two gibibytes.
 *
 * A DECLARATION, not a measurement: a phone app can plausibly be given that much, and it is well
 * above the 100 MiB below which Optimystic advertises the narrowest slice of the keyspace. A
 * platform that can measure — a browser, where IndexedDB reports the origin's estimate — leaves
 * `allotmentBytes` out instead and lets the backend answer.
 */
export const DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES = 2 * 2 ** 30;

export const DEFAULT_EDGE_NODE_NAMES: EdgeNodeNames = {
	savedStartKey: 'start-options',
	dissolveMarkerKey: 'dissolving-party',
	linkRequestKey: 'link-join-request',
	recommendationsKey: 'recommended-apps',
};

/**
 * The app's storage, as the edge node opens, closes and deletes it: all of one cadre-core storage
 * scope's storage per scope, and one node-local key-value store beside them. The platform owns
 * every handle; the edge node only says when it is done with them (`close`).
 */
export interface EdgeNodeStorage {
	/**
	 * Names the storage. `createEdgeNode` refuses a second starting, joining or running edge node
	 * over the same id in one process, and replaces a stopped one: two over the same storage
	 * would share databases and an identity.
	 */
	readonly id: string;
	/**
	 * All of one storage scope's storage — the blocks, the node-local key-value records and the
	 * blob pieces, as one `NodeStorage`: `controlStorageScope(partyId)` for the control network,
	 * the strand id for each strand. The key is already safe as a database-name segment; use it
	 * verbatim, do not parse it.
	 *
	 * Use the storage package's own one-call opener — `levelDbNodeStorage`, `indexedDbNodeStorage`,
	 * `sqliteNodeStorage`, `fileNodeStorage` or `memoryNodeStorage` — rather than building the
	 * three stores by hand: each asserts that all three report ONE store identity, so nothing the
	 * node keeps falls outside what its block store measures.
	 *
	 * The same stores for the same scope until {@link close}: cadre-core asks once per scope per
	 * runtime, and again after a strand stops. Keep the `OpenNodeStorage` the factory returned
	 * and close it in {@link close} — cadre-core takes a `NodeStorage`, so it has no `close()` to
	 * call and closes nothing.
	 */
	nodeStorage(scope: string): Promise<NodeStorage>;
	/**
	 * How many bytes of this device the platform declares for every node over this storage, passed
	 * to each node as its own allotment — the control node and every strand node alike, not divided
	 * between them (`CadreNodeConfig.storage.allotmentBytes` says what that bounds and what it does
	 * not). The PLATFORM decides, because only it knows whether its backend reports free space;
	 * cadre-core applies no default.
	 *
	 * A platform whose backend reports nothing free (SQLite, LevelDB) must declare one or its nodes
	 * cannot tell how full they are — {@link DEFAULT_DEVICE_STORAGE_ALLOTMENT_BYTES} is the figure
	 * the kits use. A browser platform leaves it out, because IndexedDB reports the origin's own
	 * estimate.
	 */
	allotmentBytes?: number;
	/**
	 * A strand's offline journal (`CadreNodeConfig.strandOffline.journal`), kept in the strand
	 * scope's own database beside its blocks: the journal's keys are all under
	 * `optimystic-offline/`, a node key-value namespace the platform stores apart from blocks.
	 *
	 * Return that scope's OWN {@link nodeStorage} `kv`, never a second key-value store over the
	 * same handle: Optimystic lists the journal's key prefix in `NODE_KV_NAMESPACES` for exactly
	 * this sharing, and a second store over one handle would not see the first one's unflushed
	 * writes.
	 *
	 * The same instance for the same scope until {@link close}, which flushes and closes it with the
	 * scope's handle; cadre-core asks again on every rebuild of the strand.
	 * {@link destroyScope} closes it too. A rejection fails the strand's build. Absent: no offline
	 * mode on this platform (`setStrandOfflineMode` throws `StrandOfflineUnavailableError`), which
	 * is how a platform declares whether it supports offline mode at all.
	 */
	offlineJournal?(scope: string): Promise<IKVStore>;
	/** Delete a scope's storage. No handle on it may be open. Resolves when it is gone or was absent. */
	destroyScope(scope: string): Promise<void>;
	/**
	 * The node-local key-value store, holding the saved start, the dissolve marker, the app-link
	 * records and the per-party records of `node-local.ts`. Usable with no node running: reopens
	 * after {@link close}.
	 */
	nodeLocal(): NodeLocalKv;
	/**
	 * Flush and close the node-local store and every {@link offlineJournal}, then close every
	 * `OpenNodeStorage` {@link nodeStorage} opened. A failure closing one is logged and the rest
	 * still close; the call does not reject.
	 */
	close(): Promise<void>;
	/**
	 * Per-party slot for the trusted-owner anchor (`PersistentTrustedOwnerStore`). Absent: the
	 * node-local key `trustedOwnersKvKey(partyId)`. The anchor is not secret but it is
	 * trust-bearing, so the phone puts it in its secure store, beside the identity it qualifies.
	 */
	trustedOwnerSlot?(partyId: string): RemovableSlot;
}

/** A {@link DurableSlot} a removal can delete: the trusted-owner anchor of a party being removed. */
export interface RemovableSlot extends DurableSlot {
	/** Delete the slot's record, durably. Resolves when it is gone or was absent. */
	remove(): Promise<void>;
}
