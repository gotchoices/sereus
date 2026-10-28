/**
 * `createEdgeNode` — build, start, stop and rebuild an edge device's `CadreNode` the prescribed
 * way: identity and owner key in the app's key store, the four node-local stores durable and
 * party-scoped, raw storage per scope from the app's storage, owner genesis, the last start
 * remembered for unattended starts, and the switch to another party's cadre by machine
 * invitation or owner grant.
 *
 * Nothing platform-specific is imported here. The app passes in its key store, its storage and
 * its transports (`EdgeNodePlatform`), so a Node test runs this code over fakes, and the React
 * Native kit's `createPhoneNode` is this over the secure store and rn-leveldb.
 */

import { CadreNode } from '../cadre-node.js';
import { DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../key-store.js';
import { loadOrCreateIdentityKey } from '../identity-key.js';
import { exportOwnerKey, importOwnerKeyInto } from '../owner-key-flows.js';
import type { ExportedOwnerKey, ImportedOwnerKey, OwnerKeyExportOptions } from '../owner-key-flows.js';
import { createOwnerKey, loadOwnerSigner } from '../owner-key-store.js';
import type { OwnerSigner } from '../owner-signer.js';
import { PersistentBootstrapPeerStore } from '../bootstrap-peer-store.js';
import { PersistentEnrolledMachineStore } from '../enrolled-machine-store.js';
import { PersistentStrandNetworkStateStore } from '../strand-network-state.js';
import { PersistentTrustedOwnerStore } from '../trusted-owner-store.js';
import { readStrandHoldings, type StrandMoveReport } from '../strand-move.js';
import type { DurableSlot } from '../node-local-snapshot.js';
import type {
	CadreJoinProgress,
	CadreNodeConfig,
	CadreNodeEvents,
	CadreOwnerKey,
	CadreRemoval,
	CreateOwnerGrantOptions,
	CreateOwnerGrantResult,
	OwnerGrantStatus,
	OwnerKeyRemovalPlan,
	OwnerKeyRemovalResult,
	RedeemCadreInvitationResult,
	RemoveOwnerOptions,
} from '../types.js';
import type { Libp2pTransports, NoiseCryptoInterface } from '@optimystic/db-p2p';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webSockets } from '@libp2p/websockets';
import { buildEdgeNodeConfig, requireOwnerKeyLabel, runOwnerGenesis, wireJoinedOwnerKey, type OwnerGenesisResult } from './config.js';
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
	type RemovalAtStart,
} from './dissolve.js';
import { joinCadre, type JoinRuntime } from './edge-join.js';
import type { JoinCredential } from './join-credential.js';
import {
	bootstrapPeersKvKey,
	enrolledMachinesKvKey,
	kvStoreSlot,
	strandNetworkKvKey,
	trustedOwnersKvKey,
	type KvStoreApi,
	type NodeLocalKv,
} from './node-local.js';
import { parseSavedStart, serializeSavedStart, startAfterRemoval, type EdgeNodeOptions, type NoiseCryptoMode, type SavedStart } from './options.js';
import { redeemOwnerGrantText, type OwnerGrantRuntime, type RedeemedOwnerGrant } from './owner-grant.js';
import { DEFAULT_EDGE_NODE_NAMES, type EdgeNodeNames, type EdgeNodePlatform, type RemovableSlot } from './platform.js';
import { adoptMoveRecord, adoptMovesInto, pendingMove, StrandMoveRecords, toError, type PendingStrandMove, type StrandMoveOutcome } from './strand-move.js';

export type EdgeNodeStatus =
	| { state: 'stopped' }
	| { state: 'starting' }
	/** Started in the party an invitation names and redeeming it there; not admitted yet, so `EdgeNode.node` is null. */
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
export type EdgeJoinProgress =
	| CadreJoinProgress
	/**
	 * A member admitted the app; the edge node is wiring its owner key and saving the start.
	 * `asOwner`: the app joined with an owner grant, so its owner slot's key is an owner of the party.
	 */
	| { state: 'admitted'; asOwner: boolean }
	/** The app's key is wired as an owner and the strands this join recorded are being adopted. */
	| { state: 'moving-strands' };

/** How {@link EdgeNode.joinCadre} runs. */
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
	onProgress?: (progress: EdgeJoinProgress) => void;
}

