/**
 * `createPhoneNode` — build, start, stop and rebuild a phone's `CadreNode` the prescribed way:
 * identity and owner key in the secure store, the four node-local stores durable and
 * party-scoped, LevelDB storage per scope, owner genesis, the last start remembered for
 * unattended starts, and the switch to another party's cadre by invitation.
 *
 * Nothing native is imported here. The app passes in its secure store, `rn-leveldb`'s two
 * constructors and its transports, so a Node test runs this code over fakes.
 */

import {
	addBackupOwnerKey,
	CadreNode,
	DEFAULT_IDENTITY_KEY_ID,
	exportOwnerKey,
	exportStrandBundle,
	importOwnerKeyInto,
	loadOrCreateIdentityKey,
	PersistentBootstrapPeerStore,
	PersistentEnrolledMachineStore,
	PersistentStrandNetworkStateStore,
	PersistentTrustedOwnerStore,
	readStrandHoldings,
} from '@serfab/cadre-core';
import type {
	BackupOwnerKey,
	CadreInvitation,
	CadreJoinProgress,
	CadreNodeConfig,
	CadreNodeEvents,
	CadreOwnerKey,
	CadreRemoval,
	ImportedOwnerKey,
	OwnerKeyExportOptions,
	OwnerKeyRemovalPlan,
	OwnerKeyRemovalResult,
	RedeemCadreInvitationOptions,
	RedeemCadreInvitationResult,
	RemoveOwnerOptions,
	StrandMoveReport,
} from '@serfab/cadre-core';
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
	type KvStoreApi,
} from '../node-local.js';
// Type-only: the noise-crypto module loads react-native-quick-crypto at runtime.
import type { NoiseCryptoMode } from '../noise-crypto.js';
import { buildPhoneNodeConfig, requireOwnerKeyLabel, runOwnerGenesis, wireJoinedOwnerKey, type OwnerGenesisResult } from './config.js';
import {
	finishMarkedRemoval,
	finishRemovalAtStart,
	formerPartyRead,
	formerPartyRefusal,
	readFormerParty,
	removeParty,
	StrandMovePendingError,
	withoutFormerParty,
	type DissolveFormerPartyOptions,
	type PartyStorage,
} from './dissolve.js';
import { parseSavedStart, serializeSavedStart, startAfterRemoval, type PhoneNodeOptions, type SavedStart } from './options.js';
import {
	adoptMoveRecord,
	adoptMovesInto,
	deferredOutcome,
	joinMoveRecord,
	pendingMove,
	StrandMoveRecords,
	type PendingStrandMove,
	type StrandMoveOutcome,
} from './strand-move.js';

/**
 * `rn-leveldb`, as the app passes it:
 * `{ openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch, destroy: (name) => LevelDB.destroyDB(name) }`.
 */
export interface LevelDBNative {
	openFn: RNLevelDBOpenFn;
	WriteBatch: RNLevelDBWriteBatchCtor;
	/** rn-leveldb's `LevelDB.destroyDB(name)`: deletes a closed database; throws when it is open. */
	destroy: (name: string) => void;
}

/** What the app's platform provides. Fixed for the app's lifetime. */
export interface PhoneNodePlatform {
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
	/**
	 * Key, inside {@link PhoneNodeNames.nodeLocalDb}, of the record naming a party whose dissolve
	 * has begun. Dot-free and one per app, as {@link PhoneNodeNames.savedStartKey} is.
	 */
	dissolveMarkerKey: string;
	/**
	 * Key, inside {@link PhoneNodeNames.nodeLocalDb}, of the join request this app opened as a link
	 * (`LinkRequestStore` in `@serfab/cadre-rn/app-link`). Dot-free and one per app, as
	 * {@link PhoneNodeNames.savedStartKey} is.
	 */
	linkRequestKey: string;
	/**
	 * Key, inside {@link PhoneNodeNames.nodeLocalDb}, of the apps the user allowed to join before
	 * they asked (`AppRecommendationStore` in `@serfab/cadre-rn/app-link`). Dot-free and one per
	 * app, as {@link PhoneNodeNames.savedStartKey} is; each entry names its party.
	 */
	recommendationsKey: string;
}

export const DEFAULT_PHONE_NODE_NAMES: PhoneNodeNames = {
	storagePrefix: 'sereus-',
	nodeLocalDb: 'sereus-node-local',
	nodeLocalKvPrefix: 'sereus:node-local:',
	savedStartKey: 'start-options',
	dissolveMarkerKey: 'dissolving-party',
	linkRequestKey: 'link-join-request',
	recommendationsKey: 'recommended-apps',
};

export type PhoneNodeStatus =
	| { state: 'stopped' }
	| { state: 'starting' }
	/** Started in the party an invitation names and redeeming it there; not admitted yet, so `PhoneNode.node` is null. */
	| { state: 'joining'; node: CadreNode }
	| { state: 'running'; node: CadreNode; owner: OwnerGenesisResult }
	/**
	 * An owner of `partyId` removed this app from it: the node is stopped and the party's local
	 * storage deleted. `formerPartyId` is the party this app founded and left, which the saved start
	 * now names with `autoStart: false`; absent when there is none. `start` and `joinCadre` work as
	 * from `stopped`.
	 */
	| { state: 'removed'; partyId: string; removal: CadreRemoval; formerPartyId?: string }
	| { state: 'failed'; error: Error };

/** A join's progress: the redemption's passes and pauses, then the steps after a member admitted the app. */
export type PhoneJoinProgress =
	| CadreJoinProgress
	/** A member admitted the app; the kit is wiring its owner key and saving the start. */
	| { state: 'admitted'; grantsOwner: boolean }
	/** The app's key is wired as an owner and the strands this join recorded are being adopted. */
	| { state: 'moving-strands' };

