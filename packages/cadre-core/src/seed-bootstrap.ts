import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { digest, sign, verify, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p, Connection } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { type ControlStream, writeFrame, withDeadline, exchangeFrame, readStreamToEnd } from './control-stream.js';
import type {
  ControlNetworkSeed,
  SeedPeer,
  SeedMessage,
  SeedAckMessage,
  AuthorizePeerOptions,
  ApplySeedResult,
  AddDroneOptions,
  AddPhoneOptions,
  DroneInitResult,
  InviteResult,
  CadreInvite,
  PeerAddressRecord,
  DeviceTokenRecord
} from './types.js';
import type { ControlDatabase } from './control-database.js';
import { generateStampId } from './control-database.js';
import { canonicalJson } from './canonical-json.js';
import { cadrePeerVoucherDigest, cadrePeerRemoveDigest, deviceTokenAddDigest, deviceTokenRemoveDigest, revocationDigest } from './peer-authorization.js';
import {
  type SeedTrustPolicy,
  type SeedTrustDecision,
  anchoredTrustPolicy,
} from './seed-trust-policy.js';
import type { TrustedOwnerStore } from './trusted-owner-store.js';

const log = debug('sereus:cadre:seed-bootstrap');

/** Protocol ID for seed delivery */
export const SEED_PROTOCOL = '/sereus/seed/1.0.0';

/** Maximum seed message size (1MB) */
const MAX_SEED_SIZE = 1024 * 1024;

/** Default time the receiver waits for an inbound seed frame before aborting (ms). */
const DEFAULT_SEED_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound seed streams a single peer can pin open. */
const DEFAULT_MAX_CONCURRENT_SEEDS = 100;

/** Default time the sender waits for a seed delivery (dial + ack read) before aborting (ms). */
const DEFAULT_SEED_DELIVER_TIMEOUT_MS = 10_000;

/**
 * Decode a 4-byte big-endian length-prefixed frame; returns the body bytes.
 *
 * Guards every parse site against malformed input: a buffer too short to hold
 * the prefix, a declared length exceeding `maxLength`, and a declared length
 * exceeding the bytes actually present. Returns a view (`subarray`, no copy) —
 * the body is handed straight to `TextDecoder`.
 */
export function decodeLengthPrefixedFrame(data: Uint8Array, maxLength = MAX_SEED_SIZE): Uint8Array {
  if (data.length < 4) {
    throw new Error(`Seed frame too short: ${data.length} bytes, need ≥4 for length prefix`);
  }
  // Pass the full (buffer, byteOffset, byteLength) triple so the read is correct
  // even for a non-zero-offset view, not just the fresh zero-offset arrays
  // current callers pass.
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  const available = data.length - 4;
  if (length > maxLength) {
    throw new Error(`Seed frame declares length ${length} exceeding max ${maxLength}`);
  }
  if (length > available) {
    throw new Error(`Seed frame declares length ${length} but only ${available} body bytes present`);
  }
  return data.subarray(4, 4 + length);
}

/**
 * Derive the base64url ed25519 public key embedded in an Ed25519 libp2p PeerId.
 *
 * An Ed25519 PeerId is an identity multihash of the public key, so
 * `peerIdFromString(id).publicKey.raw` is the 32-byte ed25519 key whose
 * base64url form matches the `OwnerKey.Key` representation (and
 * `ed25519KeyPairFromLibp2p().publicKeyB64`). Returns null for a non-Ed25519
 * id, a missing embedded key, or any parse failure — callers treat null as
 * "not an owner" rather than throwing.
 */
export function ed25519PublicKeyB64FromPeerId(peerId: string): string | null {
  try {
    const parsed = peerIdFromString(peerId);
    if (parsed.type !== 'Ed25519' || !parsed.publicKey) {
      return null;
    }
    return uint8ArrayToString(parsed.publicKey.raw, 'base64url');
  } catch {
    return null;
  }
}

/**
 * Canonical byte representation of the authenticated seed fields.
 *
 * Routes both the creator (`createSeed`) and the verifier
 * (`validateSeedSignature`) through one builder so the signed bytes are
 * identical regardless of key insertion order. `canonicalJson` sorts keys and
 * drops `undefined`, so the signed payload is exactly `{ partyId, peers }` —
 * the fields the producer actually emits.
 */
export function canonicalSeedPayload(
  seed: Pick<ControlNetworkSeed, 'partyId' | 'peers'>
): string {
  return canonicalJson({ partyId: seed.partyId, peers: seed.peers });
}

/**
 * An {@link ApplySeedResult} for a seed refused before the owner-dial loop ran,
 * so the dial counters read zero rather than being absent.
 */
function seedRejected(error: string): ApplySeedResult {
  return { success: false, peersAdded: 0, error, ownerDialsAttempted: 0, ownerDialsFailed: 0 };
}

/**
 * Configuration for the SeedBootstrapService
 */
export interface SeedBootstrapConfig {
  /** Party ID for this cadre */
  partyId: string;
  /** Owner private key for signing seeds and peer authorizations (base64url) */
  ownerPrivateKey?: string;
  /** Owner public key (base64url) - derived from private key if not provided */
  ownerPublicKey?: string;
  /**
   * Optional async resolver returning the multiaddrs to embed in invites.
   * When unset, `libp2pNode.getMultiaddrs()` is used. Hosts behind NAT supply
   * this (via `@serfab/cadre-host`'s NatService) to substitute the host's
   * DDNS hostname and externally-mapped port.
   */
  inviteAddressResolver?: () => Promise<string[]>;
  /**
   * Trust anchor for incoming seeds. Decides whether a signature-verified
   * `signerKey` should be trusted, against the receiver's anchored owner
   * keys (NOT the seed body). Defaults to `anchoredTrustPolicy()`, which
   * rejects any signer not already in {@link trustedOwners}. An enrollment
   * caller can pass a per-seed override to `applySeed` instead.
   *
   * A `CadreNode` forwards its node-wide `CadreNodeConfig.seedTrustPolicy` here
   * — that is the only seam the inbound libp2p seed-protocol handler can use,
   * since a network-delivered seed has no per-call override.
   */
  trustPolicy?: SeedTrustPolicy;
  /**
   * The node-local, NON-replicated trusted-owner anchor. Supplies
   * `SeedTrustContext.knownOwnerKeys` for every {@link applySeed}, and receives
   * a key accepted via a pin/TOFU (see `SeedTrustDecision.anchorAs`).
   *
   * Deliberately NOT `ControlDatabase.getOwnerKeys()`: the replicated
   * `OwnerKey` table is pollutable — any connecting node can genesis-insert its
   * own key and let it replicate — so a seed signed by a stranger's self-issued
   * owner key would pass a table-anchored check. A `CadreNode` passes its
   * `getTrustedOwnerStore()` here. Unset (e.g. a directly-constructed service in
   * a test) means an EMPTY anchor: only a pinned/TOFU policy can accept a seed.
   */
  trustedOwners?: TrustedOwnerStore;
  /**
   * Time the inbound seed handler waits for the seed frame before aborting the
   * read (ms). Defaults to {@link DEFAULT_SEED_READ_TIMEOUT_MS}. Bounds a
   * buggy/compromised own-cadre node that opens a stream and never half-closes.
   */
  seedReadTimeoutMs?: number;
  /**
   * Cap on concurrent inbound seed streams (defaults to
   * {@link DEFAULT_MAX_CONCURRENT_SEEDS}). Over the cap, a non-accepting ack is
   * returned without applying any seed.
   */
  maxConcurrentSeeds?: number;
  /**
   * Time {@link SeedBootstrapService.deliverSeed} waits for the whole exchange —
   * dial, write, ack read — before aborting (ms). Defaults to
   * {@link DEFAULT_SEED_DELIVER_TIMEOUT_MS}. Bounds the SENDER against a seed
   * target that accepts the stream and then never replies; the target is a
   * not-yet-trusted node during onboarding, so this is the more exposed
   * direction than the receiver knobs above.
   */
  seedDeliverTimeoutMs?: number;
}