/** What an admitted {@link EdgeNode.joinCadre} returns. */
export interface JoinCadreResult extends RedeemCadreInvitationResult {
	/** The app joined with an owner grant: its owner slot's key is an owner of the party (`status.owner` says whether it is wired). */
	asOwner: boolean;
	/** The party this app founded and has left, when it founded one; saved as `EdgeNodeOptions.formerPartyId`. */
	formerPartyId?: string;
	/** How moving that party's strands into this one settled; absent when there was nothing to move. */
	strandMove?: StrandMoveOutcome;
}

/** A removal a dissolve marker names that the last start tried to finish and could not: {@link EdgeNode.unfinishedRemoval}. */
export interface UnfinishedRemoval {
	partyId: string;
	error: Error;
}

export interface EdgeNode {
	readonly status: EdgeNodeStatus;
	/** The running node, or null; null as soon as a stop or restart begins tearing it down, and while joining. */
	readonly node: CadreNode | null;
	/** The options the running node was started with, the Noise mode resolved; null unless running. */
	readonly options: EdgeNodeOptions | null;
	/**
	 * The removal the dissolve marker names that the last start tried to finish and could not
	 * (logged there too), for an app to show; null when the last start found no marker or finished
	 * it, or a dissolve or removal since finished it. The next start retries.
	 */
	readonly unfinishedRemoval: UnfinishedRemoval | null;
	/**
	 * This app's peer id, the same in every party: the node's while one is running or joining,
	 * answered at once; otherwise read from the key store, created there when absent, in turn
	 * with start, stop and join so a first start cannot generate a different key. A read the
	 * key store refuses throws.
	 */
	identityPeerId(): Promise<string>;
	/**
	 * Start, or join the start in flight; a running node is returned as is, whatever its options.
	 * A start called during a stop or restart runs after it. Opens the four node-local stores
	 * party-scoped, builds and starts the node, runs owner genesis (fail-soft, bounded), then saves
	 * the options with `autoStart: true`. A failed start closes everything it opened and leaves
	 * `status` `failed`; the next call starts afresh.
	 */
	start(options: EdgeNodeOptions): Promise<CadreNode>;
	/**
	 * The user's "disconnect": waits for a start in flight, saves `autoStart: false` so nothing
	 * starts the node unattended, stops it, and closes every store it opened — control, each
	 * strand, node-local — through `EdgeNodeStorage.close`. A platform that locks a store per
	 * name (rn-leveldb) would otherwise fail the next start on one left open.
	 */
	stop(): Promise<void>;
	/**
	 * Rebuild the node with new options (relays, Noise mode): libp2p reads them only when the node
	 * is built. `autoStart` is not cleared on the way, so a crash mid-restart still starts again.
	 */
	restart(options: EdgeNodeOptions): Promise<CadreNode>;
	/**
	 * Join the cadre `credential` names: this app's one node moves to that party, keeping its
	 * identity, so the peer id an owner targeted is the one that redeems. A machine invitation
	 * admits the app as a machine; an owner grant makes it a machine and an owner at once
	 * (`CadreNode.joinWithOwnerGrant`), seating the owner slot's key, created when the slot is
	 * empty, which is how an app brings the strands of the party it founded along. Runs in turn
	 * with start, stop and restart; a start called meanwhile runs after it, and a `stop` cancels it.
	 *
	 * Already running in that party: redeems on the running node (a device already admitted is
	 * answered as such; an owner grant is redeemed for the slot's key, `CadreNode.redeemOwnerGrant`)
	 * and wires its owner key. Otherwise: stops the running node, starts one for the credential's
	 * party with `origin: 'joined'` (status `joining`), and redeems there, waiting for a member to
	 * answer until one accepts, one refuses, the credential expires (`invite-spent`,
	 * `grant-spent`) or `options.signal` aborts. Admitted: wires the owner key when the party
	 * lists the slot's key (after an owner grant, asking again until its row arrives or the
	 * owner-step bound passes), saves the start (`autoStart: true`) and reports `running`.
	 * Anything else: stops that node, starts again what was running before (a node that was
	 * stopped stays stopped), and throws the join's error; a failure restarting is logged and
	 * leaves status `failed`.
	 *
	 * The start is saved only once admitted, so an app killed while waiting relaunches into the
	 * party it left. The left party's data stays on disk under its own names.
	 *
	 * Leaving a party this app founded moves its strands: they are exported before anything stops
	 * (from a node started for the export alone when none runs) and kept in the key store, and
	 * adopted once the app's key is wired as an owner of the joined party, before the join reports
	 * `running`; otherwise a later start adopts them (`result.strandMove` says which). Refused
	 * before anything stops, with `StrandsNeedOwnerJoinError`, when there is something to move and
	 * the credential is a machine invitation; and with the export's error when it fails.
	 */
	joinCadre(credential: JoinCredential, options?: JoinCadreOptions): Promise<JoinCadreResult>;
	/**
	 * The move from `formerPartyId` (the running start's, else the saved one's) still waiting to be
	 * adopted, or `undefined` when there is none. A read the key store refuses throws.
	 */
	pendingStrandMove(): Promise<PendingStrandMove | undefined>;
	/**
	 * Adopt the waiting move on the running node now, in turn with start, stop and join; `undefined`
	 * when no move from `formerPartyId` names the running party. On a joined party with no owner
	 * signer wired, first asks the party once more whether it lists the owner slot's key, so an
	 * owner grant whose row arrived after the join stopped waiting is picked up here,
	 * `status.owner` becoming `enrolled`. Throws what the adoption throws,
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
	 * the edge node's response to a removal, after that has replaced the saved start.
	 */
	loadSavedStart(): Promise<SavedStart | undefined>;
	/**
	 * The slot `LinkRequestStore` (`@serfab/cadre-rn/app-link`) keeps the open link join request in,
	 * beside the saved start in the node-local store. Works with no node running, as
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
	 * The node-local store as a key-value store, for records the app keeps beside the saved start
	 * under keys of its own: `rentalStore` (`@serfab/cadre-rn/provider`) files the provider rentals
	 * here, under `rentalsKvKey(partyId)`. Works with no node running, as `linkRequestSlot` does; a
	 * read fault throws. Keys of the form `<record>.<partyId>` are the edge node's; an app's own
	 * records take a dot-free key.
	 */
	nodeLocalRecords(): KvStoreApi;
	/**
	 * Subscribe to a node event for the life of this edge node, not of one `CadreNode`: the
	 * handler is re-applied to every node a start or restart builds, before it starts. Register the
	 * `strand:discovered` handler that attaches strands here, before `start` — strands joined from
	 * another party come back through it after every start. Returns an unsubscribe.
	 */
	on<K extends keyof CadreNodeEvents>(event: K, handler: (data: CadreNodeEvents[K]) => void): () => void;
	onStatus(listener: (status: EdgeNodeStatus) => void): () => void;
	/**
	 * The public key (base64url) of the owner key the running node signs with, for pairing and
	 * approval prompts: the owner slot's key. Null unless running with it wired. Never private
	 * material.
	 */
	ownerPublicKey(): string | null;
	/**
	 * The cadre's live owner keys (cadre-core's `CadreNode.listOwnerKeys`): label, voucher, whether
	 * this app holds it and whether this device trusts it. In turn with start, stop and join, as are
	 * the calls below; this one and every other that names the node throws while none is running.
	 */
	listOwnerKeys(): Promise<CadreOwnerKey[]>;
	/**
	 * This app's own owner key, from the key store's owner slot, which is the key the node signs
	 * with, as export text, with the key it holds (`publicKey`). Works with no node running. Throws
	 * when the slot is empty: a member holds no owner key of its own.
	 */
	exportOwnerKey(options?: OwnerKeyExportOptions): Promise<ExportedOwnerKey>;
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
	/**
	 * Mint an owner grant (cadre-core's `CadreNode.createOwnerGrant`): whoever redeems the
	 * returned text first becomes an owner of the cadre. 15 minutes and one use by default;
	 * `expiresInMs: null` is a backup grant, with no expiry.
	 */
	createOwnerGrant(options?: CreateOwnerGrantOptions): Promise<CreateOwnerGrantResult>;
	/** Every owner grant the running node holds, with its standing (cadre-core's `CadreNode.listOwnerGrants`). */
	listOwnerGrants(): Promise<OwnerGrantStatus[]>;
	/** Withdraw an owner grant by its key (cadre-core's `CadreNode.withdrawOwnerGrant`); false when it is not held here or was already withdrawn. */
	withdrawOwnerGrant(key: string): Promise<boolean>;
	/**
	 * Become an owner of the running party with owner-grant text: the owner slot's key, created
	 * when the slot is empty, is seated (cadre-core's `CadreNode.redeemOwnerGrant`) and wired, and
	 * `status.owner` becomes `enrolled`. A slot key that is already a live owner of the party is
	 * answered `alreadyOwner` before anything is signed or written, connected or not. A member
	 * machine writes the row in its own store and wires the key at once; any other node redeems
	 * at the grant's members and asks for the row until the owner-step bound passes (`wired:
	 * false` then, and a later start wires it). A strand move waiting on an owner key is adopted
	 * by the next start or `finishStrandMove()`.
	 *
	 * Refused with the decoder's error for text that is not an owner grant (an owner key, an
	 * invitation and a join request are named), with `OwnerGrantRejectedError` `party-mismatch`
	 * for a grant of another party, and with what `CadreNode.redeemOwnerGrant` throws:
	 * `OwnerKeyAddRefusedError` `alone` on a member with no connection to the party's other
	 * machines, `OwnerGrantRejectedError` (`grant-spent` for an expired, withdrawn or used grant),
	 * `OwnerGrantIssuerUnknownError`, `OwnerGrantUnreachableError`.
	 */
	redeemOwnerGrant(text: string): Promise<RedeemedOwnerGrant>;
}

