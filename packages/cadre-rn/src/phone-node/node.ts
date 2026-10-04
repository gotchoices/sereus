/**
 * `createPhoneNode` — build, start, stop and rebuild a phone's `CadreNode` the prescribed way:
 * identity in the secure store, the four node-local stores durable and party-scoped, LevelDB
 * storage per scope, owner genesis, and the last start remembered for unattended starts.
 *
 * Nothing native is imported here. The app passes in its secure store, `rn-leveldb`'s two
 * constructors and its transports, so a Node test runs this code over fakes.
 */

import {
	CadreNode,
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
	PersistentStrandNetworkStateStore,
	PersistentTrustedOwnerStore,
} from '@serfab/cadre-core';
import type { CadreNodeConfig, CadreNodeEvents } from '@serfab/cadre-core';
import type { Libp2pTransports, NoiseCryptoInterface } from '@optimystic/db-p2p';
import {
	LevelDBKVStore,
	LevelDBRawStorage,
	openOptimysticRNDb,
	type RNLevelDBOpenFn,
	type RNLevelDBWriteBatchCtor,
} from '@optimystic/db-p2p-storage-rn';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import type { DurableSlot } from '@serfab/cadre-core';
import { SecureStoreKeyStore, type SecureStoreApi, type SecureStoreKeyStoreOptions } from '../key-store.js';
import {
	anchorSlotKey,
	bootstrapPeersKvKey,
	enrolledMachinesKvKey,
	kvStoreSlot,
	secureStoreSlot,
	strandNetworkKvKey,
} from '../node-local.js';
// Type-only: the noise-crypto module loads react-native-quick-crypto at runtime.
import type { NoiseCryptoMode } from '../noise-crypto.js';
import { buildPhoneNodeConfig, runOwnerGenesis, type OwnerGenesisResult } from './config.js';
import { parseSavedStart, serializeSavedStart, type PhoneNodeOptions, type SavedStart } from './options.js';

/** `rn-leveldb`, as the app passes it: `{ openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch }`. */
export interface LevelDBNative {
	openFn: RNLevelDBOpenFn;
	WriteBatch: RNLevelDBWriteBatchCtor;
}

/** What the app's platform provides. Fixed for the app's lifetime. */
export interface PhoneNodePlatform {
	/** `expo-secure-store`, or an adapter over the app's own secure store (see `/key-store`). */
	secureStore: SecureStoreApi;
	/**
	 * One options object for the identity and the trusted-owner anchor, so they cannot drift into
	 * different gating. `{ keychainAccessible: AFTER_FIRST_UNLOCK }` lets a background or push-wake
	 * start read the identity while the device is locked.
	 */
	secureStoreOptions?: SecureStoreKeyStoreOptions;
	/** `rn-leveldb`'s two constructors; every database is opened through them. */
	leveldb: LevelDBNative;
	/**
	 * libp2p transports, given the relays the node reserves on. Default: WebSockets and circuit
	 * relay. An app with `react-native-webrtc` adds `webRTC({ rtcConfiguration: { iceServers } })`,
	 * `iceServers` from cadre-core's `resolveStunServers(relayAddrs)`.
	 */
	transports?: (relayAddrs: readonly string[]) => Libp2pTransports;
	/**
	 * Native Noise crypto: `build` is `buildNoiseCrypto` from `/noise-crypto`, `defaultMode` the
	 * mode used when the start options name none. Absent: libp2p-noise's pure-JavaScript crypto.
	 */
	noiseCrypto?: {
		build: (mode: NoiseCryptoMode) => NoiseCryptoInterface | undefined;
		defaultMode: NoiseCryptoMode;
	};
	/**
	 * Storage names. Each is a persistence contract: renaming one orphans every installed phone's
	 * records. The defaults are the reference app's; an app that names its own should pin them in
	 * a test.
	 */
	names?: Partial<PhoneNodeNames>;
	/**
	 * Dial loopback, private and plain `ws://` addresses. Default `true`: see the
	 * `connectionGater` comment in `buildPhoneNodeConfig`.
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
	 * The last word on the config the kit built: strand filter, schema-signing policy, hibernation,
	 * `linkRoundTripMs`, or anything the parameters above do not cover.
	 */
	configure?: (config: CadreNodeConfig) => CadreNodeConfig;
}