/**
 * Event callbacks for seed-related events
 */
export interface SeedEventCallbacks {
  /** Called when a seed is received via the protocol */
  onSeedReceived?: (partyId: string, peerId: string) => void;
  /**
   * Called when a seed is successfully applied.
   *
   * `seed` is the applied seed itself: the inbound protocol handler applies it
   * INSIDE the service, so this callback is the only seam through which a
   * `CadreNode` sees a wire-delivered seed's contents — which it needs to
   * retain the owner-flagged peers as cold-start bootstrap dial targets.
   */
  onSeedApplied?: (partyId: string, peersAdded: number, seed: ControlNetworkSeed) => void;
  /** Called when seed application fails */
  onSeedError?: (partyId: string, error: string) => void;
}

/**
 * SeedBootstrapService handles control network seed generation and delivery.
 *
 * Seeds solve the cold-start problem: new nodes need control data to validate
 * connections, but can't get data without connecting first. Seeds pre-populate
 * the new node's cache with peer information.
 */
export class SeedBootstrapService {
  private readonly config: SeedBootstrapConfig;
  private libp2pNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  private readonly ownerPublicKey: string | null;
  private readonly trustPolicy: SeedTrustPolicy;
  private readonly seedReadTimeoutMs: number;
  private readonly maxConcurrentSeeds: number;
  private readonly seedDeliverTimeoutMs: number;
  /** In-flight inbound seed streams, used to enforce {@link maxConcurrentSeeds}. */
  private activeStreams = 0;
  private eventCallbacks: SeedEventCallbacks = {};

  constructor(config: SeedBootstrapConfig) {
    this.config = config;
    this.trustPolicy = config.trustPolicy ?? anchoredTrustPolicy();
    this.seedReadTimeoutMs = config.seedReadTimeoutMs ?? DEFAULT_SEED_READ_TIMEOUT_MS;
    this.maxConcurrentSeeds = config.maxConcurrentSeeds ?? DEFAULT_MAX_CONCURRENT_SEEDS;
    this.seedDeliverTimeoutMs = config.seedDeliverTimeoutMs ?? DEFAULT_SEED_DELIVER_TIMEOUT_MS;

    // Derive public key from private key if not provided
    if (config.ownerPrivateKey && !config.ownerPublicKey) {
      this.ownerPublicKey = getPublicKey(
        config.ownerPrivateKey,
        'ed25519',
        'base64url',
        'base64url'
      ) as string;
    } else {
      this.ownerPublicKey = config.ownerPublicKey ?? null;
    }

    log('SeedBootstrapService created for party: %s', config.partyId);
  }

  /**
   * Set event callbacks for seed-related events.
   * Used by CadreNode to emit events.
   */
  setEventCallbacks(callbacks: SeedEventCallbacks): void {
    this.eventCallbacks = callbacks;
  }

  /**
   * Whether this service holds an owner private key, i.e. can produce the
   * owner signatures that gate `CadrePeer` / `DeviceToken` inserts, deletes,
   * and re-authorizations. A seed-listener-only service (`enableSeedListener`,
   * no owner key) returns false: it can receive/apply seeds but cannot author
   * or re-issue owner writes. Used by the write-while-alone re-replication
   * drain to skip owner work on a non-owner node.
   */
  canAuthorize(): boolean {
    return !!this.config.ownerPrivateKey;
  }

  /**
   * Initialize the service with libp2p node and control database.
   *
   * `registerHandler` (default true) gates registration of the shared inbound
   * `/sereus/seed/1.0.0` handler on `libp2pNode`. Persistent services
   * (`initializeSeedBootstrap`, `enableSeedListener`) own that handler and leave
   * it on. The throwaway temp services CadreNode builds in `applySeed` /
   * `dialInvite` pass `false`: they only need the stored `libp2pNode` /
   * `controlDatabase` for dialing and known-key lookup, and must NOT bind a
   * discarded closure to the shared node (a handler leak, and a second
   * `handle()` of the same protocol throws `DuplicateProtocolHandlerError`).
   */
  initialize(
    libp2pNode: Libp2p,
    controlDatabase: ControlDatabase,
    options?: { registerHandler?: boolean }
  ): void {
    this.libp2pNode = libp2pNode;
    this.controlDatabase = controlDatabase;

    // Register the seed protocol handler unless the caller opted out (temp services).
    if (options?.registerHandler ?? true) {
      this.registerProtocolHandler();
    }

    log('SeedBootstrapService initialized');
  }

  /**
   * Authorize a new peer to join the cadre.
   * Signs a membership voucher with the owner key and inserts into CadrePeer table.
   *
   * The owner vouches the `PublicKey <-> PeerId` binding: rather than trust a
   * caller-supplied key, the binding is enforced by construction — `PublicKey` is
   * DERIVED from the (Ed25519) `peerId`. A non-Ed25519 peer id yields a null
   * `PublicKey`, and such a row can never be self-updated (it has no key to
   * verify against), which is correct. The row is inserted with a fresh
   * `UpdatedAt` but no self-signature (`Sig` null) — the owner cannot produce
   * the peer's self-signature, so the peer must self-publish (see
   * {@link CadreNode.registerSelf}) before the row resolves.
   */
  async authorizePeer(options: AuthorizePeerOptions): Promise<void> {
    const { peerId, multiaddrs } = options;
    log('Authorizing peer: %s', peerId);
    // CadrePeer.Multiaddr stores a comma-joined list; use '' when no addrs provided.
    const multiaddrStr = multiaddrs?.length ? multiaddrs.join(',') : '';
    await this.insertCadrePeerRow({
      peerId,
      publicKey: ed25519PublicKeyB64FromPeerId(peerId),
      multiaddr: multiaddrStr,
      updatedAt: Date.now(),
      sig: null,
    });
    log('Peer %s authorized successfully', peerId);
  }

