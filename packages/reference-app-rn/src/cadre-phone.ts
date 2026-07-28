/**
 * cadre-phone.ts — CadreNode configured for a React Native phone node.
 *
 * - WebSocket + circuit-relay transports (no TCP in RN)
 * - LevelDB-backed storage via db-p2p-storage-rn (rn-leveldb under the hood)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Owner role: the phone holds the signing keys
 */

import { CadreNode, ControlFormationUsageRecorder, DEFAULT_IDENTITY_KEY_ID } from '@serfab/cadre-core';
import type {
  CadreNodeConfig,
  ControlNetworkSeed,
  ApplySeedResult,
  StrandInstance,
  StrandConfig,
  ConnectionPathSummary,
  OpenInvitation,
  FormStrandResult,
  StrandFormationDisclosure,
  KeyStore,
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC } from '@libp2p/webrtc';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import * as SecureStore from 'expo-secure-store';
import { LevelDBRawStorage, openOptimysticRNDb } from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { SecureStoreKeyStore, migrateLegacyIdentity } from './secure-key-store';
import { loadIceConfig } from './ice-config';

/**
 * db-p2p's transport-factory element type. The `webRTC()` factory from
 * `@libp2p/webrtc` carries a nominally-different `[transportSymbol]` brand than
 * db-p2p's pinned `@libp2p/interface` (the symbol is a global-registry key, so
 * they are runtime-identical). `CadreNodeConfig.network.transports` is exactly
 * this `Libp2pTransports`, so we bridge with `as unknown as TransportFactory` —
 * no `any`, no pinning five transitive packages. Mirrors the same cast in
 * `reference-app-web/src/lib/cadre-web.ts`.
 */
type TransportFactory = Libp2pTransports[number];

// ── LevelDB helpers ──────────────────────────────────────────────────────────
// Each strand (and the peer identity) gets its own LevelDB database file.

function openLevelDb(name: string) {
	return openOptimysticRNDb({
		openFn: (n, c, e) => new LevelDB(n, c, e),
		WriteBatch: LevelDBWriteBatch,
		name,
	});
}

// ── Storage factory ──────────────────────────────────────────────────────────

function createStorage(strandId: string) {
	return new LevelDBRawStorage(openLevelDb(`sereus-${strandId}`));
}

// ── Peer identity (secure enclave) ────────────────────────────────────────────
// The phone's single Ed25519 keypair (its PeerId, and the owner key derived
// from it) is held in the platform secure enclave — iOS Keychain / Android
// Keystore-encrypted storage — via expo-secure-store, NOT plaintext LevelDB.
// cadre-core loads/generates the identity through this store on start().
//
// Gating: no `requireAuthentication` (the node must come up headless / in the
// background, and a biometric-set change would invalidate the entry).
// `AFTER_FIRST_UNLOCK` lets iOS read the slot while the device is locked after
// the first unlock — needed for background / push-wake bring-up. Enabling
// biometric gating later also requires `NSFaceIDUsageDescription` in app.json
// and is unsupported under Expo Go.
const keyStore: KeyStore = new SecureStoreKeyStore(SecureStore, {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
});

// Legacy plaintext identity DB (pre-secure-store). Retained only so a one-time
// migration can lift an existing identity into the enclave on upgrade; new nodes
// never write here. This dedicated DB only ever held the single identity blob.
const PEER_IDENTITY_DB_NAME = 'sereus-peer-identity';

/**
 * Read the legacy plaintext identity protobuf bytes from {@link PEER_IDENTITY_DB_NAME},
 * or undefined when the DB is empty/absent (fresh install). That DB only ever
 * held the single identity blob (written by the old `loadOrCreateRNPeerKey`), so
 * the first entry's value IS the identity. Throws only if the DB cannot be
 * opened/iterated — {@link migrateLegacyIdentity} treats that as "read failed →
 * generate fresh". Never logs key material.
 */
async function readLegacyIdentityBytes(): Promise<Uint8Array | undefined> {
	const db = openLevelDb(PEER_IDENTITY_DB_NAME);
	try {
		const iter = db.iterator();
		try {
			const first = await iter.next();
			const value = first?.[1];
			return value && value.byteLength > 0 ? value : undefined;
		} finally {
			await iter.close();
		}
	} finally {
		await db.close();
	}
}

/**
 * Best-effort removal of the legacy plaintext identity after a successful
 * migration, so the device stops keeping an unencrypted copy of the key.
 */
async function deleteLegacyIdentity(): Promise<void> {
	const db = openLevelDb(PEER_IDENTITY_DB_NAME);
	try {
		const keys: Uint8Array[] = [];
		const iter = db.iterator({ keys: true });
		try {
			for (let entry = await iter.next(); entry; entry = await iter.next()) {
				keys.push(entry[0]);
			}
		} finally {
			await iter.close();
		}
		for (const key of keys) {
			await db.delete(key);
		}
	} finally {
		await db.close();
	}
}

// ── Singleton ────────────────────────────────────────────────────────────────

let node: CadreNode | null = null;