export interface PhoneNodeNames {
	/** Prefix of each cadre-core storage scope's LevelDB database name. */
	storagePrefix: string;
	/** The LevelDB database holding the non-trust-bearing node-local records and the saved start. */
	nodeLocalDb: string;
	/** Key prefix inside {@link PhoneNodeNames.nodeLocalDb}. */
	nodeLocalKvPrefix: string;
	/**
	 * Key of the saved-start record inside {@link PhoneNodeNames.nodeLocalDb}. One per app, not per
	 * party: it is what names the party every other record is filed under. Dot-free, so it cannot
	 * collide with the `<record>.<partyId>` keys of `/node-local`.
	 */
	savedStartKey: string;
}

export const DEFAULT_PHONE_NODE_NAMES: PhoneNodeNames = {
	storagePrefix: 'sereus-',
	nodeLocalDb: 'sereus-node-local',
	nodeLocalKvPrefix: 'sereus:node-local:',
	savedStartKey: 'start-options',
};

export type PhoneNodeStatus =
	| { state: 'stopped' }
	| { state: 'starting' }
	| { state: 'running'; node: CadreNode; owner: OwnerGenesisResult }
	| { state: 'failed'; error: Error };

export interface PhoneNode {
	readonly status: PhoneNodeStatus;
	/** The running node, or null; null as soon as a stop or restart begins tearing it down. */
	readonly node: CadreNode | null;
	/** The options the running node was started with, the Noise mode resolved; null unless running. */
	readonly options: PhoneNodeOptions | null;
	/**
	 * Start, or join the start in flight; a running node is returned as is, whatever its options.
	 * A start called during a stop or restart runs after it. Opens the four node-local stores
	 * party-scoped, builds and starts the node, runs owner genesis (fail-soft, bounded), then saves
	 * the options with `autoStart: true`. A failed start closes everything it opened and leaves
	 * `status` `failed`; the next call starts afresh.
	 */
	start(options: PhoneNodeOptions): Promise<CadreNode>;
	/**
	 * The user's "disconnect": waits for a start in flight, saves `autoStart: false` so nothing
	 * starts the node unattended, stops it, and closes every database it opened — control, each
	 * strand, node-local. rn-leveldb holds a lock per name, so one left open fails the next start.
	 */
	stop(): Promise<void>;
	/**
	 * Rebuild the node with new options (relays, Noise mode): libp2p reads them only when the node
	 * is built. `autoStart` is not cleared on the way, so a crash mid-restart still starts again.
	 */
	restart(options: PhoneNodeOptions): Promise<CadreNode>;
	/**
	 * The last start, or `undefined` when none is saved or the record is unusable. A read fault
	 * throws. Called during a stop, it answers after the stop has saved `autoStart: false`.
	 */
	loadSavedStart(): Promise<SavedStart | undefined>;
	/**
	 * Subscribe to a node event for the life of this phone node, not of one `CadreNode`: the
	 * handler is re-applied to every node a start or restart builds, before it starts. Register the
	 * `strand:discovered` handler that attaches strands here, before `start` — strands joined from
	 * another party come back through it after every start. Returns an unsubscribe.
	 */
	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void;
	onStatus(listener: (status: PhoneNodeStatus) => void): () => void;
	/** The owner public key (base64url) for pairing; null unless running. Never private material. */
	ownerPublicKey(): string | null;
}

/** One handler, closed over its event, so re-applying it to a new node needs no cast. */
interface Subscription {
	attach(node: CadreNode): void;
	detach(node: CadreNode): void;
}

