/**
 * cadre-phone.ts — CadreNode configured for a React Native phone node.
 *
 * - WebSocket + circuit-relay transports (no TCP in RN)
 * - LevelDB-backed storage via db-p2p-storage-rn (rn-leveldb under the hood)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Owner role: the phone holds the signing keys
 */

import {
  CadreNode,
  ControlFormationUsageRecorder,
  DEFAULT_IDENTITY_KEY_ID,
  PersistentTrustedOwnerStore,
  PersistentBootstrapPeerStore,
  loadOrCreateIdentityKey,
  peerKeySigner,
} from '@serfab/cadre-core';
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
import { LevelDBRawStorage, LevelDBKVStore, openOptimysticRNDb } from '@optimystic/db-p2p-storage-rn';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { SecureStoreKeyStore, type SecureStoreKeyStoreOptions } from './secure-key-store';
import {
  anchorSlotKey,
  bootstrapPeersKvKey,
  kvStoreSlot,
  secureStoreSlot,
  NODE_LOCAL_DB_NAME,
  NODE_LOCAL_KV_PREFIX,
} from './node-local-slots';
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
// Each strand — and the node-local record store — gets its own LevelDB database
// file. The peer identity is NOT here; it lives in the secure enclave (below).

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
//
// ONE options object for every secure slot this app opens — the identity key
// store here and the trusted-owner anchor slot in `startPhoneNode` — so the two
// can never drift into different gating. `secureStoreSlot` REFUSES a gated slot
// (its `null ⇒ absent` read would misreport an invalidated anchor as empty), so
// turning `requireAuthentication` on here fails startup loudly rather than
// quietly risking the anchor.
const SECURE_STORE_OPTIONS: SecureStoreKeyStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const keyStore: KeyStore = new SecureStoreKeyStore(SecureStore, SECURE_STORE_OPTIONS);

// ── Singleton ────────────────────────────────────────────────────────────────

let node: CadreNode | null = null;

/**
 * The {@link NODE_LOCAL_DB_NAME} LevelDB handle backing the bootstrap-peer
 * store. Opened at most once per process (a native handle — a leaked one blocks
 * the next open of the same database) and kept open for the node's whole life;
 * {@link stopPhoneNode} closes it.
 */
let nodeLocalDb: ReturnType<typeof openLevelDb> | null = null;

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

  // Durable node-local records: the trusted-owner anchor in the secure enclave,
  // the cold-start dial hints in app-private LevelDB. `node-local-slots.ts` has
  // the why-they-differ; cadre-core's `node-local-snapshot.ts` has the load and
  // persist policy. No migration is needed — an existing install has no persisted
  // anchor, so it cold-starts once, and `runOwnerGenesis` below re-anchors this
  // node's own key on every start while an invited phone re-anchors on its next
  // applied seed.
  //
  // A read failure PROPAGATES and fails the start, unlike the fail-soft
  // `runOwnerGenesis` / formation-responder wiring below: an unreadable anchor is
  // a refusal to start, not a silent downgrade to trusting nobody — and cold-
  // starting empty there would let the next snapshot write destroy an intact one.
  //
  // NOTE: both records are party-scoped and this app does not persist
  // `opts.partyId` (it is typed into Settings each launch — see the comment in
  // `push-wake-native.ts`). With a fresh party id per launch both slots load empty
  // every time, so survival across a relaunch is gated on the backlog ticket
  // `feat-rn-persist-node-start-options`.
  //
  // `??=`, not a plain open: `use-cadre`'s cold-start hook re-runs startPhoneNode
  // after the OS killed the node WITHOUT calling stopPhoneNode, so an
  // unconditional open would leak one native handle per resume. The
  // `node?.isRunning` early-return above keeps a healthy node from reaching here.
  nodeLocalDb ??= openLevelDb(NODE_LOCAL_DB_NAME);
  const trustedOwnerStore = await PersistentTrustedOwnerStore.open(
    secureStoreSlot(SecureStore, anchorSlotKey(opts.partyId), SECURE_STORE_OPTIONS),
    opts.partyId,
  );
  const bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
    kvStoreSlot(new LevelDBKVStore(nodeLocalDb, NODE_LOCAL_KV_PREFIX), bootstrapPeersKvKey(opts.partyId)),
    opts.partyId,
  );

  // Resolve the identity key HERE, before the manifest fetch, so the request can
  // be signed with the very key the CadreNode below then loads from the same slot
  // (we keep passing `keyStore` + `identityKeyId`, NOT `config.privateKey`, which
  // is mutually exclusive with `keyStore` and would take the identity out of the
  // secure-enclave path).
  //
  // Ordering is load-bearing: this must run before `loadIceConfig` below, whose
  // manifest request is signed with the node identity resolved here.
  //
  // Idempotent across a cold-start re-entry (`use-cadre`'s resume hook re-runs
  // startPhoneNode): it is a `get` then return, and unlike `nodeLocalDb` above it
  // opens no native handle. A rejected `get` — a cancelled biometric/unlock prompt
  // — PROPAGATES and fails the start rather than degrading to "no signer", exactly
  // as CadreNode itself behaves: generating a replacement key would silently
  // orphan the real identity.
  const identityKey = await loadOrCreateIdentityKey(keyStore, DEFAULT_IDENTITY_KEY_ID);

  // ICE servers (STUN/TURN) from the runtime manifest, for the WebRTC transport's
  // RTCPeerConnection. Never throws; `[]` when no manifest is configured (the
  // relay-signalled WebRTC upgrade still works on host/LAN candidates). Awaited
  // inside startPhoneNode (not hoisted to module scope) so each cold-start /
  // foreground-resume re-fetches — ICE servers may rotate. The 5 s deadline in
  // loadIceConfig bounds a hung manifest host so it cannot wedge a resume.
  //
  // The signer proves to a peer-bound TURN credential issuer that this device owns
  // the node key, so the issued credential can be attributed (and revoked) per peer
  // id. A rejected assertion degrades to an unauthenticated retry inside
  // `loadIceConfig` — it never costs us STUN.
  //
  // NOTE: one signed fetch per cold start / foreground resume, each burning a
  // nonce in the issuer's replay cache and a slot in its per-peer bucket
  // (RATE_LIMIT_PER_PEER_PER_MIN, default 10). A phone that resumed more than ten
  // times in a minute would take a 429, which is deliberately NOT in the
  // unauthenticated-retry list, so that resume would run STUN-less. If resume
  // churn ever gets that high, cache the manifest for the credential TTL instead
  // of re-fetching per resume.
  const iceServers = await loadIceConfig({ signer: peerKeySigner(identityKey) });

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
    trustedOwners: { store: trustedOwnerStore },
    bootstrapPeers: { store: bootstrapPeerStore },
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
  // Cleared BEFORE the stop, for the same reason `nodeLocalDb` is below: a
  // throwing `node.stop()` must not leave a module-level reference to a node
  // whose node-local LevelDB handle the `finally` has just closed — the
  // `node?.isRunning` early-return in `startPhoneNode` would hand that node back
  // and its next bootstrap-peer write would fail on a closed handle.
  const stopping = node;
  node = null;
  try {
    if (stopping) await stopping.stop();
  } finally {
    // Close the node-local LevelDB handle even when `node.stop()` threw, and even
    // when a failed `startPhoneNode` never got as far as constructing the node —
    // it is a native handle, and a leaked one blocks the next open of that
    // database. Cleared first so a failed close cannot leave a dangling handle
    // that the next start would reuse.
    const db = nodeLocalDb;
    nodeLocalDb = null;
    if (db) await db.close();
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