/** One handler, closed over its event, so re-applying it to a new node needs no cast. */
interface Subscription {
	attach(node: CadreNode): void;
	detach(node: CadreNode): void;
}

/** Edge nodes by storage id: two over the same storage would share databases and an identity. */
const edgeNodes = new Map<string, EdgeNode>();

/**
 * Create the app's edge node. Call once per app. Throws when an edge node over the same storage
 * (`platform.storage.id`) is starting or running in this process; a stopped or failed one is
 * replaced (a development reload re-runs the module that calls this).
 */
export function createEdgeNode(platform: EdgeNodePlatform): EdgeNode {
	const id = platform.storage.id;
	const existing = edgeNodes.get(id);
	if (existing && ['starting', 'joining', 'running'].includes(existing.status.state)) {
		throw new Error(`an edge node over storage '${id}' is already ${existing.status.state}; create one per app and share it`);
	}
	const created = new EdgeNodeRuntime(platform, { ...DEFAULT_EDGE_NODE_NAMES, ...platform.names });
	edgeNodes.set(id, created);
	return created;
}

class EdgeNodeRuntime implements EdgeNode, JoinRuntime, OwnerGrantRuntime {
	private readonly keyStore: KeyStore;
	readonly moves: StrandMoveRecords;
	private current: CadreNode | null = null;
	runningOptions: EdgeNodeOptions | null = null;
	private starting: Promise<CadreNode> | null = null;
	private stopping: Promise<void> | null = null;
	/** One per join called and not yet settled, so a stop can cancel them. */
	private readonly joins = new Set<AbortController>();
	/**
	 * Start, stop, restart, join and dissolve run one at a time, in call order: each opens or closes
	 * the stores the others use, so a start overlapping a stop would build on handles the stop then closes.
	 */
	private transitions: Promise<unknown> = Promise.resolve();
	private currentStatus: EdgeNodeStatus = { state: 'stopped' };
	private lastUnfinishedRemoval: UnfinishedRemoval | null = null;
	private readonly subscriptions = new Set<Subscription>();
	private readonly statusListeners = new Set<(status: EdgeNodeStatus) => void>();

