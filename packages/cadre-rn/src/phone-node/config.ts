/**
 * The phone node's `CadreNodeConfig` and its owner genesis, with no native imports, so a Node
 * test can build the node shape a phone runs.
 */

import { DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import type {
	BootstrapPeerStore,
	CadreNode,
	CadreNodeConfig,
	EnrolledMachineStore,
	KeyStore,
	StrandNetworkStateStore,
	TrustedOwnerStore,
} from '@serfab/cadre-core';
import type { IRawStorage, Libp2pTransports, NoiseCryptoInterface } from '@optimystic/db-p2p';
import type { PhoneNodeOptions } from './options.js';

/** What {@link buildPhoneNodeConfig} takes: one start's options plus what the platform built. */
export interface PhoneNodeConfigInputs extends PhoneNodeOptions {
	/** `undefined` keeps libp2p-noise's pure-JavaScript crypto. */
	noiseCrypto?: NoiseCryptoInterface;
	/** Holds the node identity; the node loads it on start, generating it on first run. */
	keyStore: KeyStore;
	/**
	 * Raw block storage per cadre-core storage scope: `controlStorageScope(partyId)` for the
	 * control network, the strand id for each strand. The key is already safe as a database-name
	 * segment — use it verbatim, do not parse it.
	 */
	storageProvider: (scope: string) => IRawStorage;
	/** libp2p transport factories. The phone never listens, so these only dial. */
	transports: Libp2pTransports;
	/** See `PhoneNodePlatform.allowPrivateDial`. */
	allowPrivateDial: boolean;
	trustedOwnerStore: TrustedOwnerStore;
	bootstrapPeerStore: BootstrapPeerStore;
	enrolledMachineStore: EnrolledMachineStore;
	strandNetworkStateStore: StrandNetworkStateStore;
}

/**
 * The phone node's config: transaction profile (Ring Zulu only, intermittent connectivity), no
 * listen address, reachability through the configured relays (if any) but never a hard
 * requirement for one, every strand the control network lists, and no automatic hibernation (the
 * app's lifecycle runner hibernates on background). Schema signing is left at cadre-core's
 * fail-closed default; an app with unsigned schemas relaxes it in `PhoneNodePlatform.configure`.
 */
export function buildPhoneNodeConfig(inputs: PhoneNodeConfigInputs): CadreNodeConfig {
	return {
		// Identity comes from the key store (loaded when present, generated and persisted on first
		// run). Mutually exclusive with `privateKey`, which would take it out of the secure store.
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
			// Phones do NOT listen — React Native cannot accept an inbound connection. The only
			// address a phone ever has is the `/p2p-circuit` address a relay reservation earns it.
			// An explicitly empty `listenAddrs` stays empty through cadre-core's derivation, and
			// naming a relay adds the bare `/p2p-circuit` search entry to it
			// (`cadre-core/src/relay-addrs.ts` → `resolveListenAddrs`).
			listenAddrs: [],
			// Through this config field rather than `CadreNode.reserveRelays()`, which reaches the
			// control node only: formation has the invitee dial the control node and then the strand
			// nodes, so both need a circuit address.
			//
			// NOTE: naming a relay starts a reservation supervisor that runs for as long as the
			// control node does, including while backgrounded (hibernation stops strands, not the
			// control node): a 5 s local check while the reservation holds, a dial every backoff
			// interval (2 s → 60 s) while it does not. If background battery use becomes a complaint,
			// raise `checkMs`/`maxBackoffMs` in cadre-core rather than stopping the supervisor here,
			// which would leave a phone that silently stopped being invitable.
			relayAddrs: inputs.relayAddrs,
			// A phone must come up with its relay down — on a plane, on dead Wi-Fi, or with none
			// configured. A first reservation attempt that lands nothing is logged and retried in the
			// background instead of failing `start()`. A malformed entry still throws.
			requireRelay: false,
			// Native SHA-256 / ChaCha20-Poly1305 (and X25519 in `full` mode) for Noise; only local
			// primitives change, not the wire protocol.
			noiseCrypto: inputs.noiseCrypto,
			// libp2p's `connection-gater` points its `react-native` field at the browser build, which
			// refuses to dial plain `ws://`, loopback and private addresses. A cadre-host node claimed
			// by its code on the same Wi-Fi, an emulator reaching `10.0.2.2` and a self-run relay
			// without TLS are all of those. Only the dial is permitted: the connection is still Noise,
			// the pinned `/p2p/<id>` decides which machine answers, and membership is still gated by
			// `denyDialPeer` and the inbound hooks. cadre-core hands this gater to strand nodes too.
			...(inputs.allowPrivateDial ? { connectionGater: { denyDialMultiaddr: () => false } } : {}),
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: inputs.trustedOwnerStore },
		bootstrapPeers: { store: inputs.bootstrapPeerStore },
		enrolledMachines: { store: inputs.enrolledMachineStore },
		strandNetworkState: { store: inputs.strandNetworkStateStore },
	};
}