  /**
   * Owner-signed INSERT of this node's OWN self-signed address record.
   *
   * Used by {@link CadreNode.registerSelf} when the node is not yet a member and
   * is its own owner (it holds the owner key): the row is owner-signed
   * (satisfying `AuthorizedInsert`) AND carries a valid self-`Sig`, so it resolves
   * immediately without a follow-up self-update.
   */
  async insertSelfPeerRecord(record: PeerAddressRecord): Promise<void> {
    await this.insertCadrePeerRow({
      peerId: record.peerId,
      publicKey: record.publicKey,
      multiaddr: record.addrs.join(','),
      updatedAt: record.updatedAt,
      sig: record.sig,
    });
  }

  /**
   * Shared owner-signed `CadrePeer` INSERT. Mints a fresh single-use `StampId`
   * and signs the voucher digest `digest('CadreControl.CadrePeer', 'vouch', peerId, stampId)`
   * ({@link cadrePeerVoucherDigest})
   * with the owner key (satisfying `AuthorizedInsert`), then writes the full record
   * row with the vouching (owner, signature) persisted into VouchOwner/VouchSig.
   * The owner signature does NOT cover the address columns — those are vouched only
   * as far as the owner asserts them, and a peer's own `Sig` (when present) is what
   * makes the row resolvable.
   *
   * Wrapped in {@link ControlDatabase.mutateCadrePeer} so the admitted peer's traffic is
   * let in by the write itself — see that method for why the seam lives on the control DB.
   */
  private async insertCadrePeerRow(row: {
    peerId: string;
    publicKey: string | null;
    multiaddr: string;
    updatedAt: number;
    sig: string | null;
  }): Promise<void> {
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    // Fresh single-use nonce; the voucher signs the 'vouch'-tagged digest over
    // (peerId, stampId) so a captured insert can't be replayed — live rows via the
    // unique column, removed rows via Revocation retirement (CadrePeer.NotRevoked) —
    // and can't be repurposed as a delete (which signs a distinct 'remove'-tagged digest).
    const stampId = generateStampId(row.peerId);
    const signature = this.signDigest(cadrePeerVoucherDigest(row.peerId, stampId));
    const db = this.controlDatabase.getDatabase();
    await this.controlDatabase.mutateCadrePeer('peer-insert', async () => {
      // Persist the vouching (owner, signature) onto the row (VouchOwner/VouchSig)
      // — identical to the context pair, which the AuthorizedInsert constraint binds — so a
      // reader can later re-check the voucher against its node-local trusted-owner anchor.
      await db.exec(`
        insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig, StampId, VouchOwner, VouchSig)
          with context OwnerKey = ?, Signature = ?
          values (?, ?, ?, ?, ?, ?, ?, ?)
      `, [this.ownerPublicKey, signature, row.peerId, row.publicKey, row.multiaddr, row.updatedAt, row.sig, stampId, this.ownerPublicKey, signature]);
    });
  }