	constructor(
		private readonly platform: EdgeNodePlatform,
		private readonly names: EdgeNodeNames,
	) {
		this.keyStore = platform.keyStore;
		this.moves = new StrandMoveRecords(this.keyStore);
	}

	get status(): EdgeNodeStatus {
		return this.currentStatus;
	}

	get node(): CadreNode | null {
		return this.currentStatus.state === 'running' ? this.current : null;
	}

	get options(): EdgeNodeOptions | null {
		return this.currentStatus.state === 'running' ? this.runningOptions : null;
	}

	get unfinishedRemoval(): UnfinishedRemoval | null {
		return this.lastUnfinishedRemoval;
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

	start(options: EdgeNodeOptions): Promise<CadreNode> {
		if (this.starting) return this.starting;
		return this.trackStart(() => (this.current?.isRunning ? Promise.resolve(this.current) : this.buildAndStart(options)));
	}

	stop(): Promise<void> {
		// A join can wait for a member until its invitation expires; the user's disconnect ends it.
		// NOTE: the cancelled join starts the party it left again, and only then does this stop
		// stop it. If that restart makes Disconnect noticeably slow, let a join cancelled by a stop
		// save the left start with `autoStart: false` and stay stopped instead.
		for (const join of this.joins) join.abort(new Error('the edge node was stopped during a join'));
		return this.trackStop(() => this.stopAndClearAutoStart());
	}

	restart(options: EdgeNodeOptions): Promise<CadreNode> {
		this.starting = null;
		return this.trackStart(async () => {
			await this.shutDown();
			return this.buildAndStart(options);
		});
	}

	joinCadre(credential: JoinCredential, options: JoinCadreOptions = {}): Promise<JoinCadreResult> {
		// A start called from here on runs after this join rather than joining a start it replaces.
		this.starting = null;
		const cancel = new AbortController();
		const release = relayAbort(options.signal, cancel);
		this.joins.add(cancel);
		const joining = this.inTurn(() => joinCadre(this, credential, options, cancel.signal));
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

	/** The node-local store for a record the app keeps across stops and starts. */
	nodeLocalRecords(): KvStoreApi {
		// Each get and set asks the platform for the store again: a stop closes it, and the record outlives the stop.
		const kv = async (): Promise<NodeLocalKv> => {
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
			const running = this.runningOptions;
			const formerPartyId = running?.formerPartyId;
			if (!node?.isRunning || !running || formerPartyId === undefined) return undefined;
			const record = await this.moves.load(formerPartyId);
			if (record?.targetPartyId !== node.partyId) return undefined;
			// A joined start that settled as a member stopped asking for the owner row after its
			// bound; one that arrived since makes this adoption an owner's rather than a refusal.
			// A founded party never re-asks here: genesis is its owner step, and a signer already
			// wired is never replaced.
			if (running.origin === 'joined' && node.getOwnerSigner() === null && (await this.wireJoinedOwner(node, false)) === 'enrolled') {
				this.reportEnrolled(node);
			}
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

	onStatus(listener: (status: EdgeNodeStatus) => void): () => void {
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

	exportOwnerKey(options: OwnerKeyExportOptions = {}): Promise<ExportedOwnerKey> {
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

	createOwnerGrant(options: CreateOwnerGrantOptions = {}): Promise<CreateOwnerGrantResult> {
		return this.onRunningNode((node) => node.createOwnerGrant(options));
	}

	listOwnerGrants(): Promise<OwnerGrantStatus[]> {
		return this.onRunningNode((node) => node.listOwnerGrants());
	}

	withdrawOwnerGrant(key: string): Promise<boolean> {
		return this.onRunningNode((node) => node.withdrawOwnerGrant(key));
	}

	redeemOwnerGrant(text: string): Promise<RedeemedOwnerGrant> {
		return this.onRunningNode(async (node) => {
			const redeemed = await redeemOwnerGrantText(this, node, text);
			if (redeemed.wired) this.reportEnrolled(node);
			return redeemed;
		});
	}

	/** Run `op` on the running node, in turn with start, stop and join; throws when none is running. */
	private onRunningNode<T>(op: (node: CadreNode) => Promise<T>): Promise<T> {
		return this.inTurn(async () => {
			const node = this.node;
			if (!node?.isRunning) throw new Error('The edge node is not running; start it first');
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
	// `bringUp`, `readAlone`, `buildAndStart`, `ownerSlotSigner`, `wireJoinedOwner`,
	// `saveRunningStart` and `reportRunning` are public as the join's and the owner-grant
	// redemption's view of this runtime (`JoinRuntime`, `OwnerGrantRuntime`); the class itself
	// never leaves this module.

	async buildAndStart(options: EdgeNodeOptions): Promise<CadreNode> {
		this.setStatus({ state: 'starting' });
		try {
			const { node, resolved } = await this.bringUp(options);
			const owner = await this.settleOwnerKey(node, resolved);
			// Finishes a move a join left: the app was killed before adopting, or its key was wired
			// only now. A move record the key store refuses to read fails the start.
			// NOTE: a pending move delays `running` by its control writes, a few per strand. If a
			// resumed move makes a start noticeably slow, adopt after `markRunning` instead, as a
			// transition of its own.
			if (owner === 'enrolled') await adoptMovesInto(node, this.moves);
			await this.markRunning(node, resolved, owner);
			return node;
		} catch (err) {
			// The start's own error is the one to report; a failure tearing down after it is only logged.
			await this.shutDown().catch((cleanupErr: unknown) => {
				console.warn('[cadre-core/edge-node] cleaning up after a failed start failed:', cleanupErr);
			});
			const error = toError(err);
			this.setStatus({ state: 'failed', error });
			throw error;
		}
	}

	/** Build the node for `options`, every subscription attached, and start it, after finishing a begun dissolve. */
	async bringUp(options: EdgeNodeOptions): Promise<{ node: CadreNode; resolved: EdgeNodeOptions }> {
		const removal = await finishRemovalAtStart(this.partyStorage());
		this.noteRemovalAtStart(removal);
		const resolved = withoutFormerParty(await this.resolveOptions(options), removal.partyId);
		const node = new CadreNode(await this.buildConfig(resolved));
		this.current = node;
		for (const subscription of this.subscriptions) subscription.attach(node);
		this.watchRemoval(node);
		await node.start();
		return { node, resolved };
	}

	/** What `unfinishedRemoval` reports after a start: a marker that could not be read leaves the last report standing. */
	private noteRemovalAtStart(removal: RemovalAtStart): void {
		if (removal.partyId !== undefined) {
			this.lastUnfinishedRemoval = removal.error ? { partyId: removal.partyId, error: removal.error } : null;
		} else if (!removal.error) {
			this.lastUnfinishedRemoval = null;
		}
	}

	/**
	 * Start a node for `options`' party only to run `read` on it, then stop it. Nothing subscribes,
	 * nothing is saved and no strand launches: the node never reports running. A join exports the
	 * strands of a stopped party this way, and a dissolve reads the party it removes.
	 */
	async readAlone<T>(options: EdgeNodeOptions, read: (node: CadreNode) => Promise<T>, purpose: string): Promise<T> {
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
				console.warn(`[cadre-core/edge-node] stopping the node started to ${purpose} failed:`, err);
			});
		}
	}

	/** A founded party runs owner genesis; a joined one only wires a key the party already lists. */
	private settleOwnerKey(node: CadreNode, options: EdgeNodeOptions): Promise<OwnerGenesisResult> {
		if (options.origin === 'joined') return this.wireJoinedOwner(node, false);
		return runOwnerGenesis(node, { keyStore: this.keyStore, label: options.ownerKeyLabel, timeoutMs: this.platform.ownerGenesisTimeoutMs });
	}

	/** The owner slot's key, created when the slot is empty: what an owner grant seats. Inside a transition, as the slot's check-then-set must be. */
	async ownerSlotSigner(): Promise<OwnerSigner> {
		return (await loadOwnerSigner(this.keyStore)) ?? (await createOwnerKey(this.keyStore));
	}

	/** `granted`: an owner grant has just seated the slot's key, so wait for the row. */
	wireJoinedOwner(node: CadreNode, granted: boolean): Promise<OwnerGenesisResult> {
		return wireJoinedOwnerKey(node, { keyStore: this.keyStore, timeoutMs: this.platform.ownerGenesisTimeoutMs, granted });
	}

	/** Report a node that came up, saving its options only now, so a failed start never replaces the last one that came up. */
	private async markRunning(node: CadreNode, resolved: EdgeNodeOptions, owner: OwnerGenesisResult): Promise<void> {
		await this.saveRunningStart(resolved);
		this.reportRunning(node, resolved, owner);
	}

	saveRunningStart(resolved: EdgeNodeOptions): Promise<void> {
		return this.saveStart({ options: resolved, autoStart: true, writtenBy: this.platform.dataVersion });
	}

	reportRunning(node: CadreNode, resolved: EdgeNodeOptions, owner: OwnerGenesisResult): void {
		this.runningOptions = resolved;
		this.setStatus({ state: 'running', node, owner });
	}

	/**
	 * The options as this start runs and saves them. The Noise mode is resolved, so a later
	 * build's default does not change a device that already ran. Options naming no `origin`
	 * take the saved start's `origin` and `formerPartyId` when it is for the same party, so a
	 * party this app joined, started again from a hand-typed party id, does not run owner genesis.
	 */
	private async resolveOptions(options: EdgeNodeOptions): Promise<EdgeNodeOptions> {
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
	private async buildConfig(options: EdgeNodeOptions): Promise<CadreNodeConfig> {
		const { partyId, relayAddrs } = options;
		const { platform } = this;
		const config = buildEdgeNodeConfig({
			...options,
			noiseCrypto: this.buildNoiseCrypto(options.noiseCryptoMode),
			keyStore: this.keyStore,
			storageProvider: (scope) => platform.storage.rawStorage(scope),
			offlineJournal: platform.storage.offlineJournal?.bind(platform.storage),
			transports: (platform.transports ?? defaultTransports)(relayAddrs),
			listenAddrs: platform.listenAddrs?.(relayAddrs) ?? [],
			allowPrivateDial: platform.allowPrivateDial ?? true,
			trustedOwnerStore: await PersistentTrustedOwnerStore.open(this.trustedOwnerSlot(partyId), partyId),
			bootstrapPeerStore: await PersistentBootstrapPeerStore.open(this.nodeLocalSlot(bootstrapPeersKvKey(partyId)), partyId),
			enrolledMachineStore: await PersistentEnrolledMachineStore.open(this.nodeLocalSlot(enrolledMachinesKvKey(partyId)), partyId),
			strandNetworkStateStore: await PersistentStrandNetworkStateStore.open(this.nodeLocalSlot(strandNetworkKvKey(partyId)), partyId),
		});
		return platform.configure ? platform.configure(config) : config;
	}

	private buildNoiseCrypto(mode: NoiseCryptoMode | undefined): NoiseCryptoInterface | undefined {
		const noiseCrypto = this.platform.noiseCrypto;
		return noiseCrypto && mode ? noiseCrypto.build(mode) : undefined;
	}

	// ── dissolve ─────────────────────────────────────────────────────────────
	// NOTE: this file is about 1050 lines (`wc -l`), the dissolve's and the removal's transitions
	// the largest part (the storage they delete is in `dissolve.ts`; the join is `edge-join.ts`,
	// the owner-grant redemption `owner-grant.ts`), then the owner-key and owner-grant
	// pass-throughs. If any of them grows further, move it to a module of its own over a narrow
	// view of this runtime, as the join is.

	/** docs/architecture.md → "Dissolving the party it left". */
	private async dissolve(discard: readonly string[]): Promise<void> {
		await this.finishMarkedRemoval();
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

	private runningWithFormerParty(): { node: CadreNode; running: EdgeNodeOptions; formerPartyId: string } {
		const node = this.node;
		const running = this.runningOptions;
		const formerPartyId = running?.formerPartyId;
		if (!node?.isRunning || !running || formerPartyId === undefined) {
			throw new Error('Nothing to dissolve: the edge node is not running with a former party, one this app founded and left');
		}
		// Only a hand-built start names its own party; dissolving it would delete the running party's control database.
		if (formerPartyId === running.partyId) {
			throw new Error(`Cannot dissolve party ${formerPartyId}: it is the running party, not one this app left`);
		}
		return { node, running, formerPartyId };
	}

	/** After a refused or failed dissolve. The dissolve's own error is the one its caller gets; this one is only logged. */
	private async startAgainAfterDissolve(running: EdgeNodeOptions): Promise<void> {
		try {
			await this.buildAndStart(running);
		} catch (err) {
			console.warn('[cadre-core/edge-node] starting the running party again after a dissolve failed:', err);
		}
	}

	/** Finish the removal a marker names, if any; finished, it is no longer an unfinished one to report. */
	private async finishMarkedRemoval(): Promise<void> {
		await finishMarkedRemoval(this.partyStorage());
		this.lastUnfinishedRemoval = null;
	}

	// ── removal ──────────────────────────────────────────────────────────────

	/**
	 * Answer `node` reporting that an owner removed this app from its party
	 * ({@link forgetRemovedParty}). Attached before the node starts, so no report comes before it
	 * and `removedFromCadre()` has nothing to add; never detached, so a report raised while the
	 * node stops, which it made while running, is still answered.
	 *
	 * NOTE: a device removed while its app was not running never sees its own row live after the
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
				// `shutDown` has closed every store and dropped the node whether or not its stop threw.
				console.warn(`[cadre-core/edge-node] stopping the node of party ${partyId}, which removed this app, failed:`, err);
			});
			const formerPartyId = await this.leaveRemovedStart(partyId);
			await this.removeLocalParty(partyId);
			this.setStatus({ state: 'removed', partyId, removal, ...(formerPartyId !== undefined && { formerPartyId }) });
		} catch (err) {
			console.warn(`[cadre-core/edge-node] acting on this app's removal from party ${partyId} failed:`, err);
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
		try {
			await this.finishMarkedRemoval();
			await removeParty(this.partyStorage(), partyId);
		} catch (err) {
			console.warn(`[cadre-core/edge-node] deleting the storage of party ${partyId}, which removed this app, failed:`, err);
		}
	}

	// ── stop ─────────────────────────────────────────────────────────────────

	private async stopAndClearAutoStart(): Promise<void> {
		// NOTE: with no node running (the last start failed) the saved record is left alone, so an
		// earlier `autoStart: true` survives this stop. The reference app offers Disconnect only
		// while connected; if an app lets a user stop a node whose start failed, rewrite the
		// saved record with `autoStart: false` here too.
		if (this.runningOptions) {
			await this.saveStart({ options: this.runningOptions, autoStart: false, writtenBy: this.platform.dataVersion });
		}
		await this.shutDown();
	}

	/**
	 * Stop the node and close every store, the node's references cleared first: a throwing
	 * `stop()` must not leave a node whose stores the `finally` has just closed, which the next
	 * `start` would hand back as running.
	 */
	async shutDown(): Promise<void> {
		const stopping = this.current;
		this.current = null;
		this.runningOptions = null;
		try {
			if (stopping) {
				for (const subscription of this.subscriptions) subscription.detach(stopping);
				await stopping.stop();
			}
		} finally {
			// The node-local store first, flushed, then every raw store: the platform's contract.
			await this.platform.storage.close();
			this.setStatus({ state: 'stopped' });
		}
	}

	// ── storage ──────────────────────────────────────────────────────────────

	private nodeLocalKv(): NodeLocalKv {
		return this.platform.storage.nodeLocal();
	}

	private nodeLocalSlot(key: string): DurableSlot {
		return kvStoreSlot(this.nodeLocalKv(), key);
	}

	/** The party's trusted-owner anchor: the platform's slot, else the node-local key. */
	private trustedOwnerSlot(partyId: string): RemovableSlot {
		return this.platform.storage.trustedOwnerSlot?.(partyId) ?? nodeLocalRemovableSlot(this.nodeLocalKv(), trustedOwnersKvKey(partyId));
	}

	private partyStorage(): PartyStorage {
		return {
			nodeLocal: this.nodeLocalKv(),
			markerKey: this.names.dissolveMarkerKey,
			savedStartKey: this.names.savedStartKey,
			destroyScope: (scope) => this.platform.storage.destroyScope(scope),
			trustedOwnerSlot: (partyId) => this.trustedOwnerSlot(partyId),
			keyStore: this.keyStore,
			moves: this.moves,
		};
	}

	/** The saved start, read directly: inside a transition, `loadSavedStart` would wait on a stop queued behind it. */
	async readSavedStart(): Promise<SavedStart | undefined> {
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
			console.warn('[cadre-core/edge-node] could not save the start options:', err);
		}
	}

	setStatus(status: EdgeNodeStatus): void {
		this.currentStatus = status;
		for (const listener of this.statusListeners) {
			try {
				listener(status);
			} catch (err) {
				console.warn('[cadre-core/edge-node] status listener threw:', err);
			}
		}
	}
}

/** The default anchor slot: one node-local key, whose removal is durable when it resolves, as `kvStoreSlot`'s save is. */
function nodeLocalRemovableSlot(kv: NodeLocalKv, key: string): RemovableSlot {
	return {
		...kvStoreSlot(kv, key),
		remove: async () => {
			await kv.delete(key);
			await kv.flush();
		},
	};
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

/** WebSockets to dial the party's machines and relays, and circuit relay to be reachable through one. */
function defaultTransports(): Libp2pTransports {
	return [webSockets(), circuitRelayTransport()];
}
