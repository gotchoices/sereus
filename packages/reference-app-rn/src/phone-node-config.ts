/**
 * phone-node-config.ts — the phone node's `CadreNodeConfig` and its owner genesis,
 * with no native imports.
 *
 * `cadre-phone.ts` owns the native wiring (the secure-enclave key store, rn-leveldb
 * storage, ICE servers, the WebRTC transport) and passes what it builds to
 * {@link buildPhoneNodeConfig}. Keeping the assembly here lets a Node test start the
 * node shape the phone actually runs (`test/solo-founding.spec.ts`) rather than a
 * copy of it that could drift.
 */

import { DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import type {
	BootstrapPeerStore,
	CadreNode,
	CadreNodeConfig,
	EnrolledMachineStore,
	KeyStore,
	TrustedOwnerStore,
} from '@serfab/cadre-core';
import type { IRawStorage, Libp2pTransports } from '@optimystic/db-p2p';

export interface PhoneNodeOptions {
	/** Party ID — identifies this cadre. Generated on first run. */
	partyId: string;
	/** Bootstrap multiaddrs for the drone (WebSocket). */
	bootstrapAddrs: string[];
}

/** What {@link buildPhoneNodeConfig} takes from the platform wiring. */
export interface PhoneNodeConfigInputs extends PhoneNodeOptions {
	/** Holds the node identity; the node loads it on start, generating it on first run. */
	keyStore: KeyStore;
	/**
	 * Raw block storage per cadre-core storage scope: `controlStorageScope(partyId)` for
	 * the control network, the strand id for each strand. The key is opaque and already
	 * safe as a database-name segment — use it verbatim, do not parse it.
	 */
	storageProvider: (scope: string) => IRawStorage;
	/** libp2p transport factories. The phone never listens, so these only dial. */
	transports: Libp2pTransports;
	trustedOwnerStore: TrustedOwnerStore;
	bootstrapPeerStore: BootstrapPeerStore;
	enrolledMachineStore: EnrolledMachineStore;
}

/**
 * The phone node's config: transaction profile (Ring Zulu only, intermittent
 * connectivity), no listen address, every strand the control network lists, no
 * hibernation, and the demo's unsigned chat schema allowed.
 */
export function buildPhoneNodeConfig(inputs: PhoneNodeConfigInputs): CadreNodeConfig {
	return {
		// Identity comes from the key store (loaded when present, generated and
		// persisted on first run). Mutually exclusive with `privateKey`.
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
			// Phones do NOT listen (`listenAddrs: []`). Unlike web, which conditionally
			// listens on ['/p2p-circuit', '/webrtc'] when it holds a relay reservation,
			// the phone's dialed circuit reservation + the `/webrtc` upgrade are
			// advertised over the existing identify/cohort flow without a listen addr.
			listenAddrs: [], // RN cannot listen for inbound connections
			// Permissive dial gater, for the same reason the web reference app sets one
			// (`reference-app-web/src/lib/cadre-web.ts`). libp2p's `connection-gater`
			// package points its `react-native` field at the BROWSER build, which refuses
			// to dial insecure `ws://` and private addresses — LAN and loopback. A node
			// borrowed from a cadre-host on the same Wi-Fi is exactly that: a private
			// `/ws` address, in normal use rather than only in development. cadre-core's
			// membership gater spreads whatever the embedder passes and adds only
			// `denyDialPeer` plus the inbound/relay hooks, so it never supplies this one.
			//
			// Set explicitly rather than relying on module resolution: Metro's handling of
			// the `react-native` field under package exports is not dependable (see the
			// `unstable_enablePackageExports` comment in `metro.config.js`), so which
			// build is bundled is not something to bet a connection on.
			//
			// This only permits the DIAL. The connection is still Noise-encrypted, and
			// membership is still gated by `denyDialPeer` and the inbound hooks.
			//
			// cadre-core hands `network.connectionGater` to strand nodes as well
			// (`strand-instance-manager.ts`), which is wanted — they dial LAN addresses too.
			connectionGater: { denyDialMultiaddr: () => false },
		},
		strandFilter: { mode: 'all' },
		hibernation: { enabled: false },
		trustedOwners: { store: inputs.trustedOwnerStore },
		bootstrapPeers: { store: inputs.bootstrapPeerStore },
		enrolledMachines: { store: inputs.enrolledMachineStore },
		// Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an
		// ed25519 author key — see getChatSAppConfig). Relax the fail-closed schema
		// policy so the demo can form strands. Production nodes must leave this unset.
		requireSignedSchemas: false,
	};
}

/**
 * Self-genesis the phone as its own party owner. A node must enroll an
 * owner key before it can author control-network writes — notably the
 * owner-signed `Strand` INSERT that {@link CadreNode.publishStrand} performs
 * when the phone creates a strand. This mirrors `cadre-cli start --owner`
 * and the web reference app's `runOwnerGenesis`: bridge the libp2p identity
 * into a base64url owner keypair, run the idempotent genesis `OwnerKey`
 * insert, then bring up seed-bootstrap (which also lets the node author its own
 * `CadrePeer` row via {@link CadreNode.registerSelf}).
 *
 * Owner model (demo): the FIRST node to enroll its key into the shared
 * control DB becomes the founding owner; `ensureOwnerKey` is then a
 * no-op for later joiners that have already synced it. A second phone can always
 * JOIN a discovered strand (joining needs no owner), but only an enrolled
 * owner can publish NEW strands.
 *
 * Fail-soft: a genesis failure is logged but does not abort startup — the phone
 * can still join discovered strands and sync. The failure resurfaces loudly at
 * {@link CadreNode.publishStrand} time if the phone later tries to create one.
 */
export async function runOwnerGenesis(cadre: CadreNode): Promise<void> {
	try {
		// Source the owner pair from the node's resolved (secure-stored) identity
		// rather than a key this module loaded itself — cadre-core owns the identity now.
		const { privateKeyB64, publicKeyB64 } = cadre.getIdentityOwnerKey();
		const controlDb = cadre.getControlDatabase();
		if (!controlDb) {
			throw new Error('control database unavailable after start; cannot run owner genesis');
		}
		await controlDb.ensureOwnerKey(publicKeyB64);
		cadre.initializeSeedBootstrap(privateKeyB64);
	} catch (err) {
		console.warn('[phone-node-config] owner self-genesis failed:', err);
	}
}