/** An open rn-leveldb handle, as `openOptimysticRNDb` returns it. */
type LevelDbHandle = ReturnType<typeof openOptimysticRNDb>;

/** Phone nodes by storage prefix: two over the same names would share databases and an identity. */
const phoneNodes = new Map<string, PhoneNode>();

/**
 * Create the app's phone node. Call once per app. Throws when a phone node over the same storage
 * prefix is starting or running in this process; a stopped or failed one is replaced (a
 * development reload re-runs the module that calls this).
 */
export function createPhoneNode(platform: PhoneNodePlatform): PhoneNode {
	const names: PhoneNodeNames = { ...DEFAULT_PHONE_NODE_NAMES, ...platform.names };
	const existing = phoneNodes.get(names.storagePrefix);
	if (existing && (existing.status.state === 'starting' || existing.status.state === 'running')) {
		throw new Error(
			`a phone node over storage prefix '${names.storagePrefix}' is already ${existing.status.state}; ` +
			'create one per app and share it',
		);
	}
	const created = new PhoneNodeRuntime(platform, names);
	phoneNodes.set(names.storagePrefix, created);
	return created;
}

class PhoneNodeRuntime implements PhoneNode {
	private readonly keyStore: SecureStoreKeyStore;
	private current: CadreNode | null = null;
	private runningOptions: PhoneNodeOptions | null = null;
	private starting: Promise<CadreNode> | null = null;
	private stopping: Promise<void> | null = null;
	/**
	 * Start, stop and restart run one at a time, in call order: each opens or closes the databases
	 * the others use, so a start overlapping a stop would build on handles the stop then closes.
	 */
	private transitions: Promise<unknown> = Promise.resolve();
	private currentStatus: PhoneNodeStatus = { state: 'stopped' };
	/** Every database this node opened, by name, so `stop` can close them all. */
	private readonly databases = new Map<string, LevelDbHandle>();
	private readonly subscriptions = new Set<Subscription>();
	private readonly statusListeners = new Set<(status: PhoneNodeStatus) => void>();

	constructor(
		private readonly platform: PhoneNodePlatform,
		private readonly names: PhoneNodeNames,
	) {
		this.keyStore = new SecureStoreKeyStore(platform.secureStore, platform.secureStoreOptions);
	}

	get status(): PhoneNodeStatus {
		return this.currentStatus;
	}

	get node(): CadreNode | null {
		return this.currentStatus.state === 'running' ? this.current : null;
	}

	get options(): PhoneNodeOptions | null {
		return this.currentStatus.state === 'running' ? this.runningOptions : null;
	}

	start(options: PhoneNodeOptions): Promise<CadreNode> {
		if (this.starting) return this.starting;
		return this.trackStart(() => (this.current?.isRunning ? Promise.resolve(this.current) : this.buildAndStart(options)));
	}

	stop(): Promise<void> {
		// A start called from here on runs after this stop rather than joining the one it ends.
		this.starting = null;
		const stopping = this.inTurn(() => this.stopAndClearAutoStart());
		this.stopping = stopping;
		const settled = (): void => {
			if (this.stopping === stopping) this.stopping = null;
		};
		stopping.then(settled, settled);
		return stopping;
	}

	restart(options: PhoneNodeOptions): Promise<CadreNode> {
		this.starting = null;
		return this.trackStart(async () => {
			await this.shutDown();
			return this.buildAndStart(options);
		});
	}

	async loadSavedStart(): Promise<SavedStart | undefined> {
		// A stop in progress decides `autoStart`: answer after it, so an unattended start does
		// not act on the value the stop is replacing. Its failure is its caller's.
		await this.stopping?.catch(() => undefined);
		return parseSavedStart(await this.nodeLocalSlot(this.names.savedStartKey).load());
	}

	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void {
		const subscription: Subscription = {
			attach: (node) => node.on(event, handler),
			detach: (node) => node.off(event, handler),
		};
		this.subscriptions.add(subscription);
		if (this.current) subscription.attach(this.current);
		return () => {
			this.subscriptions.delete(subscription);
			if (this.current) subscription.detach(this.current);
		};
	}

