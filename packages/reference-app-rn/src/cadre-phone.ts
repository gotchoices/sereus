/**
 * cadre-phone.ts — CadreNode configured for a React Native phone node.
 *
 * - WebSocket + circuit-relay transports (no TCP in RN)
 * - LevelDB-backed storage via db-p2p-storage-rn (rn-leveldb under the hood)
 * - Transaction profile (Ring Zulu only, intermittent connectivity)
 * - Owner role: the phone holds the signing keys
 *
 * This module does the native wiring. The config it feeds (profile, listen policy,
 * strand filter) and the owner genesis live in `phone-node-config.ts`, which has no
 * native imports so a Node test can build the same node.
 */

import {
  CadreNode,
  ControlFormationUsageRecorder,
  DEFAULT_IDENTITY_KEY_ID,
  PersistentTrustedOwnerStore,
  PersistentBootstrapPeerStore,
  PersistentEnrolledMachineStore,
  PersistentStrandNetworkStateStore,
  loadOrCreateIdentityKey,
  peerKeySigner,
} from '@serfab/cadre-core';
import type {
  ControlNetworkSeed,
  ApplySeedResult,
  StrandInstance,
  StrandConfig,
  ConnectionPathSummary,
  OpenInvitation,
  FormStrandResult,
  RelayReservationState,
  StrandFormationDisclosure,
  KeyStore,
  DurableSlot,
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
  enrolledMachinesKvKey,
  strandNetworkKvKey,
  kvStoreSlot,
  secureStoreSlot,
  NODE_LOCAL_DB_NAME,
  NODE_LOCAL_KV_PREFIX,
  START_OPTIONS_KV_KEY,
} from './node-local-slots';
import { parseSavedStartOptions, serializeSavedStartOptions, type SavedStartOptions } from './start-options';
import { loadIceConfig } from './ice-config';
import { buildPhoneNodeConfig, runOwnerGenesis, type PhoneNodeOptions } from './phone-node-config';
import { buildNoiseCrypto, type NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import { defaultNoiseCryptoMode } from './noise-crypto-config';

export type { PhoneNodeOptions, SavedStartOptions };

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
//
// One LevelDB database per cadre-core storage SCOPE. cadre-core guarantees every
// scope key is already within `[a-z0-9._-]`, so it goes straight into the
// filename with no escaping. The control scope carries the party id
// (`controlStorageScope`), so switching parties in Settings now lands on a
// different database — `sereus-control-<hex party id>` — instead of every
// party sharing one `sereus-control`.
//
// NOTE: a dev device that ran a build predating the party scoping still has that
// unscoped `sereus-control` database on disk. Nothing opens or deletes it. It
// cannot be adopted: its rows belong to whichever party happened to be configured
// when they were written, and nothing recorded which — that ambiguity IS the
// defect the scoping fixed, so merging it into any party's store would reintroduce
// it. Same posture as the abandoned `sereus-peer-identity` database noted below:
// leaving a stale file on a dev device beats deleting a user's blocks on upgrade.

function createStorage(scope: string) {
	return new LevelDBRawStorage(openLevelDb(`sereus-${scope}`));
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
//
// NOTE: the enclave is the only identity store this app reads. Development
// builds predating it kept the key in a plaintext `sereus-peer-identity`
// LevelDB database; nothing opens or deletes that database any more, so a dev
// device still holding one keeps an unencrypted key on disk indefinitely while
// the app generates a fresh identity into the enclave. No shipped build ever
// wrote it. If one is ever found in the field, delete it on start rather than
// reviving an import path.
const SECURE_STORE_OPTIONS: SecureStoreKeyStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const keyStore: KeyStore = new SecureStoreKeyStore(SecureStore, SECURE_STORE_OPTIONS);

// ── Singleton ────────────────────────────────────────────────────────────────

let node: CadreNode | null = null;

/**
 * The Noise crypto mode {@link node} was built with, recorded here rather than read
 * back out of cadre-core, which keeps only the implementation. Set before
 * `node.start()`, so a failed start leaves it set; {@link getNoiseCryptoMode} gates on
 * `isRunning`.
 */
let nodeNoiseCryptoMode: NoiseCryptoMode | null = null;

/**
 * The options {@link node} was built with, with the Noise mode resolved — recorded
 * only once a start SUCCEEDS, so {@link stopPhoneNode} can mark exactly that
 * configuration as no longer auto-starting, and a start that failed has nothing for it
 * to write.
 */
let nodeOptions: PhoneNodeOptions | null = null;

/**
 * The start in flight, if any. A launch auto-start, a push-wake cold start, the
 * background runner's resume and a Connect tap can all overlap; each gets this one
 * promise rather than building a second `CadreNode`.
 */
let starting: Promise<CadreNode> | null = null;

/**
 * The {@link NODE_LOCAL_DB_NAME} LevelDB handle backing the non-trust-bearing
 * node-local records and the saved start options. Opened at most once per process
 * (a native handle — a leaked one blocks the next open of the same database) by
 * {@link nodeLocalDbHandle}, and kept open until {@link stopPhoneNode} closes it.
 */
let nodeLocalDb: ReturnType<typeof openLevelDb> | null = null;

/**
 * The open {@link nodeLocalDb}, opening it on first use. Reuse, not a fresh open:
 * `use-cadre`'s cold-start hook re-runs startPhoneNode after the OS killed the node
 * WITHOUT calling stopPhoneNode, and the launch-time read of the saved start options
 * opens it before any start, so an unconditional open would leak a native handle. The
 * open is synchronous, so two callers cannot both find it unset.
 */
function nodeLocalDbHandle(): ReturnType<typeof openLevelDb> {
  nodeLocalDb ??= openLevelDb(NODE_LOCAL_DB_NAME);
  return nodeLocalDb;
}

/** A {@link DurableSlot} over one key of the node-local LevelDB. */
function nodeLocalKvSlot(key: string): DurableSlot {
  return kvStoreSlot(new LevelDBKVStore(nodeLocalDbHandle(), NODE_LOCAL_KV_PREFIX), key);
}

/**
 * Get or create the CadreNode singleton.
 */
export function getPhoneNode(): CadreNode | null {
  return node;
}

/**
 * The options the node last started with, and whether it should start again
 * unattended (see `start-options.ts`); `undefined` when none are saved or the record
 * is unusable. A read FAULT propagates, so the caller can say the settings could not
 * be read rather than behave as if there were none.
 */
export async function loadSavedStartOptions(): Promise<SavedStartOptions | undefined> {
  return parseSavedStartOptions(await nodeLocalKvSlot(START_OPTIONS_KV_KEY).load());
}

/** Best-effort: a failed write is logged and changes nothing about the node. */
async function saveStartOptions(saved: SavedStartOptions): Promise<void> {
  try {
    await nodeLocalKvSlot(START_OPTIONS_KV_KEY).save(serializeSavedStartOptions(saved));
  } catch (err) {
    console.warn('[cadre-phone] could not save the start options:', err);
  }
}

/**
 * Start the phone CadreNode.
 * Idempotent — returns the start in flight if there is one, else the existing node if
 * it is running. A caller whose options differ gets that node anyway: whatever is
 * running wins, and only the call that did the work saves its options.
 */
export async function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
  if (starting) return starting;
  if (node?.isRunning) return node;
  starting = buildAndStartNode(opts).finally(() => {
    starting = null;
  });
  return starting;
}

async function buildAndStartNode(opts: PhoneNodeOptions): Promise<CadreNode> {
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
  // Every record is party-scoped. They survive a relaunch because the party id does:
  // it is saved with the other start options below, and app launch starts from them.
  // A party id this phone has not started with before — a blank Party ID field mints
  // one — starts every slot empty.
  const trustedOwnerStore = await PersistentTrustedOwnerStore.open(
    secureStoreSlot(SecureStore, anchorSlotKey(opts.partyId), SECURE_STORE_OPTIONS),
    opts.partyId,
  );
  const bootstrapPeerStore = await PersistentBootstrapPeerStore.open(
    nodeLocalKvSlot(bootstrapPeersKvKey(opts.partyId)),
    opts.partyId,
  );
  // The party's enrolled-machine count, from which the control node declares its
  // block-repair yardstick at bring-up — before the database that could answer the
  // question live exists. Same LevelDB as the dial hints, its own key. Unlike the
  // two records above, an unreadable slot here does NOT fail the start: the count is
  // a repair hint, so `open` cold-starts and the node declares nothing.
  const enrolledMachineStore = await PersistentEnrolledMachineStore.open(
    nodeLocalKvSlot(enrolledMachinesKvKey(opts.partyId)),
    opts.partyId,
  );
  // Each strand node's saved network state — the FRET routing table it re-imports
  // after a relaunch, with every peer's signed address record, so a chat with another
  // party re-meshes without a fresh invitation. Same LevelDB as the dial hints, its own
  // key, and not trust-bearing: FRET verifies each record at import.
  const strandNetworkStateStore = await PersistentStrandNetworkStateStore.open(
    nodeLocalKvSlot(strandNetworkKvKey(opts.partyId)),
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
  // startPhoneNode): it is a `get` then return, and unlike `nodeLocalDbHandle` it
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

  const noiseCryptoMode = opts.noiseCryptoMode ?? defaultNoiseCryptoMode();
  const built = new CadreNode(buildPhoneNodeConfig({
    ...opts,
    // `undefined` for 'off', which leaves libp2p-noise's stock pure-JS crypto.
    noiseCrypto: buildNoiseCrypto(noiseCryptoMode),
    // Identity comes from the secure enclave (see `keyStore` above).
    keyStore,
    storageProvider: createStorage,
    transports: [
      webSockets(),
      circuitRelayTransport(),
      // Phone → peer direct upgrade: a relayed `/p2p-circuit` connection
      // hole-punches to a direct `/webrtc` data path, dropping the drone out of
      // the data path (relay stays signalling-only). Brand-skew bridge —
      // runtime-safe, see TransportFactory above. The permissive dial gater the
      // phone needs lives in `buildPhoneNodeConfig` (`phone-node-config.ts`),
      // which explains why: a node borrowed from a cadre-host on the same Wi-Fi
      // is a private `ws://` address, which libp2p's browser-build gater refuses
      // by default.
      webRTC({ rtcConfiguration: { iceServers } }) as unknown as TransportFactory,
    ],
    trustedOwnerStore,
    bootstrapPeerStore,
    enrolledMachineStore,
    strandNetworkStateStore,
  }));
  node = built;
  nodeNoiseCryptoMode = noiseCryptoMode;
  await built.start();
  // NOTE: this await is unbounded — runOwnerGenesis is fail-SOFT (it catches
  // errors) but a control call that never settles would wedge startPhoneNode
  // forever, with no error to report. The solo (cadre-of-one) control path this
  // config uses — WebSockets-only, `listenAddrs: []`, empty bootstrap — is
  // covered by `cadre-core/test/control-database-solo.spec.ts` and completes in
  // milliseconds, so there is nothing to time-box today. If a control operation
  // ever hangs again, bound it in cadre-core (so every embedder benefits), not
  // with a per-app deadline here.
  await runOwnerGenesis(built);
  await initializeFormationResponder(built);
  // Saved only now, so a start that failed — a typo in Settings — never replaces the
  // last configuration that actually came up. The Noise mode is saved resolved, not as
  // "the build default", so a later build's default does not change a device that
  // already ran (`relay-config.ts` says the same of the relays).
  nodeOptions = { ...opts, noiseCryptoMode };
  await saveStartOptions({ options: nodeOptions, autoStart: true });
  return built;
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
async function initializeFormationResponder(cadre: CadreNode): Promise<void> {
  try {
    const controlDb = cadre.getControlDatabase();
    if (!controlDb) {
      throw new Error('control database unavailable after start; cannot wire formation responder');
    }
    await cadre.initializeStrandSolicitation({
      formationUsageRecorder: new ControlFormationUsageRecorder(controlDb),
    });
  } catch (err) {
    console.warn('[cadre-phone] formation responder init failed:', err);
  }
}

/**
 * The Noise crypto mode the running node was built with, for the Settings Node card
 * to show what a device run is measuring. Null before start and after stop.
 */
export function getNoiseCryptoMode(): NoiseCryptoMode | null {
  return node?.isRunning ? nodeNoiseCryptoMode : null;
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
  // Disconnect tapped during a start (a launch auto-start, a push wake) stops the node
  // that start produces rather than racing it. The start's failure is reported to its
  // own caller; here it only means there may be less to tear down.
  if (starting) {
    await starting.catch(() => undefined);
  }
  // Stopping is the user logging out (Settings → Disconnect is the only caller), so
  // the next launch or push wake must not start the node again by itself. Written
  // while the node is still the singleton and the handle still open; an OS kill runs
  // none of this, which is why `autoStart` survives one.
  if (nodeOptions) {
    await saveStartOptions({ options: nodeOptions, autoStart: false });
  }
  // Cleared BEFORE the stop, for the same reason `nodeLocalDb` is below: a
  // throwing `node.stop()` must not leave a module-level reference to a node
  // whose node-local LevelDB handle the `finally` has just closed — the
  // `node?.isRunning` early-return in `startPhoneNode` would hand that node back
  // and its next bootstrap-peer write would fail on a closed handle.
  //
  // NOTE: a `startPhoneNode` that arrives after this point and before the `finally`
  // builds a node on the handle the `finally` then closes, and saves `autoStart: true`
  // over the Disconnect. `use-cadre`'s `stop` clears the runner's options first, so the
  // only caller left that can land here is a push wake that read the record just before
  // the save above; if a new unattended caller of `startPhoneNode` appears, make a start
  // wait for an in-flight stop and re-check `autoStart`.
  const stopping = node;
  node = null;
  nodeNoiseCryptoMode = null;
  nodeOptions = null;
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

/**
 * The node's relay-reservation posture — whether this phone currently holds a
 * `/p2p-circuit` address, and if not, whether anything is still trying. Read LIVE
 * from the node on every call: a reservation can be lost after start (the relay
 * restarts, the connection drops), and a cached `reserved` would let the app
 * promise an invitation nobody could redeem.
 *
 * Unlike {@link getConnectionPaths} beside it, this does NOT throw before the node
 * starts — it is read by the chat banner, which renders in every lifecycle state,
 * so "no node" is answered as the posture it is. Mirrors `getRelayState` in
 * `reference-app-web/src/lib/cadre-web.ts`.
 */
export function getRelayState(): RelayReservationState {
  return node?.getRelayReservationState() ?? { status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null };
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

