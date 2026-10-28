/**
 * The edge node's `CadreNodeConfig` and how a start settles its owner key. Nothing here needs a
 * node started, so a test can build the node shape an edge device runs.
 */

import { DEFAULT_IDENTITY_KEY_ID, type KeyStore } from '../key-store.js';
import { createOwnerKey, loadOwnerSigner } from '../owner-key-store.js';
import { OWNER_KEY_MAX_LABEL } from '../owner-key-export.js';
import type { OwnerSigner } from '../owner-signer.js';
import type { CadreNode } from '../cadre-node.js';
import type { CadreNodeConfig } from '../types.js';
import type { BootstrapPeerStore } from '../bootstrap-peer-store.js';
import type { EnrolledMachineStore } from '../enrolled-machine-store.js';
import type { StrandNetworkStateStore } from '../strand-network-state.js';
import type { TrustedOwnerStore } from '../trusted-owner-store.js';
import type { IKVStore, IRawStorage, Libp2pTransports, NoiseCryptoInterface } from '@optimystic/db-p2p';
import type { EdgeNodeOptions } from './options.js';

/** What {@link buildEdgeNodeConfig} takes: one start's options plus what the platform built. */
export interface EdgeNodeConfigInputs extends EdgeNodeOptions {
	/** `undefined` keeps libp2p-noise's own crypto. */
	noiseCrypto?: NoiseCryptoInterface;
	/**
	 * Holds the node identity, which the node loads on start, generating it on first run, and the
	 * owner key in its own slot (`DEFAULT_OWNER_KEY_ID`), which only {@link runOwnerGenesis} creates.
	 */
	keyStore: KeyStore;
	/**
	 * Raw block storage per cadre-core storage scope: `controlStorageScope(partyId)` for the
	 * control network, the strand id for each strand. The key is already safe as a database-name
	 * segment — use it verbatim, do not parse it.
	 */
	storageProvider: (scope: string) => IRawStorage;
	/**
	 * A strand's offline journal (`EdgeNodeStorage.offlineJournal`). Absent: no offline mode, and
	 * {@link EdgeNodeOptions.strandOfflineMode} is ignored.
	 */
	offlineJournal?: (scope: string) => Promise<IKVStore>;
	/** libp2p transport factories: what the node dials with, and what listens on `listenAddrs`. */
	transports: Libp2pTransports;
	/**
	 * Listen addresses besides the bare `/p2p-circuit` entry cadre-core adds for a named relay.
	 * Default `[]`: an edge device accepts no inbound connection. See `EdgeNodePlatform.listenAddrs`.
	 */
	listenAddrs?: string[];
	/** See `EdgeNodePlatform.allowPrivateDial`. */
	allowPrivateDial: boolean;
	trustedOwnerStore: TrustedOwnerStore;
	bootstrapPeerStore: BootstrapPeerStore;
	enrolledMachineStore: EnrolledMachineStore;
	strandNetworkStateStore: StrandNetworkStateStore;
}

/**
 * The edge node's config: transaction profile (Ring Zulu only, intermittent connectivity), no
 * listen address unless the platform names one, reachability through the configured relays (if
 * any) but never a hard requirement for one, every strand the control network lists, and no
 * automatic hibernation (the app's lifecycle runner hibernates on background), and offline mode
 * on strands when the platform keeps an offline journal. Schema signing is
 * left at cadre-core's fail-closed default; an app with unsigned schemas relaxes it in
 * `EdgeNodePlatform.configure`.
 */