/** How {@link PhoneNode.joinCadre} runs. */
export interface JoinCadreOptions {
	/** Relays the joined node reserves on. Default: the running start's, else the saved one's. */
	relayAddrs?: string[];
	/** Default: the running start's, else the saved one's, else the platform default. */
	noiseCryptoMode?: NoiseCryptoMode;
	/** Cancels the join: the app goes back to the party it left, and the call throws the signal's reason. */
	signal?: AbortSignal;
	/**
	 * Each redemption pass and each pause while no member is ready, for a "waiting for an always-on
	 * machine" display; then `admitted`, and `moving-strands` when this join's strands are adopted.
	 * A listener that throws is logged and ignored.
	 */
	onProgress?: (progress: PhoneJoinProgress) => void;
}

/** What an admitted {@link PhoneNode.joinCadre} returns. */
export interface JoinCadreResult extends RedeemCadreInvitationResult {
	/** The party this app founded and has left, when it founded one; saved as `PhoneNodeOptions.formerPartyId`. */
	formerPartyId?: string;
	/** How moving that party's strands into this one settled; absent when there was nothing to move. */
	strandMove?: StrandMoveOutcome;
}

export interface PhoneNode {
	readonly status: PhoneNodeStatus;
	/** The running node, or null; null as soon as a stop or restart begins tearing it down, and while joining. */
	readonly node: CadreNode | null;
	/** The options the running node was started with, the Noise mode resolved; null unless running. */
	readonly options: PhoneNodeOptions | null;
	/**
	 * This app's peer id, the same in every party: the node's while one is running or joining,
	 * answered at once; otherwise read from the secure store, created there when absent, in turn
	 * with start, stop and join so a first start cannot generate a different key. A read the
	 * secure store refuses throws.
	 */
	identityPeerId(): Promise<string>;
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
	 * Join the cadre `invitation` names: this app's one node moves to that party, keeping its
	 * identity, so the peer id an owner targeted is the one that redeems. Runs in turn with
	 * start, stop and restart; a start called meanwhile runs after it, and a `stop` cancels it.
	 *
	 * Already running in that party: redeems on the running node (a device already admitted is
	 * answered as such) and wires its owner key. Otherwise: stops the running node, starts one
	 * for the invitation's party with `origin: 'joined'` (status `joining`), and redeems there,
	 * waiting for a member to answer until one accepts, one refuses, the invitation expires
	 * (`invite-spent`) or `options.signal` aborts. Admitted: wires the owner key when the party
	 * lists it, saves the start (`autoStart: true`) and reports `running`. Anything else: stops
	 * that node, starts again what was running before (a node that was stopped stays stopped),
	 * and throws the join's error; a failure restarting is logged and leaves status `failed`.
	 *
	 * The start is saved only once admitted, so an app killed while waiting relaunches into the
	 * party it left. The left party's data stays on disk under its own names.
	 *
	 * Leaving a party this app founded moves its strands: they are exported before anything stops
	 * (from a node started for the export alone when none runs) and kept in the secure store, and
	 * adopted once the app's key is wired as an owner of the joined party, before the join reports
	 * `running`; otherwise a later start adopts them (`result.strandMove` says which). Refused
	 * before anything stops, with `StrandsNeedOwnerJoinError`, when there is something to move and
	 * the invitation does not grant owner; and with the export's error when it fails.
	 */
	joinCadre(invitation: CadreInvitation, options?: JoinCadreOptions): Promise<JoinCadreResult>;
	/**
	 * The move from `formerPartyId` (the running start's, else the saved one's) still waiting to be
	 * adopted, or `undefined` when there is none. A read the secure store refuses throws.
	 */
	pendingStrandMove(): Promise<PendingStrandMove | undefined>;
	/**
	 * Adopt the waiting move on the running node now, in turn with start, stop and join; `undefined`
	 * when no move from `formerPartyId` names the running party. Throws what the adoption throws,
	 * `StrandMoveNotOwnerError` while the app's key is no owner there.
	 */
	finishStrandMove(): Promise<StrandMoveReport | undefined>;
	/**
	 * Delete the local storage of `formerPartyId`, the party this app founded and left, once the
	 * running party holds everything it holds and no other machine is in it. Runs in turn with
	 * start, stop, restart and join. Stops the running node, reads the former party from a node
	 * started for that alone, and starts the running party again, without `formerPartyId` once the
	 * former party is removed; a failure of that last start is the call's error.
	 *
	 * Refused before anything stops: with an `Error` unless running with a `formerPartyId` other
	 * than the running party, and with `StrandMovePendingError` while a move from it waits. Refused
	 * after the read, the running party started again and nothing deleted: with
	 * `FormerPartyNotEmptyError`, whose strand and pending-join ids `options.discard` may give up.
	 */
	dissolveFormerParty(options?: DissolveFormerPartyOptions): Promise<void>;
	/**
	 * The last start, or `undefined` when none is saved or the record is unusable. A read fault
	 * throws. Called during a stop, it answers after the stop has saved `autoStart: false`; during
	 * the kit's response to a removal, after that has replaced the saved start.
	 */
	loadSavedStart(): Promise<SavedStart | undefined>;
	/**
	 * The slot `LinkRequestStore` (`@serfab/cadre-rn/app-link`) keeps the open link join request in,
	 * beside the saved start in the node-local database. Works with no node running, as
	 * `loadSavedStart` does; a read fault throws.
	 */
	linkRequestSlot(): DurableSlot;
	/**
	 * The slot `AppRecommendationStore` (`@serfab/cadre-rn/app-link`) keeps the apps the user allowed
	 * to join before they asked in, beside the saved start. Works with no node running, as
	 * `linkRequestSlot` does; a read fault throws.
	 */
	recommendationSlot(): DurableSlot;
	/**
	 * The node-local database as a key-value store, for records the app keeps beside the saved
	 * start under keys of its own: `rentalStore` (`@serfab/cadre-rn/provider`) files the provider
	 * rentals here, under `rentalsKvKey(partyId)`. Works with no node running, as
	 * `linkRequestSlot` does; a read fault throws. Keys of the form `<record>.<partyId>` are the
	 * kit's; an app's own records take a dot-free key.
	 */
	nodeLocalRecords(): KvStoreApi;
	/**
	 * Subscribe to a node event for the life of this phone node, not of one `CadreNode`: the
	 * handler is re-applied to every node a start or restart builds, before it starts. Register the
	 * `strand:discovered` handler that attaches strands here, before `start` — strands joined from
	 * another party come back through it after every start. Returns an unsubscribe.
	 */
	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void;
	onStatus(listener: (status: PhoneNodeStatus) => void): () => void;
	/**
	 * The public key (base64url) of the owner key the running node signs with, for pairing and
	 * approval prompts: the owner slot's, or on a joined party the identity key an owner-granting
	 * invitation seated. Null unless running with one wired. Never private material.
	 */
	ownerPublicKey(): string | null;
	/**
	 * The cadre's live owner keys (cadre-core's `CadreNode.listOwnerKeys`): label, voucher, whether
	 * this app holds it and whether this phone trusts it. In turn with start, stop and join, as are
	 * the calls below; this one and every other that names the node throws while none is running.
	 */
	listOwnerKeys(): Promise<CadreOwnerKey[]>;
	/**
	 * Make a backup owner key: seat a new key as an owner under `options.label`, signed by this
	 * app's owner key, and return its export, optionally locked with `options.passphrase`. Nothing
	 * is kept on the phone, so the app shows or saves `exportText` once. Throws cadre-core's
	 * `OwnerKeyAddRefusedError` `alone` while the phone has no connection to a cadre with other machines.
	 */
	addBackupOwnerKey(options?: OwnerKeyExportOptions): Promise<BackupOwnerKey>;
	/**
	 * This app's own owner key, from the secure store's owner slot, as export text. Works with no
	 * node running. Throws when the slot is empty: a member, or an owner through the identity key
	 * an owner-granting invitation seated, holds no key of its own.
	 */
	exportOwnerKey(options?: OwnerKeyExportOptions): Promise<string>;
	/**
	 * Import owner-key text into the owner slot, unlocking it with `passphrase` when it is locked.
	 * With a node running, the key is wired when the party lists it as a live owner (`wired`, and
	 * `status.owner` becomes `enrolled`); stored otherwise, and wired by a later start once an owner
	 * adds it. Works with no node running. Refused with `OwnerKeySlotOccupiedError` when the slot
	 * holds a different key (one owner key per app), and with `OwnerKeyExportError` for text that
	 * is not an owner key, a locked one with no passphrase (`passphrase-required`) or the wrong
	 * passphrase. A strand move waiting on an owner key is adopted by the next start or
	 * `finishStrandMove()`.
	 */
	importOwnerKey(text: string, passphrase?: string): Promise<ImportedOwnerKey>;
	/** What `removeOwner(key)` would do, for the confirmation step (cadre-core's `CadreNode.planOwnerKeyRemoval`). */
	planOwnerKeyRemoval(key: string): Promise<OwnerKeyRemovalPlan>;
	/** Remove an owner key, re-vouching first the dependents `options.revouch` keeps (cadre-core's `CadreNode.removeOwner`). */
	removeOwner(key: string, options?: RemoveOwnerOptions): Promise<OwnerKeyRemovalResult>;
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
	if (existing && ['starting', 'joining', 'running'].includes(existing.status.state)) {
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
	private readonly moves: StrandMoveRecords;
	private current: CadreNode | null = null;
	private runningOptions: PhoneNodeOptions | null = null;
	private starting: Promise<CadreNode> | null = null;
	private stopping: Promise<void> | null = null;
	/** One per join called and not yet settled, so a stop can cancel them. */
	private readonly joins = new Set<AbortController>();
	/**
	 * Start, stop, restart, join and dissolve run one at a time, in call order: each opens or closes
	 * the databases the others use, so a start overlapping a stop would build on handles the stop then closes.
	 */
	private transitions: Promise<unknown> = Promise.resolve();
	private currentStatus: PhoneNodeStatus = { state: 'stopped' };
	/** Every database this node opened, by name, so `stop` can close them all. */
	private readonly databases = new Map<string, LevelDbHandle>();
	/**
	 * The one key-value store over the open node-local database. A write resolves into the store's
	 * write group before it reaches the database, so a second store over the same handle would
	 * neither read it back nor flush it. Closed, which flushes it, before the database is.
	 */
	private nodeLocalStore: LevelDBKVStore | null = null;
	private readonly subscriptions = new Set<Subscription>();
	private readonly statusListeners = new Set<(status: PhoneNodeStatus) => void>();

	constructor(
		private readonly platform: PhoneNodePlatform,
		private readonly names: PhoneNodeNames,
	) {
		this.keyStore = new SecureStoreKeyStore(platform.secureStore, platform.secureStoreOptions);
		this.moves = new StrandMoveRecords(this.keyStore);
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

	identityPeerId(): Promise<string> {
		const status = this.currentStatus;
		// A join may wait minutes for a member; the screen showing the join request must not wait with it.
		const peerId = status.state === 'running' || status.state === 'joining' ? status.node.peerId : undefined;
		if (peerId) return Promise.resolve(peerId.toString());
		return this.inTurn(async () => {
			const key = await loadOrCreateIdentityKey(this.keyStore, DEFAULT_IDENTITY_KEY_ID);
			// A public key's string form is its peer id's.
			return key.publicKey.toString();
		});
	}

	start(options: PhoneNodeOptions): Promise<CadreNode> {
		if (this.starting) return this.starting;
		return this.trackStart(() => (this.current?.isRunning ? Promise.resolve(this.current) : this.buildAndStart(options)));
	}

	stop(): Promise<void> {
		// A join can wait for a member until its invitation expires; the user's disconnect ends it.
		// NOTE: the cancelled join starts the party it left again, and only then does this stop
		// stop it. If that restart makes Disconnect noticeably slow, let a join cancelled by a stop
		// save the left start with `autoStart: false` and stay stopped instead.
		for (const join of this.joins) join.abort(new Error('the phone node was stopped during a join'));
		return this.trackStop(() => this.stopAndClearAutoStart());
	}

	restart(options: PhoneNodeOptions): Promise<CadreNode> {
		this.starting = null;
		return this.trackStart(async () => {
			await this.shutDown();
			return this.buildAndStart(options);
		});
	}

	joinCadre(invitation: CadreInvitation, options: JoinCadreOptions = {}): Promise<JoinCadreResult> {
		// A start called from here on runs after this join rather than joining a start it replaces.
		this.starting = null;
		const cancel = new AbortController();
		const release = relayAbort(options.signal, cancel);
		this.joins.add(cancel);
		const joining = this.inTurn(() => this.join(invitation, options, cancel.signal));
		const settled = (): void => {
			this.joins.delete(cancel);
			release();
		};
		joining.then(settled, settled);
		return joining;
	}

	async loadSavedStart(): Promise<SavedStart | undefined> {
		// A stop in progress decides `autoStart`: answer after it, so an unattended start does
		// not act on the value the stop is replacing. Its failure is its caller's.
		await this.stopping?.catch(() => undefined);
		return this.readSavedStart();
	}

	linkRequestSlot(): DurableSlot {
		return kvStoreSlot(this.nodeLocalRecords(), this.names.linkRequestKey);
	}

	recommendationSlot(): DurableSlot {
		return kvStoreSlot(this.nodeLocalRecords(), this.names.recommendationsKey);
	}

	/** The node-local database for a store the app keeps across stops and starts. */
	nodeLocalRecords(): KvStoreApi {
		// Each get and set looks the database up again: a stop closes the handle, and the store outlives the stop.
		const kv = async (): Promise<LevelDBKVStore> => {
			// Opening it while a stop is closing it would take a second lock on the same name.
			// NOTE: a restart, join or dissolve closes it too, with no `stopping` to wait on, so a
			// read in that short window can fail on the lock. If that is ever seen, track each shutdown as `stopping` is tracked.
			await this.stopping?.catch(() => undefined);
			return this.nodeLocalKv();
		};
		return {
			get: async (key) => (await kv()).get(key),
			set: async (key, value) => (await kv()).set(key, value),
			flush: async () => (await kv()).flush(),
		};
	}

	async pendingStrandMove(): Promise<PendingStrandMove | undefined> {
		const formerPartyId = (this.runningOptions ?? (await this.readSavedStart())?.options)?.formerPartyId;
		if (formerPartyId === undefined) return undefined;
		const record = await this.moves.load(formerPartyId);
		return record && pendingMove(record);
	}

	finishStrandMove(): Promise<StrandMoveReport | undefined> {
		return this.inTurn(async () => {
			const node = this.node;
			const formerPartyId = this.runningOptions?.formerPartyId;
			if (!node?.isRunning || formerPartyId === undefined) return undefined;
			const record = await this.moves.load(formerPartyId);
			if (record?.targetPartyId !== node.partyId) return undefined;
			const report = await adoptMoveRecord(node, this.moves, record);
			// The adoption wires the key or throws, so a start that settled as a member is an owner now.
			this.reportEnrolled(node);
			return report;
		});
	}

	dissolveFormerParty(options: DissolveFormerPartyOptions = {}): Promise<void> {
		// A start called from here on runs after this dissolve rather than joining a start whose node it stops.
		this.starting = null;
		return this.inTurn(() => this.dissolve(options.discard ?? []));
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
		return this.node?.getOwnerSigner()?.publicKey ?? null;
	}

	// ── owner keys ───────────────────────────────────────────────────────────
	// In turn with the transitions: genesis creates the owner slot's key inside a start, and the
	// slot's check-then-set must not race an import.

	listOwnerKeys(): Promise<CadreOwnerKey[]> {
		return this.onRunningNode((node) => node.listOwnerKeys());
	}

	addBackupOwnerKey(options: OwnerKeyExportOptions = {}): Promise<BackupOwnerKey> {
		return this.onRunningNode((node) => addBackupOwnerKey(node, options));
	}

	exportOwnerKey(options: OwnerKeyExportOptions = {}): Promise<string> {
		return this.inTurn(() => exportOwnerKey(this.keyStore, options));
	}

	importOwnerKey(text: string, passphrase?: string): Promise<ImportedOwnerKey> {
		return this.inTurn(async () => {
			const node = this.node?.isRunning ? this.node : null;
			const imported = await importOwnerKeyInto(this.keyStore, node, text, passphrase);
			if (imported.wired && node) this.reportEnrolled(node);
			return imported;
		});
	}

	planOwnerKeyRemoval(key: string): Promise<OwnerKeyRemovalPlan> {
		return this.onRunningNode((node) => node.planOwnerKeyRemoval(key));
	}

	removeOwner(key: string, options: RemoveOwnerOptions = {}): Promise<OwnerKeyRemovalResult> {
		return this.onRunningNode((node) => node.removeOwner(key, options));
	}

	/** Run `op` on the running node, in turn with start, stop and join; throws when none is running. */
	private onRunningNode<T>(op: (node: CadreNode) => Promise<T>): Promise<T> {
		return this.inTurn(async () => {
			const node = this.node;
			if (!node?.isRunning) throw new Error('The phone node is not running; start it first');
			return await op(node);
		});
	}

	/** A key was wired after the start settled: a start reported as a member is an owner now. */
	private reportEnrolled(node: CadreNode): void {
		if (this.currentStatus.state === 'running' && this.currentStatus.owner !== 'enrolled') {
			this.setStatus({ state: 'running', node, owner: 'enrolled' });
		}
	}

	// ── transitions ──────────────────────────────────────────────────────────

	/** Run `op` after every transition called before it, whether those succeeded or failed. */
	private inTurn<T>(op: () => Promise<T>): Promise<T> {
		const result = this.transitions.then(op);
		this.transitions = result.catch(() => undefined);
		return result;
	}

	/**
	 * Queue a transition that rewrites the saved start as it takes the node down (a stop, a
	 * removal), and let `loadSavedStart` and the app-link slots wait for it until it settles.
	 */
	private trackStop(op: () => Promise<void>): Promise<void> {
		// A start called from here on runs after this transition rather than joining the one it ends.
		this.starting = null;
		const stopping = this.inTurn(op);
		this.stopping = stopping;
		const settled = (): void => {
			if (this.stopping === stopping) this.stopping = null;
		};
		stopping.then(settled, settled);
		return stopping;
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
			const { node, resolved } = await this.bringUp(options);
			const owner = await this.settleOwnerKey(node, resolved);
			// Finishes a move a join left: the app was killed before adopting, or its key was wired
			// only now. A move record the secure store refuses to read fails the start.
			// NOTE: a pending move delays `running` by its control writes, a few per strand. If a
			// resumed move makes a start noticeably slow, adopt after `markRunning` instead, as a
			// transition of its own.
			if (owner === 'enrolled') await adoptMovesInto(node, this.moves);
			await this.markRunning(node, resolved, owner);
			return node;
		} catch (err) {
			// The start's own error is the one to report; a failure tearing down after it is only logged.
			await this.shutDown().catch((cleanupErr: unknown) => {
				console.warn('[cadre-rn/phone-node] cleaning up after a failed start failed:', cleanupErr);
			});
			const error = toError(err);
			this.setStatus({ state: 'failed', error });
			throw error;
		}
	}

	/** Build the node for `options`, every subscription attached, and start it, after finishing a begun dissolve. */
	private async bringUp(options: PhoneNodeOptions): Promise<{ node: CadreNode; resolved: PhoneNodeOptions }> {
		const dissolved = await finishRemovalAtStart(this.partyStorage());
		const resolved = withoutFormerParty(await this.resolveOptions(options), dissolved);
		const node = new CadreNode(await this.buildConfig(resolved));
		this.current = node;
		for (const subscription of this.subscriptions) subscription.attach(node);
		this.watchRemoval(node);
		await node.start();
		return { node, resolved };
	}

	/**
	 * Start a node for `options`' party only to run `read` on it, then stop it. Nothing subscribes,
	 * nothing is saved and no strand launches: the node never reports running. A join exports the
	 * strands of a stopped party this way, and a dissolve reads the party it removes.
	 */
	private async readAlone<T>(options: PhoneNodeOptions, read: (node: CadreNode) => Promise<T>, purpose: string): Promise<T> {
		this.setStatus({ state: 'starting' });
		try {
			const config = await this.buildConfig(await this.resolveOptions(options));
			const node = new CadreNode({ ...config, strandFilter: { mode: 'none' } });
			this.current = node;
			await node.start();
			return await read(node);
		} finally {
			// The read's own error, if any, is the one to report.
			await this.shutDown().catch((err: unknown) => {
				console.warn(`[cadre-rn/phone-node] stopping the node started to ${purpose} failed:`, err);
			});
		}
	}

	/** A founded party runs owner genesis; a joined one only wires a key the party already lists. */
	private settleOwnerKey(node: CadreNode, options: PhoneNodeOptions): Promise<OwnerGenesisResult> {
		if (options.origin === 'joined') return this.wireJoinedOwner(node, false);
		return runOwnerGenesis(node, { keyStore: this.keyStore, label: options.ownerKeyLabel, timeoutMs: this.platform.ownerGenesisTimeoutMs });
	}

	/** `granted`: a redemption has just granted owner, so wait for the row. */
	private wireJoinedOwner(node: CadreNode, granted: boolean): Promise<OwnerGenesisResult> {
		return wireJoinedOwnerKey(node, { keyStore: this.keyStore, timeoutMs: this.platform.ownerGenesisTimeoutMs, granted });
	}

	/** Report a node that came up, saving its options only now, so a failed start never replaces the last one that came up. */
	private async markRunning(node: CadreNode, resolved: PhoneNodeOptions, owner: OwnerGenesisResult): Promise<void> {
		await this.saveRunningStart(resolved);
		this.reportRunning(node, resolved, owner);
	}

	private saveRunningStart(resolved: PhoneNodeOptions): Promise<void> {
		return this.saveStart({ options: resolved, autoStart: true, writtenBy: this.platform.dataVersion });
	}

	private reportRunning(node: CadreNode, resolved: PhoneNodeOptions, owner: OwnerGenesisResult): void {
		this.runningOptions = resolved;
		this.setStatus({ state: 'running', node, owner });
	}

	/**
	 * The options as this start runs and saves them. The Noise mode is resolved, so a later
	 * build's default does not change a device that already ran. Options naming no `origin`
	 * take the saved start's `origin` and `formerPartyId` when it is for the same party, so a
	 * party this app joined, started again from a hand-typed party id, does not run owner genesis.
	 */
	private async resolveOptions(options: PhoneNodeOptions): Promise<PhoneNodeOptions> {
		requireOwnerKeyLabel(options.ownerKeyLabel);
		const resolved = { ...options };
		const defaultMode = this.platform.noiseCrypto?.defaultMode;
		if (resolved.noiseCryptoMode === undefined && defaultMode !== undefined) resolved.noiseCryptoMode = defaultMode;
		if (resolved.origin === undefined) {
			const saved = (await this.readSavedStart())?.options;
			if (saved?.partyId === resolved.partyId) {
				if (saved.origin !== undefined) resolved.origin = saved.origin;
				if (saved.formerPartyId !== undefined) resolved.formerPartyId = saved.formerPartyId;
			}
		}
		return resolved;
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

	// ── join ─────────────────────────────────────────────────────────────────
	// NOTE: this file is about 1300 lines (`wc -l`), the join and its strand move the largest part,
	// the dissolve's and the removal's transitions next (the storage they delete is in `dissolve.ts`),
	// then the owner-key pass-throughs. If any of them grows further, move it to a module of its own
	// over a narrow view of this runtime.

	private async join(invitation: CadreInvitation, options: JoinCadreOptions, signal: AbortSignal): Promise<JoinCadreResult> {
		signal.throwIfAborted();
		const running = this.node;
		if (running?.isRunning && this.runningOptions?.partyId === invitation.partyId) {
			return this.redeemInPlace(running, this.runningOptions, invitation, options, signal);
		}
		return this.switchParty(invitation, options, signal);
	}

	/** Redeem on the node already running in the invitation's party; nothing to switch or roll back. */
	private async redeemInPlace(
		node: CadreNode,
		running: PhoneNodeOptions,
		invitation: CadreInvitation,
		options: JoinCadreOptions,
		signal: AbortSignal,
	): Promise<JoinCadreResult> {
		const redemption = await node.redeemCadreInvitation(invitation, redeemOptions(options, signal));
		reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
		const owner = await this.wireJoinedOwner(node, redemption.grantsOwner);
		// An owner grant arriving by a second invitation finishes a move an earlier join deferred.
		const strandMove = await this.settleJoinMove(node, running.formerPartyId, owner);
		if (owner === 'enrolled') this.setStatus({ state: 'running', node, owner });
		return joinResult(redemption, running.formerPartyId, strandMove);
	}

	/**
	 * Stop the running node, start one in the invitation's party and redeem there; on any
	 * failure, go back to what ran before. Nothing is saved until a member has admitted this app.
	 * Leaving a party this app founded, its strands are recorded for the move first, so a refusal
	 * leaves that party running and unchanged.
	 */
	private async switchParty(invitation: CadreInvitation, options: JoinCadreOptions, signal: AbortSignal): Promise<JoinCadreResult> {
		const restore = this.runningOptions;
		const leaving = restore ?? (await this.readSavedStart())?.options ?? null;
		const founded = foundedPartyLeft(invitation.partyId, leaving);
		// The party this app founded, carried through any later join.
		// NOTE: leaving a joined party while the move from `formerPartyId` into it is still pending
		// (the key never wired as an owner there) leaves that record naming the party left, adopted
		// only if the app goes back; `pendingStrandMove` keeps reporting it. If apps need the move
		// to follow the app, retarget the record to the invitation's party here.
		const formerPartyId = founded?.partyId ?? leaving?.formerPartyId;
		const joined: PhoneNodeOptions = {
			partyId: invitation.partyId,
			// None needed: the redemption retains the member that admits this app as a dial
			// target in the party's bootstrap-peer store, which every later start reads.
			bootstrapAddrs: [],
			relayAddrs: options.relayAddrs ?? leaving?.relayAddrs ?? [],
			origin: 'joined',
		};
		const noiseCryptoMode = options.noiseCryptoMode ?? leaving?.noiseCryptoMode;
		if (noiseCryptoMode !== undefined) joined.noiseCryptoMode = noiseCryptoMode;
		if (formerPartyId !== undefined) joined.formerPartyId = formerPartyId;
		const movingFrom = founded ? await this.recordStrandMove(founded, invitation) : undefined;
		try {
			await this.shutDown();
			return await this.startAndRedeem(joined, invitation, options, signal, movingFrom);
		} catch (err) {
			await this.returnToLeftParty(restore, movingFrom);
			throw err;
		}
	}

	/**
	 * Export the founded party's strands and keep them in the secure store for the joined party to
	 * adopt; the party's id when there was anything to move. Throws `StrandsNeedOwnerJoinError`, or
	 * the export's or the write's error: switching without the record would lose the strands.
	 * An empty export removes the party's record instead: one left by an earlier join that never
	 * finished describes strands the party no longer holds, and adopting it would bring them back.
	 */
	private async recordStrandMove(founded: PhoneNodeOptions, invitation: CadreInvitation): Promise<string | undefined> {
		const running = this.node;
		const bundle = running?.isRunning ? await exportStrandBundle(running) : await this.readAlone(founded, exportStrandBundle, 'export strands');
		const record = joinMoveRecord(bundle, invitation);
		if (!record) {
			await this.moves.remove(founded.partyId);
			return undefined;
		}
		await this.moves.save(record);
		return founded.partyId;
	}

	/**
	 * Admitted, the start is saved before the strands are adopted, so an app killed mid-adoption
	 * relaunches into the joined party and finishes the move there; `running` is reported after.
	 */
	private async startAndRedeem(
		joined: PhoneNodeOptions,
		invitation: CadreInvitation,
		options: JoinCadreOptions,
		signal: AbortSignal,
		movingFrom: string | undefined,
	): Promise<JoinCadreResult> {
		this.setStatus({ state: 'starting' });
		const { node, resolved } = await this.bringUp(joined);
		this.setStatus({ state: 'joining', node });
		const redemption = await node.redeemCadreInvitation(invitation, redeemOptions(options, signal));
		reportProgress(options, { state: 'admitted', grantsOwner: redemption.grantsOwner });
		const owner = await this.wireJoinedOwner(node, redemption.grantsOwner);
		await this.saveRunningStart(resolved);
		if (movingFrom !== undefined && owner === 'enrolled') reportProgress(options, { state: 'moving-strands' });
		const strandMove = await this.settleJoinMove(node, resolved.formerPartyId, owner);
		this.reportRunning(node, resolved, owner);
		return joinResult(redemption, resolved.formerPartyId, strandMove);
	}

	/**
	 * The move from `formerPartyId` as an admitted join reports it: adopted with every other move
	 * naming this party once the app's key is wired as its owner, deferred otherwise. Never throws:
	 * the app is admitted, and what is not adopted now is adopted by the next start.
	 */
	private async settleJoinMove(
		node: CadreNode,
		formerPartyId: string | undefined,
		owner: OwnerGenesisResult,
	): Promise<StrandMoveOutcome | undefined> {
		try {
			if (owner === 'enrolled') {
				const outcomes = await adoptMovesInto(node, this.moves);
				return formerPartyId === undefined ? undefined : outcomes.get(formerPartyId);
			}
			const record = formerPartyId === undefined ? undefined : await this.moves.load(formerPartyId);
			return record?.targetPartyId === node.partyId ? { state: 'deferred', reason: 'owner-key-not-wired' } : undefined;
		} catch (err) {
			console.warn('[cadre-rn/phone-node] reading the strand move records failed; the next start retries:', err);
			return formerPartyId === undefined ? undefined : deferredOutcome(err);
		}
	}

	/**
	 * After a failed join: discard the move record it wrote, stop the joined party's node and start
	 * again what ran before, if anything did.
	 */
	private async returnToLeftParty(restore: PhoneNodeOptions | null, movingFrom: string | undefined): Promise<void> {
		await this.discardStrandMove(movingFrom);
		try {
			await this.shutDown();
			if (restore) await this.buildAndStart(restore);
		} catch (err) {
			// The join's own error is the one its caller gets; this one is only logged.
			console.warn('[cadre-rn/phone-node] going back to the party a failed join left failed:', err);
			if (this.currentStatus.state !== 'failed') this.setStatus({ state: 'failed', error: toError(err) });
		}
	}

	private async discardStrandMove(fromPartyId: string | undefined): Promise<void> {
		if (fromPartyId === undefined) return;
		try {
			await this.moves.remove(fromPartyId);
		} catch (err) {
			// Harmless when left: it names the party the join failed to reach, and the next join from
			// this party replaces it.
			console.warn(`[cadre-rn/phone-node] could not discard the strand move record of party ${fromPartyId}:`, err);
		}
	}

	// ── dissolve ─────────────────────────────────────────────────────────────

	/** docs/architecture.md → "Dissolving the party it left". */
	private async dissolve(discard: readonly string[]): Promise<void> {
		await finishMarkedRemoval(this.partyStorage());
		const { node, running, formerPartyId } = this.runningWithFormerParty();
		const record = await this.moves.load(formerPartyId);
		if (record) throw new StrandMovePendingError(pendingMove(record));
		const holdings = await readStrandHoldings(node);
		try {
			await this.shutDown();
			const content = await this.readAlone(formerPartyRead(formerPartyId, running), readFormerParty, 'read the party it left');
			const refusal = formerPartyRefusal(content, holdings, discard, Date.now());
			if (refusal) throw refusal;
			await removeParty(this.partyStorage(), formerPartyId);
		} catch (err) {
			await this.startAgainAfterDissolve(running);
			throw err;
		}
		await this.buildAndStart(withoutFormerParty(running, formerPartyId));
	}

	private runningWithFormerParty(): { node: CadreNode; running: PhoneNodeOptions; formerPartyId: string } {
		const node = this.node;
		const running = this.runningOptions;
		const formerPartyId = running?.formerPartyId;
		if (!node?.isRunning || !running || formerPartyId === undefined) {
			throw new Error('Nothing to dissolve: the phone node is not running with a former party, one this app founded and left');
		}
		// Only a hand-built start names its own party; dissolving it would delete the running party's control database.
		if (formerPartyId === running.partyId) {
			throw new Error(`Cannot dissolve party ${formerPartyId}: it is the running party, not one this app left`);
		}
		return { node, running, formerPartyId };
	}

	/** After a refused or failed dissolve. The dissolve's own error is the one its caller gets; this one is only logged. */
	private async startAgainAfterDissolve(running: PhoneNodeOptions): Promise<void> {
		try {
			await this.buildAndStart(running);
		} catch (err) {
			console.warn('[cadre-rn/phone-node] starting the running party again after a dissolve failed:', err);
		}
	}

	// ── removal ──────────────────────────────────────────────────────────────

	/**
	 * Answer `node` reporting that an owner removed this app from its party
	 * ({@link forgetRemovedParty}). Attached before the node starts, so no report comes before it
	 * and `removedFromCadre()` has nothing to add; never detached, so a report raised while the
	 * node stops, which it made while running, is still answered.
	 *
	 * NOTE: a phone removed while its app was not running never sees its own row live after the
	 * next start, so it never reports (docs/architecture.md → "The removed machine learns it"), and
	 * keeps the party's data while every other machine refuses it. If users meet this, persist
	 * "seen live" per party so the rule survives a restart.
	 */
	private watchRemoval(node: CadreNode): void {
		node.on('cadre:removed', (removal) => {
			void this.trackStop(() => this.forgetRemovedParty(removal));
		});
	}

	/**
	 * In turn with start, stop and join: stop the removed party's node, point the saved start away
	 * from that party, delete its local storage and report `removed`. A node of another party, started
	 * by a join that ran before this turn, keeps running; only the removed party's storage goes.
	 * Nothing starts unattended afterwards: the user sees why the app left its cadre first. A
	 * failure is logged and leaves `status` `failed`; never rejects.
	 *
	 * NOTE: `start` does not refuse the removed party's options, so an app that cached them builds
	 * that party again on empty storage. If one is seen doing so, refuse a start of `partyId` while
	 * `status` is `removed`.
	 */
	private async forgetRemovedParty(removal: CadreRemoval): Promise<void> {
		const { partyId } = removal;
		try {
			if (this.current !== null && this.current.partyId !== partyId) {
				await this.removeLocalParty(partyId);
				if (this.runningOptions) this.runningOptions = withoutFormerParty(this.runningOptions, partyId);
				return;
			}
			await this.shutDown().catch((err: unknown) => {
				// `shutDown` has closed every database and dropped the node whether or not its stop threw.
				console.warn(`[cadre-rn/phone-node] stopping the node of party ${partyId}, which removed this app, failed:`, err);
			});
			const formerPartyId = await this.leaveRemovedStart(partyId);
			await this.removeLocalParty(partyId);
			this.setStatus({ state: 'removed', partyId, removal, ...(formerPartyId !== undefined && { formerPartyId }) });
		} catch (err) {
			console.warn(`[cadre-rn/phone-node] acting on this app's removal from party ${partyId} failed:`, err);
			this.setStatus({ state: 'failed', error: toError(err) });
		}
	}

	/**
	 * Replace a saved start of `partyId` with {@link startAfterRemoval}'s, or delete it, before any
	 * of the party's storage goes, so no start builds that party again on deleted storage; returns
	 * the former party the new start names. A saved start of another party is left alone. Throws a
	 * failed read or write, and the storage then stays, matching the saved start that still names it.
	 */
	private async leaveRemovedStart(partyId: string): Promise<string | undefined> {
		const saved = await this.readSavedStart();
		if (saved?.options.partyId !== partyId) return undefined;
		const next = startAfterRemoval(saved);
		if (next) await this.nodeLocalSlot(this.names.savedStartKey).save(serializeSavedStart(next));
		else await this.deleteSavedStart();
		return next?.options.partyId;
	}

	/**
	 * Delete `partyId`'s local storage with the dissolve's marked removal, after finishing one a
	 * failure left, so this marker does not replace it. A failure is logged: once the marker is
	 * written, the next start finishes the removal.
	 */
	private async removeLocalParty(partyId: string): Promise<void> {
		const storage = this.partyStorage();
		try {
			await finishMarkedRemoval(storage);
			await removeParty(storage, partyId);
		} catch (err) {
			console.warn(`[cadre-rn/phone-node] deleting the storage of party ${partyId}, which removed this app, failed:`, err);
		}
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
		const store = this.nodeLocalStore;
		this.nodeLocalStore = null;
		const open = [...this.databases.values()];
		this.databases.clear();
		try {
			await store?.close();
		} catch (err) {
			console.warn('[cadre-rn/phone-node] closing the node-local store failed:', err);
		}
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
			const { openFn, WriteBatch } = this.platform.leveldb;
			db = openOptimysticRNDb({ openFn, WriteBatch, name });
			this.databases.set(name, db);
		}
		return db;
	}

	private nodeLocalKv(): LevelDBKVStore {
		this.nodeLocalStore ??= new LevelDBKVStore(this.database(this.names.nodeLocalDb), this.names.nodeLocalKvPrefix);
		return this.nodeLocalStore;
	}

	private nodeLocalSlot(key: string): DurableSlot {
		return kvStoreSlot(this.nodeLocalKv(), key);
	}

	private partyStorage(): PartyStorage {
		return {
			nodeLocal: this.nodeLocalKv(),
			markerKey: this.names.dissolveMarkerKey,
			savedStartKey: this.names.savedStartKey,
			storagePrefix: this.names.storagePrefix,
			destroyDatabase: (name) => this.platform.leveldb.destroy(name),
			secureStore: this.platform.secureStore,
			secureStoreOptions: this.platform.secureStoreOptions,
			keyStore: this.keyStore,
			moves: this.moves,
		};
	}

	/** The saved start, read directly: inside a transition, `loadSavedStart` would wait on a stop queued behind it. */
	private async readSavedStart(): Promise<SavedStart | undefined> {
		return parseSavedStart(await this.nodeLocalSlot(this.names.savedStartKey).load());
	}

	/** Delete the saved start, durably; a failed write throws. */
	private async deleteSavedStart(): Promise<void> {
		const kv = this.nodeLocalKv();
		await kv.delete(this.names.savedStartKey);
		await kv.flush();
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

function toError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

/** Abort `target` with `source`'s reason when `source` aborts; returns the unsubscribe. */
function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	const abort = (): void => target.abort(source.reason);
	if (source.aborted) {
		abort();
		return () => {};
	}
	source.addEventListener('abort', abort, { once: true });
	return () => source.removeEventListener('abort', abort);
}

/** Wait for a member: a phone joining by invitation is often the only machine of the party up. */
function redeemOptions(options: JoinCadreOptions, signal: AbortSignal): RedeemCadreInvitationOptions {
	return { waitForMember: true, signal, ...(options.onProgress ? { onProgress: options.onProgress } : {}) };
}

/** Tell the join's listener; one that throws must not fail a join a member has already admitted. */
function reportProgress(options: JoinCadreOptions, progress: PhoneJoinProgress): void {
	try {
		options.onProgress?.(progress);
	} catch (err) {
		console.warn('[cadre-rn/phone-node] join progress listener threw:', err);
	}
}

/**
 * The start a join to `partyId` leaves, when it is of a party this app founded: the party whose
 * strands move and which is kept as `formerPartyId` for clean-up. Null when the join leaves no
 * start, a party this app joined, or the party it joins.
 */
function foundedPartyLeft(partyId: string, leaving: PhoneNodeOptions | null): PhoneNodeOptions | null {
	return leaving && leaving.origin !== 'joined' && leaving.partyId !== partyId ? leaving : null;
}

function joinResult(
	redemption: RedeemCadreInvitationResult,
	formerPartyId: string | undefined,
	strandMove: StrandMoveOutcome | undefined,
): JoinCadreResult {
	return {
		...redemption,
		...(formerPartyId !== undefined && { formerPartyId }),
		...(strandMove !== undefined && { strandMove }),
	};
}

/** WebSockets to dial the party's machines and relays, and circuit relay to be reachable through one. */
function defaultTransports(): Libp2pTransports {
	return [webSockets(), circuitRelayTransport()];
}