  /**
   * Owner-signed INSERT of a peer's OWN self-signed `DeviceToken` row.
   *
   * Counterpart to {@link insertSelfPeerRecord} for the device-token registry: the
   * row is owner-signed (satisfying `DeviceToken.AuthorizedInsert` via the
   * 'add'-tagged digest, {@link deviceTokenAddDigest}) AND carries the peer's
   * own self-`Sig` over the token payload. The owner signature covers the WHOLE row
   * (every column, ending in a freshly minted single-use `StampId`) — but covering the
   * token contents is not the same as vouching them: the peer's `Sig` (verified at
   * resolve time against the bound `CadrePeer.PublicKey`) is what makes the row
   * resolvable. Used by {@link CadreNode.registerDeviceToken} for the first publish
   * when the node is its own owner.
   *
   * The stamp is per-INSERT, so a re-register after a clear mints a fresh one and a
   * fresh signature — unaffected by the cleared row's retired stamp
   * (`DeviceToken.NotRevoked`).
   */
  async insertSelfDeviceToken(record: DeviceTokenRecord): Promise<void> {
    const stampId = generateStampId(record.peerId);
    const signature = this.signDigest(deviceTokenAddDigest({ ...record, stampId }));
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?, ?)
    `, [this.ownerPublicKey, signature, record.peerId, record.platform, record.token, record.updatedAt, record.sig, stampId]);
    log('Device token inserted (owner-signed): %s', record.peerId);
  }

  /**
   * Owner-signed DELETE of a peer's `DeviceToken` row (logout / token
   * invalidation). The `DeviceToken.AuthorizedDelete` constraint validates an owner
   * signature over the 'remove'-tagged digest bound to the STORED row's
   * (PeerId, StampId) ({@link deviceTokenRemoveDigest}) — deliberately distinct from
   * the insert digest, so a captured insert approval can never be replayed to clear a
   * token. Like {@link removePeer} for `CadrePeer`, clearing a token requires the
   * owner key.
   *
   * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in
   * ONE transaction — `DeviceToken.RevocationRecorded` refuses a bare delete, and
   * without the tombstone the stamp would free up and the never-expiring insert
   * approval (which the cleared device holds a copy of) would re-seat the token. The
   * tombstone carries its OWN owner signature ({@link revocationDigest}): retiring a
   * stamp permanently forecloses that row, so it is an owner action in its own right.
   *
   * A no-op when the row is already absent (mirrors {@link removePeer}).
   */
  async deleteDeviceToken(peerId: string): Promise<void> {
    // Fail fast on a keyless service BEFORE the DB read, so a non-owner gets the
    // owner-key error rather than a silent no-op on an absent row.
    this.requireOwnerPrivateKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const stampId = await this.controlDatabase.queryDeviceTokenStampId(peerId);
    if (stampId === null) {
      log('deleteDeviceToken: no DeviceToken row for %s (already absent)', peerId);
      return;
    }
    const signature = this.signDigest(deviceTokenRemoveDigest(peerId, stampId));
    const revocationSignature = this.signDigest(revocationDigest('DeviceToken', peerId, stampId));

    const db = this.controlDatabase.getDatabase();
    await this.controlDatabase.inTransaction('deleteDeviceToken', async () => {
      await db.exec(`
        delete from CadreControl.DeviceToken
          with context OwnerKey = ?, Signature = ?
          where PeerId = ?
      `, [this.ownerPublicKey, signature, peerId]);
      await db.exec(`
        insert into CadreControl.Revocation (TableName, RowKey, StampId)
          with context OwnerKey = ?, Signature = ?
          values ('DeviceToken', ?, ?)
      `, [this.ownerPublicKey, revocationSignature, peerId, stampId]);
    });

    log('Device token removed (owner-signed, stamp retired): %s', peerId);
  }

  /**
   * Return the configured owner private key, or throw if none is set. The single
   * precondition gate for every owner-signed write. {@link removePeer} /
   * {@link reauthorizePeer} read the row's `StampId` from the DB BEFORE they sign, so
   * they call this up front — otherwise a keyless service would either surface the
   * wrong "Control database not initialized" error or, worse, silently no-op when the
   * target row is absent (the early `stampId === null` return) instead of rejecting.
   */
  private requireOwnerPrivateKey(): string {
    if (!this.config.ownerPrivateKey) {
      throw new Error('Owner private key required to authorize peers');
    }
    return this.config.ownerPrivateKey;
  }

  /**
   * Sign a base64url digest with the owner key (ed25519). The single place the
   * owner private key is applied; callers pass the canonical domain-tagged digest for
   * the specific action ({@link cadrePeerVoucherDigest} / {@link cadrePeerRemoveDigest} /
   * {@link deviceTokenAddDigest} / {@link deviceTokenRemoveDigest}). Throws if no
   * owner key is set.
   */
  private signDigest(digestB64url: string): string {
    return sign(
      digestB64url,
      this.requireOwnerPrivateKey(),
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
  }

  /**
   * Remove a peer from the cadre by owner signature.
   *
   * The `CadrePeer.AuthorizedDelete` (`check on delete`) constraint validates a
   * signature over the DISTINCT 'remove'-tagged digest
   * `digest('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId)`
   * ({@link cadrePeerRemoveDigest}) by an owner key — deliberately NOT the
   * insert voucher digest, so the row's stored `VouchSig` can never be replayed to delete.
   *
   * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in ONE
   * transaction — `CadrePeer.RevocationRecorded` refuses a bare delete, and without the
   * tombstone the stamp would free up and the original admission approval (which never
   * expires, and which the removed peer holds a copy of) would re-seat the row.
   *
   * The tombstone is separately owner-signed ({@link revocationDigest}, satisfying
   * `Revocation.Authorized`): retiring a stamp evicts that peer party-wide and permanently
   * forecloses re-admitting the row, so it is an owner action in its own right, not a
   * side effect the delete's signature covers.
   */
  async removePeer(peerId: string): Promise<void> {
    // Fail fast on a keyless service BEFORE any DB read: a non-owner cannot sign the
    // remove digest, and this precedence (owner key, then control DB) is what the
    // unit contract asserts.
    this.requireOwnerPrivateKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    // Delete is authorized by a signature over a DISTINCT 'remove'-scoped digest bound to
    // the row's CURRENT StampId — so the row's stored voucher (a signature over the
    // voucher digest) can never be replayed to authorize a delete.
    const stampId = await this.controlDatabase.queryCadrePeerStampId(peerId);
    if (stampId === null) {
      log('removePeer: no CadrePeer row for %s (already absent)', peerId);
      return;
    }
    const signature = this.signDigest(cadrePeerRemoveDigest(peerId, stampId));
    const revocationSignature = this.signDigest(revocationDigest('CadrePeer', peerId, stampId));

    log('Removing peer: %s', peerId);

    const controlDatabase = this.controlDatabase;
    const db = controlDatabase.getDatabase();
    // The transaction lives INSIDE the mutateCadrePeer body, so the membership notify
    // lands strictly after commit() and a rolled-back removal throws out without notifying.
    await controlDatabase.mutateCadrePeer('peer-remove', () =>
      controlDatabase.inTransaction('removePeer', async () => {
        await db.exec(`
          delete from CadreControl.CadrePeer
            with context OwnerKey = ?, Signature = ?
            where PeerId = ?
        `, [this.ownerPublicKey, signature, peerId]);
        await db.exec(`
          insert into CadreControl.Revocation (TableName, RowKey, StampId)
            with context OwnerKey = ?, Signature = ?
            values ('CadrePeer', ?, ?)
        `, [this.ownerPublicKey, revocationSignature, peerId, stampId]);
      }));

    log('Peer %s removed successfully (stamp retired)', peerId);
  }

  /**
   * Owner "re-touch" of an existing `CadrePeer` membership row: bump
   * `UpdatedAt` under the owner branch of `CadrePeer.AuthorizedUpdate` (a
   * signature over the voucher digest {@link cadrePeerVoucherDigest} — the same
   * construction the insert uses) so the row is re-emitted as a fresh,
   * broadcasting transaction.
   *
   * This is the write-while-alone re-replication primitive
   * (`control-write-ensure-replicated`): a membership row that committed
   * local-only (its block's cluster ≤1 at insert) is pushed to the cohort once it
   * grows, by re-issuing this monotonic bump. It is an UPDATE (not the original
   * INSERT) because the row already exists locally; a re-INSERT would hit the
   * `PeerId` PK. Only the freshness stamp changes — `PublicKey` / `Multiaddr` /
   * `Sig` are left intact — so it is safe over a row whose peer has not
   * self-published (`Sig` null); the caller must skip a row that already carries a
   * self-`Sig` (that row is the owning peer's to refresh, and bumping `UpdatedAt`
   * without re-signing would invalidate its self-signature).
   *
   * @param peerId - the membership row to re-touch.
   * @param updatedAt - the strictly-increasing freshness stamp to write.
   * @throws if no owner private key is configured (a non-owner cannot
   *   re-sign another peer's row) or the control database is not initialized.
   */
  async reauthorizePeer(peerId: string, updatedAt: number): Promise<void> {
    // Fail fast on a keyless service before any DB read (see removePeer): a non-owner
    // cannot re-sign the voucher, and must not silently no-op on an absent row.
    this.requireOwnerPrivateKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    // The owner branch of AuthorizedUpdate verifies a voucher over the 'vouch'-tagged
    // digest (PeerId, StampId) and re-binds VouchOwner/VouchSig. Sign over the row's CURRENT StampId
    // (unchanged by this re-touch) and re-set the voucher columns so the branch passes.
    // NOTE: this rebinds VouchOwner to THIS node's owner key, and the authorized-membership
    // predicate (`CadreNode.listAuthorizedMembers`) now judges rows by that column against
    // each reader's node-local anchor. Benign today because the only caller — the
    // write-while-alone drain — re-touches solely rows this node itself authored
    // (`pendingPeerWrites`), so the voucher is rewritten to the key that already signed it.
    // If a future path ever lets one owner re-touch a row a DIFFERENT owner vouched, the
    // voucher silently flips: readers that anchor the original owner but not this one would
    // drop a legitimate member. Such a path must re-vouch deliberately (or preserve the
    // existing VouchOwner/VouchSig) rather than inherit this rebinding.
    const stampId = await this.controlDatabase.queryCadrePeerStampId(peerId);
    if (stampId === null) {
      log('reauthorizePeer: no CadrePeer row for %s (nothing to re-touch)', peerId);
      return;
    }
    const signature = this.signDigest(cadrePeerVoucherDigest(peerId, stampId));
    const db = this.controlDatabase.getDatabase();
    // Notifies like the insert/remove paths even though this is "only" a re-touch: it
    // rewrites VouchOwner/VouchSig, which the authorized-membership predicate judges on, so
    // it CAN change the member set. Keeping the rule uniform ("every CadrePeer mutator
    // notifies") beats a per-method exception the next reader has to relearn.
    await this.controlDatabase.mutateCadrePeer('peer-reauthorize', async () => {
      await db.exec(`
        update CadreControl.CadrePeer
          with context OwnerKey = ?, Signature = ?
          set UpdatedAt = ?, VouchOwner = ?, VouchSig = ?
          where PeerId = ?
      `, [this.ownerPublicKey, signature, updatedAt, this.ownerPublicKey, signature, peerId]);
    });
    log('Peer %s re-authorized (UpdatedAt=%d) for write-while-alone re-replication', peerId, updatedAt);
  }

  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an owner.
   */
  async createSeed(): Promise<ControlNetworkSeed> {
    if (!this.config.ownerPrivateKey || !this.ownerPublicKey) {
      throw new Error('Owner key required to create seeds');
    }
    
    if (!this.controlDatabase || !this.libp2pNode) {
      throw new Error('Service not initialized');
    }
    
    log('Creating seed for party: %s', this.config.partyId);
    
    // Query all peers from the control database
    const peers = await this.queryPeers();
    
    // Create the seed data (without signature)
    const seedData = {
      partyId: this.config.partyId,
      peers,
    };
    
    // Sign the seed over its canonical byte representation
    const seedJson = canonicalSeedPayload(seedData);
    const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;
    const signature = sign(
      seedDigest,
      this.config.ownerPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    
    const seed: ControlNetworkSeed = {
      ...seedData,
      signature,
      signerKey: this.ownerPublicKey,
    };
    
    log('Created seed with %d peers', peers.length);
    return seed;
  }

  /**
   * Apply a seed to populate the peer cache and enable connections.
   *
   * Validates the seed signature, then evaluates a trust anchor for the
   * `signerKey` that does NOT come from the seed body: the receiver's
   * node-local {@link SeedBootstrapConfig.trustedOwners} anchor, optionally
   * augmented by pinned keys or TOFU via the configured/overriding
   * `SeedTrustPolicy`. A forged self-asserting seed — one that merely lists its
   * own signer as an owner peer — no longer passes, and neither does one signed
   * by a key a stranger genesis-inserted into the replicated `OwnerKey` table.
   *
   * A key accepted via a pin/TOFU is persisted into the anchor (the policy says
   * so via `SeedTrustDecision.anchorAs`), so the next seed from that owner is
   * anchored without re-supplying the invite.
   *
   * @param seed - The seed to apply (already transport-decoded).
   * @param options.trustPolicy - Per-call policy override (e.g. a
   *   `pinnedKeyTrustPolicy` derived from a `CadreInvite`) used instead of the
   *   service-configured default for this seed only.
   */
  async applySeed(
    seed: ControlNetworkSeed,
    options?: { trustPolicy?: SeedTrustPolicy }
  ): Promise<ApplySeedResult> {
    if (!this.libp2pNode) {
      return seedRejected('Service not initialized');
    }

    // NOTE: `seed.partyId` is never checked against `config.partyId`. Nothing
    // downstream reads it — trust is keyed on `signerKey` vs the anchor, and the
    // anchor a stray-party seed could write into belongs to THIS party, which
    // only a caller-supplied pin for that signer can reach. If applying a seed
    // ever branches on its partyId (or the anchor becomes multi-party), reject a
    // mismatch here instead.
    log('Applying seed for party: %s', seed.partyId);

    // Validate the seed signature
    if (!this.validateSeedSignature(seed)) {
      return seedRejected('Invalid seed signature');
    }

    // Evaluate the trust anchor for the signer key. The known-owner set comes
    // from the receiver's NODE-LOCAL anchor — never from the seed itself, and
    // never from the replicated OwnerKey table (a stranger can genesis-insert
    // its own key there and let it replicate into every peer's copy). A node
    // whose anchor was never seeded, with no policy override, sees an empty set
    // and rejects.
    const knownOwnerKeys = this.config.trustedOwners?.all() ?? new Set<string>();
    const policy = options?.trustPolicy ?? this.trustPolicy;
    const decision = await policy.evaluate({
      partyId: seed.partyId,
      signerKey: seed.signerKey,
      knownOwnerKeys,
    });
    if (!decision.trusted) {
      return seedRejected(decision.reason ?? 'Signer key not trusted by trust policy');
    }
    await this.anchorAcceptedSigner(seed.signerKey, decision);

    let peersAdded = 0;

    // Add peers to the peer store
    for (const peer of seed.peers) {
      try {
        // Import peer multiaddrs into the peer store
        if (peer.multiaddrs.length > 0) {
          const peerId = peerIdFromString(peer.peerId);
          const addrs = peer.multiaddrs.map(ma => multiaddr(ma));

          await this.libp2pNode.peerStore.merge(peerId, {
            multiaddrs: addrs
          });

          peersAdded++;
          log('Added peer to store: %s with %d addrs', peer.peerId, addrs.length);
        }
      } catch (error) {
        log('Failed to add peer %s: %o', peer.peerId, error);
      }
    }

    // Dial owner peers to establish connections. Best-effort and COUNTED: an
    // owner that is momentarily down leaves this node seeded but unconnected,
    // which the caller can only see if the outcome is reported (see
    // `ApplySeedResult.ownerDialsFailed`). Recovery is not this loop's job —
    // `CadreNode.dialColdStartBootstrap` retries these same addresses on every
    // control-cohort reconcile pass until the control database has siblings.
    // `createSeed` projects EVERY CadrePeer row, so an owner applying a seed
    // minted after it joined finds ITSELF in the owner list. Dialing self always
    // throws, which would report a healthy owner as "seeded but stranded".
    // Optional-chained: partial libp2p handles (unit-test doubles) omit `peerId`,
    // and an undefined self simply matches nothing.
    const selfPeerId = this.libp2pNode.peerId?.toString();
    let ownerDialsAttempted = 0;
    let ownerDialsFailed = 0;
    for (const peer of seed.peers.filter(p => p.isOwner)) {
      if (peer.multiaddrs.length === 0 || peer.peerId === selfPeerId) {
        continue;
      }
      ownerDialsAttempted++;
      try {
        const addr = multiaddr(peer.multiaddrs[0]);

        log('Dialing owner peer: %s', peer.peerId);
        await this.libp2pNode.dial(addr);
      } catch (error) {
        ownerDialsFailed++;
        log('Failed to dial peer %s: %o', peer.peerId, error);
        // Continue - not all peers need to be reachable
      }
    }

    log('Applied seed: %d peers added, %d/%d owner dial(s) failed',
      peersAdded, ownerDialsFailed, ownerDialsAttempted);
    return { success: true, peersAdded, ownerDialsAttempted, ownerDialsFailed };
  }

  /**
   * Persist a signer that a pin/TOFU accepted into the node-local anchor, so a
   * later seed from the same owner is anchored without re-supplying the invite
   * or re-prompting. Only the policy decides this happens (`anchorAs` is unset
   * when the key was already anchored, so a plain re-apply writes nothing) and
   * `trust()` is idempotent, keeping the original provenance for a known key.
   *
   * Failure to PERSIST does not fail the seed: `trust()` reflects the key in the
   * in-memory anchor synchronously, so this seed and the rest of the session are
   * unaffected — only durability across a restart is lost, and that is logged.
   *
   * NOTE: anchoring a key can flip `CadrePeer` rows ALREADY present from
   * unauthorized to authorized, which the write-driven membership-gate refresh
   * (`ControlDatabase.mutateCadrePeer`) cannot see — no row was written. Every
   * anchor mutation today rides seed application, and both seed paths refresh the
   * gate explicitly afterwards (`CadreNode.applySeed`, `onSeedApplied`). If some
   * future path anchors an owner OUTSIDE seed application, it owes the same
   * `CadreNode.refreshMembershipGate()` — or the anchor needs its own hub.
   */
  private async anchorAcceptedSigner(signerKey: string, decision: SeedTrustDecision): Promise<void> {
    if (!decision.anchorAs || !this.config.trustedOwners) {
      return;
    }
    try {
      await this.config.trustedOwners.trust(signerKey, decision.anchorAs);
      log('Anchored seed signer %s as %s', signerKey, decision.anchorAs);
    } catch (error) {
      log('Failed to persist accepted seed signer into the trusted-owner anchor: %o', error);
    }
  }

  /**
   * Encode a seed for out-of-band delivery (e.g., QR code, copy/paste).
   */
  encodeSeed(seed: ControlNetworkSeed): string {
    const json = JSON.stringify(seed);
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode a seed from base64url encoding.
   */
  decodeSeed(encoded: string): ControlNetworkSeed {
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as ControlNetworkSeed;
  }

  /**
   * Deliver a seed directly to a peer via the /sereus/seed/1.0.0 protocol.
   *
   * Sender hardening: the whole exchange — dial, write, ack read — is bounded by
   * {@link seedDeliverTimeoutMs}, and the ack is capped at {@link MAX_SEED_SIZE}.
   * The target is a NOT-YET-TRUSTED node the instigator chose to dial during
   * onboarding, so an unbounded read here is strictly more exposed than the
   * membership-gated receiver paths: without the bound a target that accepts the
   * stream and never replies parks this call forever, and one that streams
   * arbitrary bytes as a fake ack exhausts memory.
   */
  async deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }
    // Capture the node so the closure below needs no non-null assertion.
    const node = this.libp2pNode;
    const addr = multiaddr(targetMultiaddr);

    log('Delivering seed to: %s', targetMultiaddr);

    return await withDeadline(
      this.seedDeliverTimeoutMs,
      `Seed delivery to ${targetMultiaddr}`,
      (signal) => this.sendSeed(node, addr, seed, signal),
    );
  }

  /**
   * Open one stream to the target, send the seed frame, half-close, and read the ack.
   *
   * `signal` is the deadline from {@link deliverSeed}: it goes to `dialProtocol` so
   * a timeout during connect aborts the dial, and into {@link exchangeFrame} so a
   * timeout after the stream is open resets it — releasing the otherwise unbounded
   * ack-read.
   *
   * Deliberately NOT `runOnLimitedConnection`: a wake sets it because a wake is a
   * tiny frame over a relay, whereas a seed is up to 1MB and this delivery path
   * does not dial relay addresses today. Changing that is a separate decision.
   */
  private async sendSeed(
    node: Libp2p,
    addr: Multiaddr,
    seed: ControlNetworkSeed,
    signal: AbortSignal,
  ): Promise<SeedAckMessage> {
    const rawStream = await node.dialProtocol(addr, SEED_PROTOCOL, { signal });

    const message: SeedMessage = {
      partyId: seed.partyId,
      peers: seed.peers,
      signature: seed.signature,
      signerKey: seed.signerKey,
    };

    const ack = await exchangeFrame(
      rawStream as unknown as ControlStream,
      signal,
      message,
      (stream) => this.readSeedAck(stream),
      'Seed delivery aborted by timeout',
    );

    log('Seed delivery response: accepted=%s', ack.accepted);
    return ack;
  }

  /**
   * Read the ack frame a delivery target writes back, bounded by
   * {@link seedDeliverTimeoutMs} and capped at {@link MAX_SEED_SIZE} — an
   * untrusted target must not be able to stream unlimited bytes as a fake ack.
   * Decoding runs inside {@link exchangeFrame}'s `try`, so a malformed or
   * non-JSON ack resets the stream rather than leaking it.
   */
  private async readSeedAck(stream: ControlStream): Promise<SeedAckMessage> {
    const data = await readStreamToEnd(stream, {
      maxBytes: MAX_SEED_SIZE,
      timeoutMs: this.seedDeliverTimeoutMs,
      label: 'Seed ack',
    });
    const body = decodeLengthPrefixedFrame(data, MAX_SEED_SIZE);
    return JSON.parse(new TextDecoder().decode(body)) as SeedAckMessage;
  }

  /**
   * Get this node's circuit relay address for inclusion in seeds.
   * Returns null if no relay address is available.
   */
  async getRelayAddress(): Promise<string | null> {
    if (!this.libp2pNode) {
      return null;
    }

    const addrs = this.libp2pNode.getMultiaddrs();

    // Find a circuit relay address
    const relayAddr = addrs.find(addr => addr.toString().includes('/p2p-circuit/'));

    return relayAddr?.toString() ?? null;
  }

  /**
   * Validate a seed's signature.
   */
  validateSeedSignature(seed: ControlNetworkSeed): boolean {
    try {
      // Reconstruct the signed bytes via the shared canonical payload builder so
      // verification is independent of key order. The payload is the fixed
      // `{ partyId, peers }` the producer emits.
      const seedJson = canonicalSeedPayload(seed);
      const seedDigest = digest([seedJson], 'sha256', 'base64url') as string;

      return verify(
        seedDigest,
        seed.signature,
        seed.signerKey,
        'ed25519',
        'base64url',
        'base64url',
        'base64url'
      );
    } catch (error) {
      log('Seed signature validation failed: %o', error);
      return false;
    }
  }

  /**
   * Query peers from the control database.
   *
   * Owner identity is sourced from the `OwnerKey` table, not from the
   * transport peer ID. An Ed25519 libp2p PeerId embeds its public key (identity
   * multihash), so each peer's ed25519 key is derivable from its `PeerId`; a
   * peer is an owner iff that derived key is in the `OwnerKey` set.
   * This makes any owner node markable — not just the local one — and ties
   * `isOwner` to the control table rather than to `peerId === self`.
   *
   * NOTE: this is the one owner lookup deliberately left on the REPLICATED
   * table rather than the node-local anchor. `SeedPeer.isOwner` is a dial hint
   * — the receiver dials owner-flagged peers first — not a trust decision, and
   * the receiver re-derives real trust from its own anchor. So a polluted table
   * costs at most a wasted dial, while anchoring here would silently drop
   * legitimate co-owners this node never pinned. If `isOwner` ever gates
   * anything the receiver TRUSTS, move it to the anchor.
   */
  private async queryPeers(): Promise<SeedPeer[]> {
    if (!this.controlDatabase) {
      return [];
    }

    const ownerKeys = await this.controlDatabase.getOwnerKeys();
    const db = this.controlDatabase.getDatabase();
    const peers: SeedPeer[] = [];

    // Query CadrePeer table
    for await (const row of db.eval('select PeerId, Multiaddr from CadreControl.CadrePeer')) {
      const peerId = row.PeerId as string;
      const multiaddr = row.Multiaddr as string | null;

      // Derive the peer's ed25519 key from its PeerId; a non-Ed25519 peer or an
      // unparsable id yields null and is treated as a non-owner rather than
      // failing the whole seed creation.
      const pubKeyB64 = ed25519PublicKeyB64FromPeerId(peerId);
      const isOwner = pubKeyB64 !== null && ownerKeys.has(pubKeyB64);

      peers.push({
        peerId,
        multiaddrs: multiaddr ? multiaddr.split(',') : [],
        isOwner,
        ...(isOwner ? { publicKey: pubKeyB64 } : {}),
      });
    }

    return peers;
  }

  /**
   * Register the seed protocol handler. The inbound closure just delegates to
   * {@link handleSeedStream} — extracted as a method so it has a unit-test seam
   * (mirroring wake's `handleStream`) the inline closure never had.
   */
  private registerProtocolHandler(): void {
    if (!this.libp2pNode) return;

    void this.libp2pNode.handle(SEED_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleSeedStream(rawStream as ControlStream, remotePeerId);
    });

    log('Registered seed protocol handler: %s', SEED_PROTOCOL);
  }