export function buildEdgeNodeConfig(inputs: EdgeNodeConfigInputs): CadreNodeConfig {
	return {
		// Identity comes from the key store (loaded when present, generated and persisted on first
		// run). Mutually exclusive with `privateKey`, which would take it out of the key store.
		keyStore: inputs.keyStore,
		identityKeyId: DEFAULT_IDENTITY_KEY_ID,
		controlNetwork: {
			partyId: inputs.partyId,
			bootstrapNodes: inputs.bootstrapAddrs,
		},
		profile: 'transaction',
		storage: {
			provider: inputs.storageProvider,
		},
		network: {
			transports: inputs.transports,
			// An edge device accepts no inbound connection, so by default it listens on nothing:
			// the only address it ever has is the `/p2p-circuit` address a relay reservation earns
			// it. An explicitly empty `listenAddrs` stays empty through cadre-core's derivation, and
			// naming a relay adds the bare `/p2p-circuit` search entry to it
			// (`cadre-core/src/relay-addrs.ts` → `resolveListenAddrs`). A browser adds `/webrtc`.
			listenAddrs: inputs.listenAddrs ?? [],
			// Through this config field rather than `CadreNode.reserveRelays()`, which reaches the
			// control node only: formation has the invitee dial the control node and then the strand
			// nodes, so both need a circuit address.
			//
			// NOTE: naming a relay starts a reservation supervisor that runs for as long as the
			// control node does, including while backgrounded (hibernation stops strands, not the
			// control node): a 5 s local check while the reservation holds, a dial every backoff
			// interval (2 s → 60 s) while it does not. If background battery use becomes a complaint,
			// raise `checkMs`/`maxBackoffMs` in cadre-core rather than stopping the supervisor here,
			// which would leave a device that silently stopped being invitable.
			relayAddrs: inputs.relayAddrs,
			// An edge device must come up with its relay down — on a plane, on dead Wi-Fi, or with
			// none configured. A first reservation attempt that lands nothing is logged and retried in
			// the background instead of failing `start()`. A malformed entry still throws.
			requireRelay: false,
			// The platform's Noise primitives (native SHA-256 / ChaCha20-Poly1305, and X25519 in
			// `full` mode, on a phone); only local primitives change, not the wire protocol.
			noiseCrypto: inputs.noiseCrypto,
			// libp2p's `connection-gater` points its `react-native` and `browser` fields at a build
			// that refuses to dial plain `ws://`, loopback and private addresses. A cadre-host node
			// claimed by its code on the same Wi-Fi, an emulator reaching `10.0.2.2` and a self-run
			// relay without TLS are all of those. Only the dial is permitted: the connection is still
			// Noise, the pinned `/p2p/<id>` decides which machine answers, and membership is still
			// gated by `denyDialPeer` and the inbound hooks. cadre-core hands this gater to strand nodes too.
			...(inputs.allowPrivateDial ? { connectionGater: { denyDialMultiaddr: () => false } } : {}),
		},
		...(inputs.offlineJournal && {
			strandOffline: { journal: inputs.offlineJournal, initialMode: inputs.strandOfflineMode ?? 'online' },
		}),
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: inputs.trustedOwnerStore },
		bootstrapPeers: { store: inputs.bootstrapPeerStore },
		enrolledMachines: { store: inputs.enrolledMachineStore },
		strandNetworkState: { store: inputs.strandNetworkStateStore },
	};
}

/**
 * How the start settled this node's owner key: `EdgeNodeStatus.owner`. `'enrolled'`: a key is
 * an owner and wired for signing. `'member'`: the party lists no key this app holds (a party it
 * joined, or one it founded whose owner slot was lost). `'failed'` and `'timed-out'`: see
 * {@link runOwnerGenesis}.
 */
export type OwnerGenesisResult = 'enrolled' | 'member' | 'failed' | 'timed-out';

/**
 * Default bound on {@link runOwnerGenesis} and {@link wireJoinedOwnerKey}: what a start can wait
 * for its owner step, which runs control reads and one control write, before it goes on without
 * it. Not derived from the link, since a start that waited out a stalled write (about 84 s, see
 * `docs/cadre-consistency.md`) would be a start the user gave up on.
 */
// eslint-disable-next-line no-restricted-syntax -- cuts off by design: a start goes on without its owner step rather than wait out a stalled control write; see docs/cadre-consistency.md → "Deadlines Over Optimystic's Reads and Commits"
export const DEFAULT_OWNER_GENESIS_TIMEOUT_MS = 60_000;

/** Default `EdgeNodeOptions.ownerKeyLabel`: the founding owner key's name on its `OwnerKey` row. */
export const DEFAULT_OWNER_KEY_LABEL = 'phone';

/**
 * Refuses an `ownerKeyLabel` the founding `OwnerKey` row would refuse, so a start naming one
 * fails outright: fail-soft genesis would only log it, on that start and every later one.
 */
export function requireOwnerKeyLabel(label: string | undefined): void {
	const length = label?.trim().length ?? 0;
	if (length > OWNER_KEY_MAX_LABEL) {
		throw new Error(`ownerKeyLabel must be at most ${OWNER_KEY_MAX_LABEL} characters (this one has ${length})`);
	}
}

