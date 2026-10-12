/**
 * cadre-phone.ts — this app's phone node, built by `@serfab/cadre-rn/phone-node`.
 *
 * The kit does the bring-up: identity in the secure store, durable node-local records,
 * LevelDB storage per scope, owner genesis, single-flight start, a stop that closes
 * every database, the saved start for unattended starts, and the switch to another
 * party's cadre by invitation. This module supplies what
 * is this app's: `expo-secure-store`, rn-leveldb, the WebRTC transport, native Noise,
 * the demo's unsigned schema policy, and the storage names its devices already hold.
 * The functions below keep the module's earlier surface, so `use-cadre.ts` and the
 * push-wake path call it as before.
 */

import { CADRE_JOIN_REQUEST_MAX_APP_NAME, encodeCadreJoinRequest, resolveStunServers } from '@serfab/cadre-core';
import type {
  CadreInvitation,
  CadreInviteStatus,
  CadreNode,
  CreateCadreInvitationOptions,
  CreateCadreInvitationResult,
  ControlNetworkSeed,
  ApplySeedResult,
  StrandInstance,
  StrandConfig,
  ConnectionPathSummary,
  OpenInvitation,
  FormStrandResult,
  RelayReservationState,
  StrandFormationDisclosure,
  StrandMoveReport,
} from '@serfab/cadre-core';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { webRTC } from '@libp2p/webrtc';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
import {
  createPhoneNode,
  type DissolveFormerPartyOptions,
  type JoinCadreOptions,
  type JoinCadreResult,
  type PendingStrandMove,
  type PhoneNodeOptions,
  type PhoneNodeStatus,
  type SavedStart,
} from '@serfab/cadre-rn/phone-node';
import { buildNoiseCrypto, type NoiseCryptoMode } from '@serfab/cadre-rn/noise-crypto';
import { defaultNoiseCryptoMode } from './noise-crypto-config';
import { NODE_LOCAL_DB_NAME, NODE_LOCAL_KV_PREFIX, START_OPTIONS_KV_KEY, STORAGE_PREFIX } from './node-local-names';
import { resolveRelayAddrs } from './relay-config';

export type { JoinCadreResult, PhoneJoinProgress, PhoneNodeOptions, StrandMoveOutcome } from '@serfab/cadre-rn/phone-node';
// The errors `use-join-flow.ts` tells apart after a join, re-exported so the hook reaches the kit only
// through this module, which its tests mock.
export { FormerPartyNotEmptyError, StrandMovePendingError } from '@serfab/cadre-rn/phone-node';
export { StrandMoveNotOwnerError } from '@serfab/cadre-core';
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
  leveldb: {
    openFn: (n, c, e) => new LevelDB(n, c, e),
    WriteBatch: LevelDBWriteBatch,
    destroy: (name) => LevelDB.destroyDB(name),
  },
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
 * NOTE: a `startPhoneNode` that arrives during the stop runs after it, starts a new node
 * and saves `autoStart: true` over the Disconnect. `use-cadre`'s `stop` clears the
 * runner's options first, and a `loadSavedStartOptions` during the stop answers
 * `autoStart: false`, so the only caller left that can land there is a push wake that read
 * the record before the stop began. If that ever matters, re-check `autoStart` inside the
 * kit's start.
 */
export function stopPhoneNode(): Promise<void> {
  return phone.stop();
}

/**
 * Join the cadre an invitation names: the kit stops this app's node and starts it in that
 * party, waiting for one of its always-on machines to admit this phone. On any failure it
 * goes back to the party it left (or stays stopped when none was running) and rethrows.
 */
export async function joinCadreByInvitation(invitation: CadreInvitation, options: JoinCadreOptions = {}): Promise<JoinCadreResult> {
  return phone.joinCadre(invitation, { ...await firstLaunchJoinDefaults(), ...options });
}

/**
 * The relays a join reserves on when the kit has no start to take them from (an app that never
 * connected): the build default a Connect tap would use. The Noise mode needs nothing here: the
 * kit falls back to `noiseCrypto.defaultMode` above, which is the Connect default too.
 */
async function firstLaunchJoinDefaults(): Promise<Pick<JoinCadreOptions, 'relayAddrs'>> {
  if (phone.options || await phone.loadSavedStart()) return {};
  return { relayAddrs: resolveRelayAddrs() };
}

/** This app's peer id, the same in every party; read from the secure store when no node runs. */
export function identityPeerId(): Promise<string> {
  return phone.identityPeerId();
}

/**
 * The name this app gives itself to another Sereus app, in a join request and in the answer to
 * one: `app.json`'s `name`, cut to the request's limit (the answer's is the same).
 */
export function ownAppName(): string {
  return (Constants.expoConfig?.name?.trim() || 'Sereus reference app').slice(0, CADRE_JOIN_REQUEST_MAX_APP_NAME);
}

/** The join request this app shows under "Join my existing cadre": its peer id and {@link ownAppName}. */
export async function joinRequestText(): Promise<string> {
  return encodeCadreJoinRequest({ v: 1, peerId: await phone.identityPeerId(), appName: ownAppName() });
}

/** The strand move a join left waiting, or `undefined`. Thin pass-through to the kit's `pendingStrandMove`. */
export function pendingStrandMove(): Promise<PendingStrandMove | undefined> {
  return phone.pendingStrandMove();
}

/**
 * Adopt the waiting strand move on the running node now; `undefined` when none waits. Throws
 * `StrandMoveNotOwnerError` while this app's key is no owner of the running party.
 */
export function finishStrandMove(): Promise<StrandMoveReport | undefined> {
  return phone.finishStrandMove();
}

/**
 * Delete the local storage of the party this app founded and left. Stops and restarts the
 * running node. Refuses with `StrandMovePendingError` or `FormerPartyNotEmptyError`.
 */
export function dissolveFormerParty(options?: DissolveFormerPartyOptions): Promise<void> {
  return phone.dissolveFormerParty(options);
}

/** The options the running node was started with; null unless running. */
export function getRunningOptions(): PhoneNodeOptions | null {
  return phone.options;
}

/** The kit's view of the node: stopped, starting, joining, running or failed. */
export function getPhoneNodeStatus(): PhoneNodeStatus {
  return phone.status;
}

/**
 * The Noise crypto mode the running node was built with, for the Settings Node card to
 * show what a device run is measuring. Null unless running.
 */
export function getNoiseCryptoMode(): NoiseCryptoMode | null {
  return phone.options?.noiseCryptoMode ?? null;
}

/**
 * The node's owner public key (base64url) for out-of-band pairing; null unless running,
 * and for a member of a joined cadre that is not an owner. Never private material.
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

// ── Cadre invitation helpers (adding a device or app) ─────────────────────────

/**
 * Mint an invitation into this cadre, for one app's peer id or for whoever redeems it
 * first. Thin pass-through to {@link CadreNode.createCadreInvitation}.
 */
export async function createCadreInvitation(options: CreateCadreInvitationOptions): Promise<CreateCadreInvitationResult> {
  return running().createCadreInvitation(options);
}

/** Every cadre invitation the node holds, with its standing. Thin pass-through to {@link CadreNode.listCadreInvitations}. */
export async function listCadreInvitations(): Promise<CadreInviteStatus[]> {
  return running().listCadreInvitations();
}

/** Withdraw a cadre invitation by its key. Thin pass-through to {@link CadreNode.withdrawCadreInvitation}. */
export async function withdrawCadreInvitation(key: string): Promise<boolean> {
  return running().withdrawCadreInvitation(key);
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

