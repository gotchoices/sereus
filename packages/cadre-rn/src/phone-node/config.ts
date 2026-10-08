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

/** How owner genesis ended: `PhoneNodeStatus.owner`. */
export type OwnerGenesisResult = 'enrolled' | 'failed' | 'timed-out';

/** Default bound on {@link runOwnerGenesis}. */
export const DEFAULT_OWNER_GENESIS_TIMEOUT_MS = 60_000;

/**
 * Self-genesis the phone as its own party's owner: enroll the identity's owner key in the control
 * database, then bring up seed bootstrap (which lets the node author its own `CadrePeer` row). A
 * node must be an enrolled owner to publish strands, and `CadreNode.requestJoin` works only on one.
 * The first node to enroll becomes the founding owner; for a later joiner that has already synced
 * one, `ensureOwnerKey` is a no-op.
 *
 * Fail-soft and bounded: a failure or a genesis that has not settled within `timeoutMs` is logged
 * and returned, and the start stands — the phone can still join discovered strands and sync. A
 * genesis that times out keeps running; its later failure is logged.
 *
 * NOTE: the bound belongs in cadre-core, where every embedder would get it. Since v1.10 a control
 * write against an unresponsive member can hold the write lock for about 84 s, so an unbounded wait
 * here is a real stall. Move the bound into cadre-core and drop `timeoutMs` when it has one.
 */
export async function runOwnerGenesis(
	node: CadreNode,
	timeoutMs: number = DEFAULT_OWNER_GENESIS_TIMEOUT_MS,
): Promise<OwnerGenesisResult> {
	const genesis = enrollOwner(node).then(
		(): OwnerGenesisResult => 'enrolled',
		(err: unknown): OwnerGenesisResult => {
			console.warn('[cadre-rn/phone-node] owner self-genesis failed:', err);
			return 'failed';
		},
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<OwnerGenesisResult>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
	});
	try {
		const result = await Promise.race([genesis, deadline]);
		if (result === 'timed-out') {
			console.warn(`[cadre-rn/phone-node] owner self-genesis has not settled after ${timeoutMs} ms; starting without it`);
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