	onStatus(listener: (status: PhoneNodeStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	ownerPublicKey(): string | null {
		const node = this.node;
		if (!node) return null;
		try {
			return node.getIdentityOwnerKey().publicKeyB64;
		} catch (err) {
			// Reachable only without a key store, which a phone node always has.
			console.warn('[cadre-rn/phone-node] owner public key unavailable:', err);
			return null;
		}
	}

	// ── transitions ──────────────────────────────────────────────────────────

	/** Run `op` after every transition called before it, whether those succeeded or failed. */
	private inTurn<T>(op: () => Promise<T>): Promise<T> {
		const result = this.transitions.then(op);
		this.transitions = result.catch(() => undefined);
		return result;
	}

	/** Queue a start, and let later `start` calls join it until it settles. */
	private trackStart(op: () => Promise<CadreNode>): Promise<CadreNode> {
		const starting = this.inTurn(op);
		this.starting = starting;
		const settled = (): void => {
			if (this.starting === starting) this.starting = null;
		};
		starting.then(settled, settled);
		return starting;
	}

	// ── start ────────────────────────────────────────────────────────────────

	private async buildAndStart(options: PhoneNodeOptions): Promise<CadreNode> {
		this.setStatus({ state: 'starting' });
		try {
			const resolved = this.resolveOptions(options);
			const node = new CadreNode(await this.buildConfig(resolved));
			this.current = node;
			for (const subscription of this.subscriptions) subscription.attach(node);
			await node.start();
			const owner = await runOwnerGenesis(node, this.platform.ownerGenesisTimeoutMs);
			this.runningOptions = resolved;
			// Saved only now, so a start that failed never replaces the last one that came up.
			await this.saveStart({ options: resolved, autoStart: true, writtenBy: this.platform.dataVersion });
			this.setStatus({ state: 'running', node, owner });
			return node;
		} catch (err) {
			// The start's own error is the one to report; a failure tearing down after it is only logged.
			await this.shutDown().catch((cleanupErr: unknown) => {
				console.warn('[cadre-rn/phone-node] cleaning up after a failed start failed:', cleanupErr);
			});
			const error = err instanceof Error ? err : new Error(String(err));
			this.setStatus({ state: 'failed', error });
			throw error;
		}
	}

	/** The options with the Noise mode resolved, so a later build's default does not change a device that already ran. */
	private resolveOptions(options: PhoneNodeOptions): PhoneNodeOptions {
		const defaultMode = this.platform.noiseCrypto?.defaultMode;
		if (options.noiseCryptoMode !== undefined || defaultMode === undefined) return options;
		return { ...options, noiseCryptoMode: defaultMode };
	}

	/**
	 * Open the node-local stores and assemble the config. A store read failure propagates and fails
	 * the start: an unreadable trusted-owner anchor is a refusal to start, not a silent downgrade to
	 * trusting nobody, and starting empty would let the next write destroy an intact anchor. (The
	 * enrolled-machine store cold-starts instead; a lost repair hint must not stop a node.)
	 */
	private async buildConfig(options: PhoneNodeOptions): Promise<CadreNodeConfig> {
		const { partyId } = options;
		const config = buildPhoneNodeConfig({
			...options,
			noiseCrypto: this.buildNoiseCrypto(options.noiseCryptoMode),
			keyStore: this.keyStore,
			storageProvider: (scope) => new LevelDBRawStorage(this.database(this.names.storagePrefix + scope)),
			transports: (this.platform.transports ?? defaultTransports)(options.relayAddrs),
			allowPrivateDial: this.platform.allowPrivateDial ?? true,
			trustedOwnerStore: await PersistentTrustedOwnerStore.open(
				secureStoreSlot(this.platform.secureStore, anchorSlotKey(partyId), this.platform.secureStoreOptions),
				partyId,
			),
			bootstrapPeerStore: await PersistentBootstrapPeerStore.open(this.nodeLocalSlot(bootstrapPeersKvKey(partyId)), partyId),
			enrolledMachineStore: await PersistentEnrolledMachineStore.open(this.nodeLocalSlot(enrolledMachinesKvKey(partyId)), partyId),
			strandNetworkStateStore: await PersistentStrandNetworkStateStore.open(this.nodeLocalSlot(strandNetworkKvKey(partyId)), partyId),
		});
		return this.platform.configure ? this.platform.configure(config) : config;
	}

	private buildNoiseCrypto(mode: NoiseCryptoMode | undefined): NoiseCryptoInterface | undefined {
		const noiseCrypto = this.platform.noiseCrypto;
		return noiseCrypto && mode ? noiseCrypto.build(mode) : undefined;
	}

	// ── stop ─────────────────────────────────────────────────────────────────

	private async stopAndClearAutoStart(): Promise<void> {
		// NOTE: with no node running (the last start failed) the saved record is left alone, so an
		// earlier `autoStart: true` survives this stop. The reference app offers Disconnect only
		// while connected; if an app lets a user stop a phone whose start failed, rewrite the
		// saved record with `autoStart: false` here too.
		if (this.runningOptions) {
			await this.saveStart({ options: this.runningOptions, autoStart: false, writtenBy: this.platform.dataVersion });
		}
		await this.shutDown();
	}

	/**
	 * Stop the node and close every database, the node's references cleared first: a throwing
	 * `stop()` must not leave a node whose databases the `finally` has just closed, which the next
	 * `start` would hand back as running.
	 */
	private async shutDown(): Promise<void> {
		const stopping = this.current;
		this.current = null;
		this.runningOptions = null;
		try {
			if (stopping) {
				for (const subscription of this.subscriptions) subscription.detach(stopping);
				await stopping.stop();
			}
		} finally {
			await this.closeDatabases();
			this.setStatus({ state: 'stopped' });
		}
	}

	private async closeDatabases(): Promise<void> {
		const open = [...this.databases.values()];
		this.databases.clear();
		for (const db of open) {
			try {
				await db.close();
			} catch (err) {
				console.warn('[cadre-rn/phone-node] closing a database failed:', err);
			}
		}
	}

	// ── storage ──────────────────────────────────────────────────────────────

	/** The open database of this name, opening it on first use: one native handle per name. */
	private database(name: string): LevelDbHandle {
		let db = this.databases.get(name);
		if (!db) {
			db = openOptimysticRNDb({ ...this.platform.leveldb, name });
			this.databases.set(name, db);
		}
		return db;
	}

	private nodeLocalSlot(key: string): DurableSlot {
		return kvStoreSlot(new LevelDBKVStore(this.database(this.names.nodeLocalDb), this.names.nodeLocalKvPrefix), key);
	}

	/** Best-effort: a failed write is logged and changes nothing about the node. */
	private async saveStart(saved: SavedStart): Promise<void> {
		try {
			await this.nodeLocalSlot(this.names.savedStartKey).save(serializeSavedStart(saved));
		} catch (err) {
			console.warn('[cadre-rn/phone-node] could not save the start options:', err);
		}
	}

	private setStatus(status: PhoneNodeStatus): void {
		this.currentStatus = status;
		for (const listener of this.statusListeners) {
			try {
				listener(status);
			} catch (err) {
				console.warn('[cadre-rn/phone-node] status listener threw:', err);
			}
		}
	}
}

/** WebSockets to dial the party's machines and relays, and circuit relay to be reachable through one. */
function defaultTransports(): Libp2pTransports {
	return [webSockets(), circuitRelayTransport()];
}