/**
 * How the start settled this node's owner key: `PhoneNodeStatus.owner`. `'enrolled'`: the key
 * is an owner and wired for signing. `'member'`: a party this app joined does not list the key
 * as an owner. `'failed'` and `'timed-out'`: see {@link runOwnerGenesis}.
 */
export type OwnerGenesisResult = 'enrolled' | 'member' | 'failed' | 'timed-out';

/** Default bound on {@link runOwnerGenesis} and {@link wireJoinedOwnerKey}. */
export const DEFAULT_OWNER_GENESIS_TIMEOUT_MS = 60_000;

/** How often {@link wireJoinedOwnerKey} asks again for an owner key a redemption just granted. */
const GRANTED_OWNER_RECHECK_MS = 2_000;

/**
 * Self-genesis the phone as its own party's owner: enroll the identity's owner key in the control
 * database, then bring up seed bootstrap (which lets the node author its own `CadrePeer` row). A
 * node must be an enrolled owner to publish strands, and `CadreNode.requestJoin` works only on one.
 * The first node to enroll becomes the founding owner; for a later joiner that has already synced
 * one, `ensureOwnerKey` is a no-op. Only for a party this app founded: a joined party's start
 * runs {@link wireJoinedOwnerKey} instead.
 *
 * Fail-soft and bounded: a failure or a genesis that has not settled within `timeoutMs` is logged
 * and returned, and the start stands — the phone can still join discovered strands and sync. A
 * genesis that times out keeps running; its later failure is logged.
 *
 * NOTE: the bound belongs in cadre-core, where every embedder would get it. Since v1.10 a control
 * write against an unresponsive member can hold the write lock for about 84 s, so an unbounded wait
 * here is a real stall. Move the bound into cadre-core and drop `timeoutMs` when it has one.
 */
export function runOwnerGenesis(
	node: CadreNode,
	timeoutMs: number = DEFAULT_OWNER_GENESIS_TIMEOUT_MS,
): Promise<OwnerGenesisResult> {
	return withinBound('owner self-genesis', enrollOwner(node).then((): OwnerGenesisResult => 'enrolled'), timeoutMs);
}

/**
 * The owner step of a party this app joined: wire the identity key for signing only when the
 * party lists it as a live owner (`CadreNode.wireOwnKeyIfOwner`), never insert an `OwnerKey` row,
 * so a joined app can neither seat itself as a founder nor anchor a key that is no owner's.
 * Fail-soft and bounded as {@link runOwnerGenesis} is.
 *
 * `granted`: a redemption has just made this key an owner, so a key not listed yet means the row
 * has not reached this node, not that it is no owner. It is asked again every 2 s until it is
 * wired or the bound passes; a start that timed out wires it on the next start.
 */
export function wireJoinedOwnerKey(
	node: CadreNode,
	options: { timeoutMs?: number; granted?: boolean } = {},
): Promise<OwnerGenesisResult> {
	let expired = false;
	const wiring = async (): Promise<OwnerGenesisResult> => {
		while (!(await node.wireOwnKeyIfOwner())) {
			if (!options.granted || expired) return 'member';
			await new Promise((resolve) => setTimeout(resolve, GRANTED_OWNER_RECHECK_MS));
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
		console.warn(`[cadre-rn/phone-node] ${label} failed:`, err);
		return 'failed';
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<OwnerGenesisResult>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
	});
	try {
		const result = await Promise.race([settled, deadline]);
		if (result === 'timed-out') {
			console.warn(`[cadre-rn/phone-node] ${label} has not settled after ${timeoutMs} ms; starting without it`);
		}
		return result;
	} finally {
		clearTimeout(timer);
	}
}

async function enrollOwner(node: CadreNode): Promise<void> {
	// The owner pair comes from the node's resolved (secure-stored) identity.
	const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
	const controlDb = node.getControlDatabase();
	if (!controlDb) {
		throw new Error('control database unavailable after start; cannot run owner genesis');
	}
	await controlDb.ensureOwnerKey(publicKeyB64);
	await node.initializeSeedBootstrap(privateKeyB64);
}