  /**
   * Read one inbound seed frame, apply it, and write the ack.
   *
   * Hardened against a buggy/compromised own-cadre node: a concurrency cap (over
   * {@link maxConcurrentSeeds}, reply without applying), a read timeout (a peer
   * that never half-closes is aborted inside `readStreamToEnd`), and the existing
   * malformed/oversized-frame guard — all reported as a non-accepting
   * {@link SeedAckMessage} rather than a dropped/hung stream.
   */
  private async handleSeedStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    log('Incoming seed delivery from: %s', remotePeerId);

    if (this.activeStreams >= this.maxConcurrentSeeds) {
      log('Rejecting seed from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrentSeeds);
      const ack: SeedAckMessage = { accepted: false, reason: 'Too many concurrent seed deliveries' };
      try {
        writeFrame(stream, ack);
      } catch {
        // Ignore send errors on the reject path.
      }
      try {
        await stream.close();
      } catch {
        // Ignore close errors.
      }
      return;
    }

    this.activeStreams++;
    try {
      // Read the seed frame to EOF (bounded + size-capped), then decode it.
      const data = await readStreamToEnd(stream, {
        maxBytes: MAX_SEED_SIZE,
        timeoutMs: this.seedReadTimeoutMs,
        label: 'Seed',
      });

      const messageBody = decodeLengthPrefixedFrame(data);
      const messageJson = new TextDecoder().decode(messageBody);
      const message = JSON.parse(messageJson) as SeedMessage;

      // Emit seed received event
      this.eventCallbacks.onSeedReceived?.(message.partyId, remotePeerId);

      // Convert to seed and apply
      const seed: ControlNetworkSeed = {
        partyId: message.partyId,
        peers: message.peers,
        signature: message.signature,
        signerKey: message.signerKey,
      };

      const result = await this.applySeed(seed);

      // Emit appropriate event based on result
      if (result.success) {
        this.eventCallbacks.onSeedApplied?.(seed.partyId, result.peersAdded, seed);
      } else {
        this.eventCallbacks.onSeedError?.(seed.partyId, result.error ?? 'Unknown error');
      }

      const ack: SeedAckMessage = { accepted: result.success, reason: result.error };
      writeFrame(stream, ack);
    } catch (error) {
      log('Error handling seed delivery: %o', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Emit error event
      this.eventCallbacks.onSeedError?.(this.config.partyId, errorMessage);

      // Send error acknowledgment (best-effort on the still-open write side).
      const ack: SeedAckMessage = { accepted: false, reason: errorMessage };
      try {
        writeFrame(stream, ack);
      } catch {
        // Ignore send errors
      }
    } finally {
      this.activeStreams--;
      try {
        await stream.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  /**
   * Shutdown the service.
   */
  async shutdown(): Promise<void> {
    if (this.libp2pNode) {
      await this.libp2pNode.unhandle(SEED_PROTOCOL);
    }
    this.libp2pNode = null;
    this.controlDatabase = null;
    log('SeedBootstrapService shutdown');
  }

  // ============================================================================
  // Helper Functions for Common Scenarios
  // ============================================================================

  /**
   * Add a drone to the cadre (phone/server adds provider-hosted node).
   *
   * Use this when you've spawned a drone via provider API and received its
   * peer ID and multiaddrs. This method:
   * 1. Authorizes the drone peer
   * 2. Creates a seed including all current peers
   * 3. Returns the seed for sending to provider API
   *
   * @param options - Drone peer info from provider API
   * @returns Seed and encoded seed for drone initialization
   */
  async addDrone(options: AddDroneOptions): Promise<DroneInitResult> {
    const { dronePeerId, droneMultiaddrs } = options;

    log('Adding drone: %s', dronePeerId);

    // 1. Authorize the new drone peer
    await this.authorizePeer({ peerId: dronePeerId, multiaddrs: droneMultiaddrs });

    // 2. Create seed with current state
    const seed = await this.createSeed();

    // 3. Encode for transport
    const encodedSeed = this.encodeSeed(seed);

    log('Drone %s added, seed created with %d peers', dronePeerId, seed.peers.length);

    return { seed, encodedSeed };
  }

  /**
   * Create an invite for a phone to join the cadre.
   *
   * Use this when a server (public IP) wants to invite a phone (NAT'd).
   * The invite is shared out-of-band (QR code, link, etc.) and contains
   * the server's address so the phone can dial in.
   *
   * @param token - Optional invite token for validation
   * @param expiresIn - Optional expiration time in milliseconds
   * @returns Invite and encoded invite for sharing
   */
  async createInvite(token?: string, expiresIn?: number): Promise<InviteResult> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }

    log('Creating invite for phone');

    // Get this node's dialable addresses. When an inviteAddressResolver is
    // configured (typically by `@serfab/cadre-host`'s NatService), it takes
    // priority — it may substitute a DDNS hostname and externally-mapped
    // port for the raw LAN multiaddrs libp2p reports.
    let ownerAddrs: string[];
    if (this.config.inviteAddressResolver) {
      try {
        ownerAddrs = await this.config.inviteAddressResolver();
      } catch (err) {
        log('inviteAddressResolver threw, falling back to libp2pNode.getMultiaddrs(): %o', err);
        ownerAddrs = this.libp2pNode.getMultiaddrs().map(a => a.toString());
      }
    } else {
      ownerAddrs = this.libp2pNode.getMultiaddrs().map(a => a.toString());
    }

    // Carry the cadre's owner keys out-of-band so a cold-start invitee can pin
    // the trusted owner set before applying any seed.
    //
    // Sourced ONLY from this node's own anchor, never from the replicated
    // OwnerKey table: the invitee anchors whatever arrives here
    // (CadreNode.trustOwnerKeys with source 'invite'), so handing over the
    // pollutable table would let a stranger's genesis-inserted key ride an
    // otherwise-legitimate invite straight into the new node's anchor —
    // poisoning the very store this whole trust chain rests on. No anchor wired
    // (a directly-constructed service) means no pins to hand out: an invite
    // without `ownerKeys` costs the invitee an extra out-of-band step, whereas a
    // table-sourced one silently hands it an unanchored key.
    const ownerKeys = Array.from(this.config.trustedOwners?.all() ?? []);

    const now = Date.now();
    const invite: CadreInvite = {
      partyId: this.config.partyId,
      ownerAddrs,
      ownerKeys: ownerKeys.length ? ownerKeys : undefined,
      token,
      createdAt: now,
      expiresAt: expiresIn ? now + expiresIn : undefined,
    };

    const encodedInvite = this.encodeInvite(invite);

    log('Invite created with %d owner addresses, %d owner keys', ownerAddrs.length, ownerKeys.length);

    return { invite, encodedInvite };
  }

  /**
   * Accept a phone connection using an invite.
   *
   * Use this when a phone dials in with an invite token. This method:
   * 1. Validates the token if provided
   * 2. Authorizes the phone peer
   *
   * After this, the phone can sync the control database normally.
   *
   * @param options - Phone peer info and invite token
   * @param issuedInvite - The original invite for validation
   */
  async acceptPhone(options: AddPhoneOptions, issuedInvite?: CadreInvite): Promise<void> {
    const { phonePeerId, token } = options;

    log('Accepting phone: %s', phonePeerId);

    // Validate token if invite provided
    if (issuedInvite) {
      if (issuedInvite.token && issuedInvite.token !== token) {
        throw new Error('Invalid invite token');
      }
      if (issuedInvite.expiresAt && Date.now() > issuedInvite.expiresAt) {
        throw new Error('Invite has expired');
      }
    }

    // Authorize the phone peer (no multiaddrs - phone is NAT'd)
    await this.authorizePeer({ peerId: phonePeerId });

    log('Phone %s accepted and authorized', phonePeerId);
  }

  /**
   * Add a phone to the cadre with relay support.
   *
   * Use this when both nodes are NAT'd (phone-to-phone). This method:
   * 1. Authorizes the new phone peer
   * 2. Creates a seed with relay addresses for dialing
   *
   * @param phonePeerId - Peer ID of the new phone
   * @returns Seed with relay addresses for out-of-band delivery
   */
  async addPhoneWithRelay(phonePeerId: string): Promise<DroneInitResult> {
    log('Adding phone with relay: %s', phonePeerId);

    // 1. Authorize the new phone peer (no multiaddrs - NAT'd)
    await this.authorizePeer({ peerId: phonePeerId });

    // 2. Get relay address for this node
    const relayAddr = await this.getRelayAddress();

    // 3. Create seed - will include our relay address if available
    const seed = await this.createSeed();

    // If we have a relay address, make sure it's in our peer entry
    if (relayAddr && this.libp2pNode) {
      const ourPeerId = this.libp2pNode.peerId.toString();
      const ourPeer = seed.peers.find(p => p.peerId === ourPeerId);
      if (ourPeer && !ourPeer.multiaddrs.includes(relayAddr)) {
        ourPeer.multiaddrs.push(relayAddr);
      }
    }

    const encodedSeed = this.encodeSeed(seed);

    log('Phone %s added with relay, seed created', phonePeerId);

    return { seed, encodedSeed };
  }

  /**
   * Encode an invite for out-of-band delivery.
   */
  encodeInvite(invite: CadreInvite): string {
    const json = JSON.stringify(invite);
    return uint8ArrayToString(new TextEncoder().encode(json), 'base64url');
  }

  /**
   * Decode an invite from base64url encoding.
   */
  decodeInvite(encoded: string): CadreInvite {
    const bytes = uint8ArrayFromString(encoded, 'base64url');
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as CadreInvite;
  }

  /**
   * Dial an owner from an invite.
   * Use this on a phone after receiving an invite to connect to the owner.
   *
   * @param invite - The invite received out-of-band
   * @returns Connection to the owner
   */
  async dialInvite(invite: CadreInvite): Promise<void> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }

    // Check expiration
    if (invite.expiresAt && Date.now() > invite.expiresAt) {
      throw new Error('Invite has expired');
    }

    log('Dialing invite owner with %d addresses', invite.ownerAddrs.length);

    // Try each owner address until one succeeds
    let lastError: Error | null = null;
    for (const addrStr of invite.ownerAddrs) {
      try {
        const addr = multiaddr(addrStr);
        await this.libp2pNode.dial(addr);
        log('Connected to owner at: %s', addrStr);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log('Failed to dial %s: %o', addrStr, error);
      }
    }

    throw lastError ?? new Error('No owner addresses available');
  }
}

