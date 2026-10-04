/**
 * cadre-phone.ts — this app's phone node, built by `@serfab/cadre-rn/phone-node`.
 *
 * The kit does the bring-up: identity in the secure store, durable node-local records,
 * LevelDB storage per scope, owner genesis, single-flight start, a stop that closes
 * every database, and the saved start for unattended starts. This module supplies what
 * is this app's: `expo-secure-store`, rn-leveldb, the WebRTC transport, native Noise,
 * the demo's unsigned schema policy, and the storage names its devices already hold.
 * The functions below keep the module's earlier surface, so `use-cadre.ts` and the
 * push-wake path call it as before.
 */

import { resolveStunServers } from '@serfab/cadre-core';
import type {
  CadreNode,
  ControlNetworkSeed,
  ApplySeedResult,
  StrandInstance,
  StrandConfig,
  ConnectionPathSummary,
  OpenInvitation,
  FormStrandResult,
  RelayReservationState,
  StrandFormationDisclosure,
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC } from '@libp2p/webrtc';
import * as SecureStore from 'expo-secure-store';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import { createPhoneNode, type PhoneNodeOptions, type SavedStart } from '@serfab/cadre-rn/phone-node';
import { buildNoiseCrypto, type NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import { defaultNoiseCryptoMode } from './noise-crypto-config';
import { NODE_LOCAL_DB_NAME, NODE_LOCAL_KV_PREFIX, START_OPTIONS_KV_KEY, STORAGE_PREFIX } from './node-local-names';

export type { PhoneNodeOptions };
/** The saved start, under the name this app's code uses for it. */
export type SavedStartOptions = SavedStart;

// NOTE: the secure store is the only identity store this app reads. Development builds
// predating it kept the key in a plaintext `sereus-peer-identity` LevelDB database, and a
// build predating party-scoped storage left an unscoped `sereus-control` one. Nothing
// opens or deletes either. No shipped build wrote the first; the second cannot be adopted,
// since nothing recorded which party its rows belong to. If one is found in the field,
// delete it on start rather than reviving an import path.

/**
 * The phone node. Gating: no `requireAuthentication` (the node must come up headless, and
 * a biometric-set change would invalidate the entry); `AFTER_FIRST_UNLOCK` lets iOS read
 * the identity while the device is locked after the first unlock, which a push-wake start
 * needs. Enabling biometric gating later also requires `NSFaceIDUsageDescription` in
 * app.json and is unsupported under Expo Go.
 */
const phone = createPhoneNode({
  secureStore: SecureStore,
  secureStoreOptions: { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
  leveldb: { openFn: (n, c, e) => new LevelDB(n, c, e), WriteBatch: LevelDBWriteBatch },
  // Phone → peer direct upgrade: a relayed `/p2p-circuit` connection hole-punches to a
  // direct `/webrtc` data path, the relay staying signalling-only. Each relay is also a
  // STUN server; `EXPO_PUBLIC_STUN_URLS` overrides the derived list.
  transports: (relayAddrs) => [
    webSockets(),
    circuitRelayTransport(),
    webRTC({ rtcConfiguration: { iceServers: resolveStunServers([...relayAddrs], process.env.EXPO_PUBLIC_STUN_URLS) } }),
  ],
  noiseCrypto: { build: buildNoiseCrypto, defaultMode: defaultNoiseCryptoMode() },
  // The names installed phones' data is filed under, pinned in `node-local-names.ts`.
  names: {
    storagePrefix: STORAGE_PREFIX,
    nodeLocalDb: NODE_LOCAL_DB_NAME,
    nodeLocalKvPrefix: NODE_LOCAL_KV_PREFIX,
    savedStartKey: START_OPTIONS_KV_KEY,
  },
  // Demo opt-out: the chat sApp config is unsigned (its `id` is a name, not an ed25519
  // author key — see getChatSAppConfig). Production nodes must leave the default.
  configure: (config) => ({ ...config, requireSignedSchemas: false }),
});

/** The running node, or null. */
export function getPhoneNode(): CadreNode | null {
  return phone.node;
}

/**
 * The options the node last started with, and whether it should start again unattended;
 * `undefined` when none are saved or the record is unusable. A read fault propagates, so
 * the caller can say the settings could not be read rather than behave as if there were
 * none.
 */
export function loadSavedStartOptions(): Promise<SavedStartOptions | undefined> {
  return phone.loadSavedStart();
}

/**
 * Start the phone node, or join the start in flight. A caller whose options differ gets
 * the running node anyway: whatever is running wins, and only the call that did the work
 * saves its options.
 */
export function startPhoneNode(opts: PhoneNodeOptions): Promise<CadreNode> {
  return phone.start(opts);
}

/**
 * Stop the node: the user logging out (Settings → Disconnect is the only caller), so the
 * next launch or push wake does not start it again by itself.
 *
 * NOTE: a `startPhoneNode` that arrives during the stop starts a new node and saves
 * `autoStart: true` over the Disconnect. `use-cadre`'s `stop` clears the runner's options
 * first, so the only caller left that can land there is a push wake that read the record
 * just before; if a new unattended caller of `startPhoneNode` appears, make a start wait
 * for an in-flight stop and re-check `autoStart`.
 */
export function stopPhoneNode(): Promise<void> {
  return phone.stop();
}

/**
 * The Noise crypto mode the running node was built with, for the Settings Node card to
 * show what a device run is measuring. Null unless running.
 */
export function getNoiseCryptoMode(): NoiseCryptoMode | null {
  return phone.options?.noiseCryptoMode ?? null;
}

/**
 * The node's owner public key (base64url) for out-of-band pairing; null unless running.
 * Never private material.
 */
export function getOwnerPublicKey(): string | null {
  return phone.ownerPublicKey();
}

/** The running node, or a throw naming why there is none. */
function running(): CadreNode {
  const node = phone.node;
  if (!node) throw new Error('Phone node not started');
  return node;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a seed received from the drone (or another owner).
 */
export async function applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
  return running().applySeed(seed);
}

/**
 * Decode a base64url-encoded seed string into a ControlNetworkSeed object.
 */
export function decodeSeed(encoded: string): ControlNetworkSeed {
  return running().decodeSeed(encoded);
}

// ── Peer helpers ─────────────────────────────────────────────────────────────

/**
 * Dial a peer by multiaddr on the running control network node.
 * Use this to add a drone (or another peer) after starting without bootstrap.
 */
export async function dialPeer(addr: string): Promise<void> {
	const libp2p = running().getControlNode();
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
  return running().getConnectionPaths(settleWindowMs);
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
  return phone.node?.getRelayReservationState() ?? { status: 'none', addrs: [], circuitAddrs: [], error: null, retryAtMs: null };
}

// ── Strand helpers ───────────────────────────────────────────────────────────

/**
 * Add a strand to this node.  The strand must already exist in the control
 * database (inserted via seed or direct write).
 */
export async function addStrand(config: StrandConfig): Promise<StrandInstance> {
  return running().addStrand(config);
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
  return running().createOpenInvitation(sAppId, expirationMs);
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
  return running().publishFormationInvite(token, sAppId, options);
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
  return running().formStrand(invitation, disclosure);
}

