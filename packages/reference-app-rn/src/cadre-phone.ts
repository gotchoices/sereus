/**
 * cadre-phone.ts — CadreNode configured for a React Native phone node.
 *
 * - WebSocket + circuit-relay transports (no TCP in RN)
 * - LevelDB-backed storage via db-p2p-storage-rn (rn-leveldb under the hood)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Authority role: the phone holds the signing keys
 */

import { CadreNode, authorityKeyFromLibp2p, ControlFormationUsageRecorder } from '@serfab/cadre-core';
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
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { PrivateKey } from '@libp2p/interface';
import {
  LevelDBRawStorage,
  loadOrCreateRNPeerKey,
  openOptimysticRNDb,
} from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';

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

// ── Peer identity ───────────────────────────────────────────────────────────
// Persist a single Ed25519 keypair so the phone keeps the same PeerId across
// restarts. LevelDB on-disk is not secure storage (not Keychain/Keystore) —
// acceptable for v1; secure storage is tracked separately.

const PEER_IDENTITY_DB_NAME = 'sereus-peer-identity';

async function loadOrCreatePhoneKey(): Promise<PrivateKey> {
	const db = openLevelDb(PEER_IDENTITY_DB_NAME);
	try {
		return await loadOrCreateRNPeerKey(db);
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

  const privateKey = await loadOrCreatePhoneKey();

  const config: CadreNodeConfig = {
    privateKey,
    controlNetwork: {
      partyId: opts.partyId,
      bootstrapNodes: opts.bootstrapAddrs,
    },
    profile: 'transaction',
    storage: {
      provider: createStorage,
    },
    network: {
      transports: [webSockets(), circuitRelayTransport()],
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
  await runAuthorityGenesis(node, privateKey);
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
 * the real error later. NOTE: this wires only the responder's token-validation
 * gate; the formation protocol does not yet thread the redeemed token to a
 * provisioner nor write the `FormationUsage` consent record on the wire (a
 * cadre-core follow-up — see the README "Trust model" section).
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
 * Self-genesis the phone as its own party authority. A node must enroll an
 * authority key before it can author control-network writes — notably the
 * authority-signed `Strand` INSERT that {@link CadreNode.publishStrand} performs
 * when the phone creates a strand. This mirrors `cadre-cli start --authority`
 * and the web reference app's `runAuthorityGenesis`: bridge the libp2p identity
 * into a base64url authority keypair, run the idempotent genesis `AuthorityKey`
 * insert, then bring up seed-bootstrap (which also lets the node author its own
 * `CadrePeer` row via {@link CadreNode.registerSelf}).
 *
 * Authority model (demo): the FIRST node to enroll its key into the shared
 * control DB becomes the founding authority; `ensureAuthorityKey` is then a
 * no-op for later joiners that have already synced it. A second phone can always
 * JOIN a discovered strand (joining needs no authority), but only an enrolled
 * authority can publish NEW strands.
 *
 * Fail-soft: a genesis failure is logged but does not abort startup — the phone
 * can still join discovered strands and sync. The failure resurfaces loudly at
 * {@link CadreNode.publishStrand} time if the phone later tries to create one.
 */
async function runAuthorityGenesis(cadre: CadreNode, privateKey: PrivateKey): Promise<void> {
  try {
    const { privateKeyB64, publicKeyB64 } = authorityKeyFromLibp2p(privateKey);
    const controlDb = cadre.getControlDatabase();
    if (!controlDb) {
      throw new Error('control database unavailable after start; cannot run authority genesis');
    }
    await controlDb.ensureAuthorityKey(publicKeyB64);
    cadre.initializeSeedBootstrap(privateKeyB64);
  } catch (err) {
    console.warn('[cadre-phone] authority self-genesis failed:', err);
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
 * Apply a seed received from the drone (or another authority).
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
 * Persist the authority-signed `FormationInvite` row backing a minted
 * invitation token, so a later redemption validates. Thin pass-through to
 * {@link CadreNode.publishFormationInvite}.
 */
export async function publishFormationInvite(
  token: string,
  sAppId: string,
  options?: { expiresAtMs?: number; totalUses?: number; validationUrl?: string },
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