/** What {@link runOwnerGenesis} takes. */
export interface OwnerGenesisOptions {
	/** The key store whose owner slot holds this app's owner key: the one the identity is in. */
	keyStore: KeyStore;
	/** The founding row's label; default {@link DEFAULT_OWNER_KEY_LABEL}. */
	label?: string;
	/** Default {@link DEFAULT_OWNER_GENESIS_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** What {@link wireJoinedOwnerKey} takes. */
export interface JoinedOwnerKeyOptions {
	/** The key store whose owner slot holds this app's owner key, if it holds one. */
	keyStore: KeyStore;
	/** Default {@link DEFAULT_OWNER_GENESIS_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** An owner grant has just seated the slot's key: keep asking until the row arrives. */
	granted?: boolean;
}

/** How often {@link wireJoinedOwnerKey} asks again for an owner key an owner grant just seated. */
const GRANTED_OWNER_RECHECK_MS = 2_000;

/**
 * The owner step of a party this app founded. On a party with no `OwnerKey` row yet, the owner
 * slot's key (created there now unless the slot already holds one) becomes the founding owner
 * under `label` and is wired for signing, which also lets the node author its own `CadrePeer` row.
 * On a party that has owners, the slot's key is wired only when it is a live owner, and no key is
 * created: a new one could not be seated without another owner's signature. A node must be an
 * enrolled owner to publish strands, and `CadreNode.requestJoin` works only on one. A joined
 * party's start runs {@link wireJoinedOwnerKey} instead.
 *
 * Fail-soft and bounded: a failure or a genesis that has not settled within `timeoutMs` is logged
 * and returned, and the start stands — the app can still join discovered strands and sync. A
 * genesis that times out keeps running; its later failure is logged.
 *
 * NOTE: the bound is here, in cadre-core, so every edge node gets it; a Node host runs genesis
 * through the CLI's own flow instead. Since v1.10 a control write against an unresponsive member
 * can hold the write lock for about 84 s, so an unbounded wait here would be a real stall. A bound
 * on that write itself, in `ControlDatabase`, would make this one redundant; drop `timeoutMs` then.
 */
export function runOwnerGenesis(node: CadreNode, options: OwnerGenesisOptions): Promise<OwnerGenesisResult> {
	const label = options.label ?? DEFAULT_OWNER_KEY_LABEL;
	return withinBound('owner self-genesis', enrollFoundedOwner(node, options.keyStore, label), options.timeoutMs ?? DEFAULT_OWNER_GENESIS_TIMEOUT_MS);
}

/**
 * The owner step of a party this app joined: wire a key only when the party lists it as a live
 * owner, never insert an `OwnerKey` row, so a joined app can neither seat itself as a founder nor
 * anchor a key that is no owner's. Only the owner slot's key is tried: the key an owner grant
 * seated, one imported here, or one an owner of the party added. The identity key is never
 * tried, since a machine's network identity is never an owner key. Fail-soft and bounded as
 * {@link runOwnerGenesis} is.
 *
 * `granted`: an owner grant has just made this app an owner, so a key not listed yet means the
 * row has not reached this node, not that it is no owner. It is asked again every 2 s until it
 * is wired or the bound passes; a start that timed out wires it on the next start.
 */
export function wireJoinedOwnerKey(node: CadreNode, options: JoinedOwnerKeyOptions): Promise<OwnerGenesisResult> {
	let expired = false;
	const wiring = async (): Promise<OwnerGenesisResult> => {
		const held = await loadOwnerSigner(options.keyStore);
		while (!(await wireJoinedOwner(node, held))) {
			if (!options.granted) return 'member';
			await new Promise((resolve) => setTimeout(resolve, GRANTED_OWNER_RECHECK_MS));
			// Past the bound the start has gone on as `'timed-out'`, and may have stopped the node.
			if (expired) return 'member';
		}
		return 'enrolled';
	};
	return withinBound('wiring the joined owner key', wiring(), options.timeoutMs ?? DEFAULT_OWNER_GENESIS_TIMEOUT_MS)
		.finally(() => {
			expired = true;
		});
}

/** `settling`, or `'failed'` when it rejects (logged), or `'timed-out'` when it has not settled within `timeoutMs` (logged). */
async function withinBound(
	label: string,
	settling: Promise<OwnerGenesisResult>,
	timeoutMs: number,
): Promise<OwnerGenesisResult> {
	const settled = settling.catch((err: unknown): OwnerGenesisResult => {
		console.warn(`[cadre-core/edge-node] ${label} failed:`, err);
		return 'failed';
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<OwnerGenesisResult>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
	});
	try {
		const result = await Promise.race([settled, deadline]);
		if (result === 'timed-out') {
			console.warn(`[cadre-core/edge-node] ${label} has not settled after ${timeoutMs} ms; starting without it`);
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

async function enrollFoundedOwner(node: CadreNode, keyStore: KeyStore, label: string): Promise<OwnerGenesisResult> {
	const controlDb = node.getControlDatabase();
	if (!controlDb) {
		throw new Error('control database unavailable after start; cannot run owner genesis');
	}
	const held = await loadOwnerSigner(keyStore);
	if (await controlDb.hasOwnerKey()) {
		return held ? wiredIfOwner(node, held) : 'member';
	}
	// Loaded rather than created when the slot already holds a key: one imported before founding,
	// or one an iOS reinstall kept in the Keychain while the app's data went.
	const founding = held ?? (await createOwnerKey(keyStore));
	if (!(await controlDb.ensureOwnerKey(founding.publicKey, label))) {
		// A row arrived between the two reads: the party has an owner now, so judge the key as above.
		return wiredIfOwner(node, founding);
	}
	await node.useOwnerSigner(founding);
	return 'enrolled';
}

async function wiredIfOwner(node: CadreNode, signer: OwnerSigner): Promise<OwnerGenesisResult> {
	return (await node.wireOwnKeyIfOwner(signer)) ? 'enrolled' : 'member';
}

/**
 * Wire `held`, the owner slot's key, when the party lists it. A node takes one owner signer, so
 * a signer already wired is asked about instead (is it still a live owner?) and never replaced.
 */
async function wireJoinedOwner(node: CadreNode, held: OwnerSigner | undefined): Promise<boolean> {
	if (node.getOwnerSigner() !== null) return await node.wireOwnKeyIfOwner();
	return held !== undefined && (await node.wireOwnKeyIfOwner(held));
}