export interface PhoneNodeOptions {
  /** Party ID — identifies this cadre. Generated on first run. */
  partyId: string;
  /** Bootstrap multiaddrs for the drone (WebSocket). */
  bootstrapAddrs: string[];
}

/**
 * Get or create the CadreNode singleton.
 */
export function getPhoneNode(): CadreNode | null {
  return node;
}

/**
 * Start the phone CadreNode.
 * Idempotent — returns the existing node if already running.
 */
export async function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
  if (node?.isRunning) return node;

  // One-time: lift any pre-existing plaintext LevelDB identity into the secure
  // store BEFORE the node's load-or-create path runs. If we didn't, cadre-core
  // would see an empty slot and generate a fresh key, losing the device's PeerId
  // and owner identity across the upgrade. Gated on the slot being empty, so
  // it copies (and clears the legacy plaintext) at most once.
  await migrateLegacyIdentity({
    store: keyStore,
    identityKeyId: DEFAULT_IDENTITY_KEY_ID,
    readLegacy: readLegacyIdentityBytes,
    deleteLegacy: deleteLegacyIdentity,
  });

  // ICE servers (STUN/TURN) from the runtime manifest, for the WebRTC transport's
  // RTCPeerConnection. Never throws; `[]` when no manifest is configured (the
  // relay-signalled WebRTC upgrade still works on host/LAN candidates). Awaited
  // inside startPhoneNode (not hoisted to module scope) so each cold-start /
  // foreground-resume re-fetches — ICE servers may rotate. The 5 s deadline in
  // loadIceConfig bounds a hung manifest host so it cannot wedge a resume.
  const iceServers = await loadIceConfig();

  const config: CadreNodeConfig = {
    // Identity comes from the secure enclave (load on present, generate+persist on
    // first run). Mutually exclusive with `privateKey`.
    keyStore,
    identityKeyId: DEFAULT_IDENTITY_KEY_ID,
    controlNetwork: {
      partyId: opts.partyId,
      bootstrapNodes: opts.bootstrapAddrs,
    },
    profile: 'transaction',
    storage: {
      provider: createStorage,
    },
    network: {
      transports: [
        webSockets(),
        circuitRelayTransport(),
        // Phone → peer direct upgrade: a relayed `/p2p-circuit` connection
        // hole-punches to a direct `/webrtc` data path, dropping the drone out of
        // the data path (relay stays signalling-only). Brand-skew bridge —
        // runtime-safe, see TransportFactory above. No `connectionGater` override
        // is added: the phone dials a real relay/drone over `wss` (not a
        // private/loopback addr), so unlike the web reference's local insecure
        // dials it should not be gated out by libp2p's default. (This is a
        // Tier-B/device-verified assumption — see the review handoff.)
        webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
      ],
      // Phones do NOT listen (`listenAddrs: []`). Unlike web, which conditionally
      // listens on ['/p2p-circuit', '/webrtc'] when it holds a relay reservation,
      // the phone's dialed circuit reservation + the `/webrtc` upgrade are
      // advertised over the existing identify/cohort flow without a listen addr.
      listenAddrs: [], // RN cannot listen for inbound connections
    },
    strandFilter: { mode: 'all' },
    hibernation: { enabled: false },
    // Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an
    // ed25519 author key — see getChatSAppConfig). Relax the fail-closed schema
    // policy so the demo can form strands. Production nodes must leave this unset.
    requireSignedSchemas: false,
  };

  node = new CadreNode(config);
  await node.start();
  // NOTE: this await is unbounded — runOwnerGenesis is fail-SOFT (it catches
  // errors) but a control call that never settles would wedge startPhoneNode
  // forever, with no error to report. The solo (cadre-of-one) control path this
  // config uses — WebSockets-only, `listenAddrs: []`, empty bootstrap — is
  // covered by `cadre-core/test/control-database-solo.spec.ts` and completes in
  // milliseconds, so there is nothing to time-box today. If a control operation
  // ever hangs again, bound it in cadre-core (so every embedder benefits), not
  // with a per-app deadline here.
  await runOwnerGenesis(node);
  initializeFormationResponder(node);
  return node;
}

/**
 * Wire this node as a strand-formation **responder** so an invitee's
 * {@link CadreNode.formStrand} dial can be validated against the host's
 * `FormationInvite` rows.
 *
 * `createOpenInvitation`/`formStrand` lazily bring up the solicitation service
 * with NO recorder if it isn't already initialized — which would accept every
 * token blindly. Initializing it here with a {@link ControlFormationUsageRecorder}
 * (backed by the live `CadreControl.FormationInvite`/`FormationUsage` tables)
 * makes token validity + single-use enforcement real: the consent gate of the
 * closed-strand flow.
 *
 * Fail-soft: a wiring failure is logged, not thrown — minting/joining surfaces
 * the real error later. On a successful `formStrand`, the responder now both
 * provisions the bound host strand and writes its `FormationUsage` consent
 * record over libp2p (the recorder threads the redeemed token through to
 * `redeemInvitation`), and returns the host's real strand id + membership key in
 * the `FormStrandResult` — so the invite is a single `OpenInvitation` with no
 * side-channel envelope. See the README "Trust model" section.
 */
function initializeFormationResponder(cadre: CadreNode): void {
  try {
    const controlDb = cadre.getControlDatabase();
    if (!controlDb) {
      throw new Error('control database unavailable after start; cannot wire formation responder');
    }
    cadre.initializeStrandSolicitation({
      formationUsageRecorder: new ControlFormationUsageRecorder(controlDb),
    });
  } catch (err) {
    console.warn('[cadre-phone] formation responder init failed:', err);
  }
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
async function runOwnerGenesis(cadre: CadreNode): Promise<void> {
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
    console.warn('[cadre-phone] owner self-genesis failed:', err);
  }
}

/**
 * The node's owner **public** key (base64url) for out-of-band pairing /
 * enrollment. Derived from the secure-stored identity (single-key model), so it
 * is the same value an enrolling cadre pins as a trust anchor. Returns null
 * before start or if the identity is not resolved. Never exposes private material.
 */
export function getOwnerPublicKey(): string | null {
  if (!node?.isRunning) return null;
  try {
    return node.getIdentityOwnerKey().publicKeyB64;
  } catch (err) {
    // Only reachable on the ephemeral path (no keyStore) — not expected for the
    // phone node, which always configures a secure key store. Log, don't throw.
    console.warn('[cadre-phone] owner public key unavailable:', err);
    return null;
  }
}

/**
 * Stop the phone CadreNode and release resources.
 */
export async function stopPhoneNode(): Promise<void> {
  if (node) {
    await node.stop();
    node = null;
  }
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a seed received from the drone (or another owner).
 */
export async function applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
  if (!node) throw new Error('Phone node not started');
  return node.applySeed(seed);
}

/**
 * Decode a base64url-encoded seed string into a ControlNetworkSeed object.
 */
export function decodeSeed(encoded: string): ControlNetworkSeed {
  if (!node) throw new Error('Phone node not started');
  return node.decodeSeed(encoded);
}

// ── Peer helpers ─────────────────────────────────────────────────────────────

/**
 * Dial a peer by multiaddr on the running control network node.
 * Use this to add a drone (or another peer) after starting without bootstrap.
 */
export async function dialPeer(addr: string): Promise<void> {
	if (!node) throw new Error('Phone node not started');
	const libp2p = node.getControlNode();
	if (!libp2p) throw new Error('Control network not available');
	await libp2p.dial(multiaddr(addr));
}

// ── Diagnostics helpers ───────────────────────────────────────────────────────

/**
 * Classify the phone node's open connections as relayed vs direct (by transport)
 * and surface a stuck-on-relay condition. Read this from the RN debug screen.
 * Throws if the node has not been started, matching the other helpers.
 */
export function getConnectionPaths(settleWindowMs?: number): ConnectionPathSummary {
  if (!node) throw new Error('Phone node not started');
  return node.getConnectionPaths(settleWindowMs);
}

// ── Strand helpers ───────────────────────────────────────────────────────────

/**
 * Add a strand to this node.  The strand must already exist in the control
 * database (inserted via seed or direct write).
 */
export async function addStrand(config: StrandConfig): Promise<StrandInstance> {
  if (!node) throw new Error('Phone node not started');
  return node.addStrand(config);
}

// ── Formation helpers (closed-strand consent flow) ────────────────────────────

/**
 * Mint an out-of-band {@link OpenInvitation} for a closed strand. Thin
 * pass-through to {@link CadreNode.createOpenInvitation}.
 */
export async function createOpenInvitation(
  sAppId: string,
  expirationMs?: number,
): Promise<OpenInvitation> {
  if (!node) throw new Error('Phone node not started');
  return node.createOpenInvitation(sAppId, expirationMs);
}

/**
 * Persist the owner-signed `FormationInvite` row backing a minted
 * invitation token, so a later redemption validates. Thin pass-through to
 * {@link CadreNode.publishFormationInvite}.
 *
 * `strandId` binds the invite to a pre-existing host strand so a redeeming
 * `formStrand` provisions THAT strand (provision-then-record) and returns its
 * membership key, rather than the responder minting a fresh one.
 */
export async function publishFormationInvite(
  token: string,
  sAppId: string,
  options?: { expiresAtMs?: number; totalUses?: number; validationUrl?: string; strandId?: string },
): Promise<void> {
  if (!node) throw new Error('Phone node not started');
  return node.publishFormationInvite(token, sAppId, options);
}

/**
 * Perform the invitee-side consent handshake: dial the host's cadre with our
 * disclosure and let the host validate the formation token. Thin pass-through
 * to {@link CadreNode.formStrand}.
 */
export async function formStrand(
  invitation: OpenInvitation,
  disclosure?: StrandFormationDisclosure,
): Promise<FormStrandResult> {
  if (!node) throw new Error('Phone node not started');
  return node.formStrand(invitation, disclosure);
}

