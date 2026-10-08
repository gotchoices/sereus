import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { digest, sign, verify, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p, Connection, PeerId, Stream } from '@libp2p/interface';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { type ControlStream, withDeadline, exchangeFrame, readStreamToEnd, replyAndClose } from './control-stream.js';
import {
  dialPeerAddrs,
  SelfRelayOnlyError,
  PeerUnreachableError,
  DEFAULT_PEER_DIAL_BUDGET,
  type PeerDialBudget,
} from './peer-dial.js';
import { withTrailingPeerId } from './peer-record.js';
import { relayedRequestBudgetMs } from './link-budget.js';
import type {
  ControlNetworkSeed,
  SeedPeer,
  SeedMessage,
  SeedAckMessage,
  SeedRefusalCode,
  SeedDeliveryTarget,
  AuthorizePeerOptions,
  ApplySeedResult,
  AddDroneOptions,
  DroneInitResult,
  CadreInviteRow,
  PeerAddressRecord,
  DeviceTokenRecord,
  RevocationRow,
  RevocationLedgerOpenResult
} from './types.js';
import type { ControlDatabase } from './control-database.js';
import { generateStampId } from './control-database.js';
import { canonicalJson } from './canonical-json.js';
import { deviceTokenAddDigest } from './peer-authorization.js';
import { ed25519PublicKeyB64FromPeerId } from './ed25519-key.js';
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

/**
 * Default time the receiver waits for an inbound seed frame before aborting (ms). It covers the
 * read only: the trust decision and the peer-store merge run after it.
 */
// eslint-disable-next-line no-restricted-syntax -- link-independent: a receiver cap on one seed frame on a stream the peer already opened; it bounds a peer that opens a stream and never sends, not the dial
const DEFAULT_SEED_READ_TIMEOUT_MS = 10_000;

/** Default cap on concurrent inbound seed streams a single peer can pin open. */
const DEFAULT_MAX_CONCURRENT_SEEDS = 100;

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
 * The digest a seed's signature covers: sha256 over {@link canonicalSeedPayload},
 * base64url. One function so the signer (`createSeed`), the verifier
 * (`validateSeedSignature`) and the claim proof (`claim-proof.ts`, which binds a
 * proof to one seed through this value) all name the same bytes.
 */
export function seedDigest(seed: Pick<ControlNetworkSeed, 'partyId' | 'peers'>): string {
  return digest([canonicalSeedPayload(seed)], 'sha256', 'base64url') as string;
}

/**
 * An {@link ApplySeedResult} for a seed refused before the owner-dial loop ran,
 * so the dial counters read zero rather than being absent.
 */
function seedRejected(error: string, code?: SeedRefusalCode): ApplySeedResult {
  return {
    success: false,
    peersAdded: 0,
    error,
    ...(code !== undefined ? { code } : {}),
    ownerDialsAttempted: 0,
    ownerDialsFailed: 0,
  };
}

/** What rides beside a seed into {@link SeedBootstrapService.verifyAndMergeSeed}. */
interface SeedApplyOptions {
  /** Per-call policy override, used instead of the service-configured default for this seed only. */
  trustPolicy?: SeedTrustPolicy;
  /** The claim proof the message carried, when the seed came over the wire. */
  claimProof?: string;
  /** The delivering peer, when the seed came over the wire. */
  remotePeerId?: string;
}

/** What dialing a seed's owner peers produced — the owner-dial half of an {@link ApplySeedResult}. */
type OwnerDialCounts = Pick<ApplySeedResult, 'ownerDialsAttempted' | 'ownerDialsFailed'>;

/**
 * Parse each address, dropping (and logging) any that is malformed, so one bad
 * entry cannot keep a peer's valid addresses from being dialed.
 */
function parseDialAddrs(addrs: readonly string[]): Multiaddr[] {
  const parsed: Multiaddr[] = [];
  for (const addr of addrs) {
    try {
      parsed.push(multiaddr(addr));
    } catch (error) {
      log('Skipping malformed dial address %s: %o', addr, error);
    }
  }
  return parsed;
}

/**
 * Merge a peer list's addresses into `node`'s peer store, so the node can dial them: the
 * seed's peers after its signature and trust checks, the dial hints a member returns on
 * a cadre invitation redemption (`cadre-invite-protocol.ts`), or the node a seed is being
 * delivered to ({@link SeedBootstrapService.deliverSeed}). Best-effort per peer — one
 * unparsable entry costs that peer, not the rest — and a peer with no address is skipped,
 * since there is nothing to dial. Returns how many peers were merged.
 */
export async function mergeSeedPeers(node: Libp2p, peers: readonly SeedPeer[]): Promise<number> {
  let peersAdded = 0;
  for (const peer of peers) {
    if (peer.multiaddrs.length === 0) {
      continue;
    }
    try {
      const peerId = peerIdFromString(peer.peerId);
      const addrs = peer.multiaddrs.map(ma => multiaddr(ma));
      await node.peerStore.merge(peerId, { multiaddrs: addrs });
      peersAdded++;
      log('Added peer to store: %s with %d addrs', peer.peerId, addrs.length);
    } catch (error) {
      log('Failed to add peer %s: %o', peer.peerId, error);
    }
  }
  return peersAdded;
}

/** Opens a seed delivery's stream under the delivery deadline's signal. */
type SeedStreamOpener = (signal: AbortSignal) => Promise<Stream>;

/**
 * A delivery target's addresses, each bound to its peer id (`withTrailingPeerId`) so the dial
 * authenticates the node it aims at rather than trusting whoever answers. An address that does
 * not parse, or that names another peer, throws: that is the caller's mistake, not the node
 * being unreachable.
 */
function deliveryDialAddrs(peerId: string, addrs: readonly string[]): Multiaddr[] {
  return addrs.map((text) => {
    const bound = withTrailingPeerId(multiaddr(text), peerId);
    if (!bound) {
      throw new Error(`Seed delivery to ${peerId}: address ${text} names another peer`);
    }
    return bound;
  });
}

/**
 * A connection to `peerId` that `node` already holds and a seed stream can use: open and without
 * relay limits, the rule libp2p applies when `dialProtocol` reuses a connection.
 */
function openUnlimitedConnection(node: Libp2p, peerId: PeerId): Connection | undefined {
  return node.getConnections(peerId).find((c) => c.status === 'open' && c.limits === undefined);
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
   * The host's declared link round trip (`NetworkConfig.linkRoundTripMs`), from which
   * {@link seedDeliverTimeoutMs}'s default is derived. Unset means the declared default.
   */
  linkRoundTripMs?: number;
  /**
   * Time {@link SeedBootstrapService.deliverSeed} waits for the request — opening the
   * stream, write, ack read — before aborting (ms). For a multiaddr string, or a peer id
   * with no addresses, opening the stream includes the dial; for a peer id with addresses
   * the connection is formed first, outside this limit and within {@link dialBudget}.
   * Bounds the SENDER against a seed target that accepts the stream and then never replies;
   * the target is a not-yet-trusted node during onboarding, so this is the more exposed
   * direction than the receiver knobs above.
   *
   * Defaults to `relayedRequestBudgetMs(linkRoundTripMs)` (`link-budget.ts`; 28.5 s at the
   * default declaration): one dial that may need a relay, then one request and its answer —
   * sized for the forms that dial inside it. Delivery does not set `runOnLimitedConnection`,
   * so it does not use a limited relayed connection today; the relayed-dial count is the upper
   * bound on the dial it can use, the same choice `CadreNode.controlDialBudget` makes for every
   * address. It holds only link work because the receiver acks before its owner dials.
   *
   * NOTE: no transfer allowance — a seed is a peer list of a few KB, and `MAX_SEED_SIZE` (1 MiB)
   * is a defensive cap. If seeds ever grow toward that cap, add an allowance the way
   * `PUSH_TRANSFER_ALLOWANCE_MS` does.
   */
  seedDeliverTimeoutMs?: number;
  /**
   * Time limits for each peer this service dials from a list of addresses —
   * {@link SeedBootstrapService.applySeed}'s owner dials and
   * {@link SeedBootstrapService.deliverSeed}'s dial of a peer id with addresses — per
   * address and per peer (see `peer-dial.ts`). Defaults to {@link DEFAULT_PEER_DIAL_BUDGET}; a `CadreNode`
   * passes its `network.controlCohort` limits.
   */
  dialBudget?: PeerDialBudget;
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
  private readonly dialBudget: PeerDialBudget;
  /** In-flight inbound seed streams, used to enforce {@link maxConcurrentSeeds}. */
  private activeStreams = 0;
  private eventCallbacks: SeedEventCallbacks = {};

  constructor(config: SeedBootstrapConfig) {
    this.config = config;
    this.trustPolicy = config.trustPolicy ?? anchoredTrustPolicy();
    this.seedReadTimeoutMs = config.seedReadTimeoutMs ?? DEFAULT_SEED_READ_TIMEOUT_MS;
    this.maxConcurrentSeeds = config.maxConcurrentSeeds ?? DEFAULT_MAX_CONCURRENT_SEEDS;
    this.seedDeliverTimeoutMs = config.seedDeliverTimeoutMs ?? relayedRequestBudgetMs(config.linkRoundTripMs);
    this.dialBudget = config.dialBudget ?? DEFAULT_PEER_DIAL_BUDGET;

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
   * it on. The throwaway temp service CadreNode builds in `applySeed` passes
   * `false`: it only needs the stored `libp2pNode` / `controlDatabase` for
   * dialing and known-key lookup, and must NOT bind a discarded closure to the
   * shared node (a handler leak, and a second
   * `handle()` of the same protocol throws `DuplicateProtocolHandlerError`).
   *
   * Rejects when libp2p refuses the registration; the node and database are
   * kept only once the handler is in place, so a failed service holds nothing
   * for {@link shutdown} to unhandle.
   */
  async initialize(
    libp2pNode: Libp2p,
    controlDatabase: ControlDatabase,
    options?: { registerHandler?: boolean }
  ): Promise<void> {
    // Register the seed protocol handler unless the caller opted out (temp services).
    if (options?.registerHandler ?? true) {
      await this.registerProtocolHandler(libp2pNode);
    }

    this.libp2pNode = libp2pNode;
    this.controlDatabase = controlDatabase;
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
   *
   * @returns `true` when this call seated the row, `false` when a concurrent writer
   *   (e.g. an {@link authorizePeer} of this node's own id) had already seated it —
   *   in which case the row in the database is NOT this record and carries whatever
   *   `Sig` that writer had, so the caller must self-update to publish its signature.
   */
  async insertSelfPeerRecord(record: PeerAddressRecord): Promise<boolean> {
    return await this.insertCadrePeerRow({
      peerId: record.peerId,
      publicKey: record.publicKey,
      multiaddr: record.addrs.join(','),
      updatedAt: record.updatedAt,
      sig: record.sig,
    });
  }

  /**
   * Shared owner-signed `CadrePeer` INSERT — the row fields and the owner-key
   * precondition; the stamp mint, voucher signature, write lock, existence check and
   * membership notify are all {@link ControlDatabase.insertCadrePeer}'s (see there for
   * the anti-replay and insert-race rationale). No `CadrePeer` write may bypass that
   * method: the write is what admits the peer's traffic.
   *
   * The DB check precedes the owner-key check here, matching the order this method has
   * always surfaced them (the owner-key error used to come out of the signer, after the
   * DB check).
   *
   * @returns `true` when this call performed the INSERT, `false` when the row was
   *   already seated by a concurrent writer. The loser needs to know: an authorize seats
   *   a row with a null `Sig`, so a self-publish that lost the race must fall through to
   *   a self-update or its record never lands.
   */
  private async insertCadrePeerRow(row: {
    peerId: string;
    publicKey: string | null;
    multiaddr: string;
    updatedAt: number;
    sig: string | null;
  }): Promise<boolean> {
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const ownerKey = this.requireOwnerPublicKey();
    return await this.controlDatabase.insertCadrePeer(
      row, ownerKey, message => this.signMessageBytes(message),
    );
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
    await this.controlDatabase.execWrite(`
      insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?, ?)
    `, [this.ownerPublicKey, signature, record.peerId, record.platform, record.token, record.updatedAt, record.sig, stampId], 'device-token-insert');
    log('Device token inserted (owner-signed): %s', record.peerId);
  }

  /**
   * Owner-signed DELETE of a peer's `DeviceToken` row (logout / token
   * invalidation). The `DeviceToken.AuthorizedDelete` constraint validates an owner
   * signature over the 'remove'-tagged digest bound to the STORED row's
   * (PeerId, StampId) — deliberately distinct from the insert digest, so a captured
   * insert approval can never be replayed to clear a token. Like {@link removePeer}
   * for `CadrePeer`, clearing a token requires the owner key.
   *
   * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in
   * ONE transaction — `DeviceToken.RevocationRecorded` refuses a bare delete, and
   * without the tombstone the stamp would free up and the never-expiring insert
   * approval (which the cleared device holds a copy of) would re-seat the token. The
   * tombstone carries its OWN owner signature: retiring a stamp permanently forecloses
   * that row, so it is an owner action in its own right.
   *
   * Both digests, the stamp read, and the transaction come from
   * {@link ControlDatabase.deleteDeviceToken} — one shared implementation across
   * `CadrePeer` / `DeviceToken` / `Strand` / `ValidationKey`. What stays here is the
   * owner-key precondition; a no-op on an already-absent row is the shared body's
   * behavior, and unlike {@link removePeer} nothing here rides on it.
   */
  async deleteDeviceToken(peerId: string): Promise<void> {
    // Fail fast on a keyless service BEFORE the DB read, so a non-owner gets the
    // owner-key error rather than a silent no-op on an absent row.
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    await this.controlDatabase.deleteDeviceToken(
      peerId, ownerKey, message => this.signMessageBytes(message),
    );
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
   * The owner PUBLIC key that rides in every owner-signed write's context, non-null.
   *
   * The field is nullable because a read-only service carries no owner key at all, but the
   * constructor derives the public key whenever `ownerPrivateKey` is set — so gating on
   * {@link requireOwnerPrivateKey} first makes the pair inseparable and the second throw
   * unreachable. Callers that must reject a keyless service BEFORE any DB read use this as
   * their first line and get the owner-key precondition for free.
   */
  private requireOwnerPublicKey(): string {
    this.requireOwnerPrivateKey();
    if (!this.ownerPublicKey) {
      throw new Error('Owner public key required to authorize peers');
    }
    return this.ownerPublicKey;
  }

  /**
   * Sign a base64url digest with the owner key (ed25519). The single place the
   * owner private key is applied; callers pass the canonical domain-tagged digest for
   * the specific action ({@link deviceTokenAddDigest}), or the raw-bytes form via
   * {@link signMessageBytes}. Throws if no owner key is set.
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
   * Adapt the control database's raw-bytes `signMessage` callback (every guarded delete
   * takes one) to {@link signDigest}'s base64url-string form. Both encodings hash to the
   * same signed bytes (`sign` decodes its base64url input), so a signature minted here
   * satisfies the same schema CHECK as one from the callers that sign the bytes directly — see
   * `control-revocation-replay.spec.ts`'s "raw-bytes and digest-string signers agree".
   */
  private signMessageBytes(message: Uint8Array): string {
    return this.signDigest(uint8ArrayToString(message, 'base64url'));
  }

  /**
   * Remove a peer from the cadre by owner signature.
   *
   * The `CadrePeer.AuthorizedDelete` (`check on delete`) constraint validates a
   * signature over the DISTINCT 'remove'-tagged digest
   * `digest('CadreControl.CadrePeer', 'remove', old.PeerId, old.StampId)` by an owner
   * key — deliberately NOT the insert voucher digest, so the row's stored `VouchSig` can
   * never be replayed to delete.
   *
   * The delete and the `Revocation` tombstone retiring the row's `StampId` commit in ONE
   * transaction — `CadrePeer.RevocationRecorded` refuses a bare delete, and without the
   * tombstone the stamp would free up and the original admission approval (which never
   * expires, and which the removed peer holds a copy of) would re-seat the row.
   *
   * The tombstone is separately owner-signed (satisfying `Revocation.Authorized`):
   * retiring a stamp evicts that peer party-wide and permanently forecloses re-admitting
   * the row, so it is an owner action in its own right, not a side effect the delete's
   * signature covers.
   *
   * Both digests, the stamp read, the transaction, and the post-commit membership notify
   * come from {@link ControlDatabase.deleteCadrePeer} — one shared implementation across
   * `CadrePeer` / `DeviceToken` / `Strand` / `ValidationKey`. What stays here is the
   * owner-key precondition and the absent-row gate the notify depends on (below).
   */
  async removePeer(peerId: string): Promise<void> {
    // Fail fast on a keyless service BEFORE any DB read: a non-owner cannot sign the
    // remove digest, and this precedence (owner key, then control DB) is what the
    // unit contract asserts.
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    // This absent-row gate must stay OUTSIDE the delete, even though the delete repeats it
    // internally: deleteCadrePeer's membership notify fires whenever its body resolves,
    // with no idea whether the body wrote anything, so delegating an absent peer would
    // fire a spurious membership notification.
    // NOTE: deleteCadrePeer re-reads the StampId, so a peer removed by another writer
    // between the two reads no-ops silently yet still notifies. Narrow concurrent-removal
    // window only — the common "already absent" case is caught here.
    const stampId = await this.controlDatabase.queryCadrePeerStampId(peerId);
    if (stampId === null) {
      log('removePeer: no CadrePeer row for %s (already absent)', peerId);
      return;
    }

    log('Removing peer: %s', peerId);

    await this.controlDatabase.deleteCadrePeer(
      peerId, ownerKey, message => this.signMessageBytes(message),
    );

    log('Peer %s removed successfully (stamp retired)', peerId);
  }

  /**
   * Owner "re-touch" of an existing `CadrePeer` membership row: bump `UpdatedAt` and
   * re-vouch the row so it is re-emitted as a fresh, broadcasting transaction. This is
   * the write-while-alone re-replication primitive (`control-write-ensure-replicated`):
   * a membership row that committed local-only (its block's cluster ≤1 at insert) is
   * pushed to the cohort once it grows.
   *
   * The stamp read, the voucher signature, the write lock and the membership notify are
   * {@link ControlDatabase.reauthorizeCadrePeer}'s — including the caveat that it rebinds
   * `VouchOwner` to this node's owner key. What stays here is the owner-key precondition.
   *
   * A no-op (no throw, no notify) when the row does not exist.
   *
   * @param peerId - the membership row to re-touch.
   * @param updatedAt - the strictly-increasing freshness stamp to write.
   * @throws if no owner private key is configured (a non-owner cannot
   *   re-sign another peer's row) or the control database is not initialized.
   */
  async reauthorizePeer(peerId: string, updatedAt: number): Promise<void> {
    // Fail fast on a keyless service before any DB read (see removePeer): a non-owner
    // cannot re-sign the voucher, and must not silently no-op on an absent row.
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const retouched = await this.controlDatabase.reauthorizeCadrePeer(
      peerId, updatedAt, ownerKey, message => this.signMessageBytes(message),
    );
    if (!retouched) {
      log('reauthorizePeer: no CadrePeer row for %s (nothing to re-touch)', peerId);
      return;
    }
    log('Peer %s re-authorized (UpdatedAt=%d) for write-while-alone re-replication', peerId, updatedAt);
  }

  /**
   * Owner re-issue of a batch of `Revocation` tombstones: bump each row's
   * `ReissuedAt` so the storage layer re-broadcasts a tombstone that committed
   * while the node was alone. The delete-while-alone counterpart of
   * {@link reauthorizePeer} — a removed row cannot be re-touched (it is gone),
   * but its tombstone can, and every membership read treats a retired stamp as
   * absent.
   *
   * The signatures, the single transaction, and the strictly-monotonic
   * `reissuedAt` contract are {@link ControlDatabase.reissueRevocations}'s. What
   * stays here is the owner-key precondition.
   *
   * @returns how many tombstones were re-issued (`rows.length` on success).
   * @throws if no owner private key is configured or the control database is not
   *   initialized.
   */
  async reissueRevocations(rows: readonly RevocationRow[], reissuedAt: number): Promise<number> {
    // Fail fast on a keyless service before any DB work (see removePeer): a
    // non-owner cannot sign the reissue digests.
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    return this.controlDatabase.reissueRevocations(
      rows, reissuedAt, ownerKey, message => this.signMessageBytes(message),
    );
  }

  /**
   * Owner filing of the singleton `Revocation` ledger marker, so the table is never a
   * never-written block that the storage layer re-consults on every read.
   *
   * The signature, the insert-if-absent guard and the `'already-open'` mapping are
   * {@link ControlDatabase.openRevocationLedger}'s. What stays here is the owner-key
   * precondition.
   *
   * @throws if no owner private key is configured or the control database is not
   *   initialized.
   */
  async openRevocationLedger(): Promise<RevocationLedgerOpenResult> {
    // Fail fast on a keyless service before any DB work (see removePeer): a
    // non-owner cannot sign the marker's append digest.
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    return this.controlDatabase.openRevocationLedger(
      ownerKey, message => this.signMessageBytes(message),
    );
  }

  /**
   * Owner-signed INSERT of a `CadreInvite` row — an invitation any member machine can redeem
   * on this owner's behalf ({@link ControlDatabase.insertCadreInvite}). The keypair mint, the
   * expiry and use-count defaults, and the bundle the holder receives are
   * `CadreNode.createCadreInvitation`'s; what stays here is the owner-key precondition and
   * the signature, as {@link insertSelfDeviceToken} keeps them for device tokens.
   *
   * @returns the row as stored, which the invitation bundle carries verbatim.
   * @throws if no owner private key is configured or the control database is not initialized.
   */
  async insertCadreInvite(invite: Parameters<ControlDatabase['insertCadreInvite']>[0]): Promise<CadreInviteRow> {
    // Fail fast on a keyless service before any DB work (see removePeer).
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    return await this.controlDatabase.insertCadreInvite(invite, ownerKey, message => this.signMessageBytes(message));
  }

  /**
   * Owner-signed WITHDRAWAL of a `CadreInvite`: the `Revocation` tombstone over its stamp, with
   * the row kept ({@link ControlDatabase.withdrawCadreInvite}). What stays here is the
   * owner-key precondition.
   *
   * @returns `true` when this call filed the tombstone, `false` when the row is absent here or
   *   already withdrawn.
   * @throws if no owner private key is configured or the control database is not initialized.
   */
  async withdrawCadreInvite(key: string): Promise<boolean> {
    const ownerKey = this.requireOwnerPublicKey();
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    return await this.controlDatabase.withdrawCadreInvite(key, ownerKey, message => this.signMessageBytes(message));
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
    const signature = sign(
      seedDigest(seedData),
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
   * anchored without re-supplying the pin.
   *
   * @param seed - The seed to apply (already transport-decoded).
   * @param options.trustPolicy - Per-call policy override (e.g. a
   *   `pinnedKeyTrustPolicy` built from an operator pin) used instead of the
   *   service-configured default for this seed only.
   */
  async applySeed(
    seed: ControlNetworkSeed,
    options?: { trustPolicy?: SeedTrustPolicy }
  ): Promise<ApplySeedResult> {
    const merged = await this.verifyAndMergeSeed(seed, options);
    if (!merged.success) {
      return merged;
    }
    return { ...merged, ...await this.dialSeedOwners(seed) };
  }

  /**
   * The first half of {@link applySeed}: check the signature and the signer's trust, then merge
   * the seed's peer addresses into the peer store. Every rejection happens here, so this result is
   * what the inbound handler acks with; the owner dials that follow cannot change it.
   */
  private async verifyAndMergeSeed(
    seed: ControlNetworkSeed,
    options?: SeedApplyOptions
  ): Promise<ApplySeedResult> {
    if (!this.libp2pNode) {
      return seedRejected('Service not initialized');
    }

    // NOTE: `seed.partyId` is never checked against `config.partyId`. Trust is keyed on
    // `signerKey` vs the anchor, and the anchor a stray-party seed could write into
    // belongs to THIS party, which only a caller-supplied pin for that signer can reach.
    // The one reader of the seed's party is the claim policy, which records it as the
    // party the node now serves (`CadreNodeConfig.claim.record`): a mismatch is still not
    // rejected there because an unclaimed node's own party is a placeholder, and the
    // claim seed is the first thing to name the real one. If any other path ever
    // branches on the seed's partyId (or the anchor becomes multi-party), reject a
    // mismatch here instead.
    log('Applying seed for party: %s', seed.partyId);

    // One digest serves the signature check and the trust context: a claim proof is
    // bound to the seed through the same value the signature covers.
    const digestB64 = seedDigest(seed);
    if (!this.validateSeedSignature(seed, digestB64)) {
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
      // Optional-chained like `dialSeedOwners`: partial libp2p handles (unit-test doubles)
      // omit `peerId`. A real node always has one, and a proof bound to a real peer id can
      // only fail against '' — the safe direction.
      localPeerId: this.libp2pNode.peerId?.toString() ?? '',
      seedDigest: digestB64,
      claimProof: options?.claimProof,
      remotePeerId: options?.remotePeerId,
    });
    if (!decision.trusted) {
      return seedRejected(decision.reason ?? 'Signer key not trusted by trust policy', decision.code);
    }
    await this.anchorAcceptedSigner(seed.signerKey, decision);

    const peersAdded = await mergeSeedPeers(this.libp2pNode, seed.peers);
    log('Merged seed: %d peers added', peersAdded);
    return { success: true, peersAdded, ownerDialsAttempted: 0, ownerDialsFailed: 0 };
  }

  /**
   * The second half of {@link applySeed}: dial the seed's owner peers to establish connections.
   *
   * Best-effort and COUNTED: an owner that is momentarily down leaves this node seeded but
   * unconnected, which the caller can only see if the outcome is reported (see
   * `ApplySeedResult.ownerDialsFailed`). Recovery is not this loop's job —
   * `CadreNode.dialColdStartBootstrap` retries these same addresses on every control-cohort
   * reconcile pass until the control database has siblings.
   *
   * The inbound handler runs this AFTER it has acked and closed the stream
   * ({@link handleSeedStream}), because an unreachable owner can take `dialBudget.totalMs`.
   */
  private async dialSeedOwners(seed: ControlNetworkSeed): Promise<OwnerDialCounts> {
    const node = this.libp2pNode;
    if (!node) {
      log('Seed service shut down before its owner dials; none attempted');
      return { ownerDialsAttempted: 0, ownerDialsFailed: 0 };
    }
    // `createSeed` projects every non-revoked CadrePeer row, so an owner applying
    // a seed minted after it joined finds ITSELF in the owner list. Dialing self always
    // throws, which would report a healthy owner as "seeded but stranded".
    // Optional-chained: partial libp2p handles (unit-test doubles) omit `peerId`,
    // and an undefined self simply matches nothing.
    // Every one of an owner's addresses is a candidate, each on its own time limit
    // (`dialPeerAddrs`), so an owner whose first address never answers neither
    // stalls seed application nor goes undialed at its other addresses.
    const selfPeerId = node.peerId?.toString();
    let ownerDialsAttempted = 0;
    let ownerDialsFailed = 0;
    for (const peer of seed.peers.filter(p => p.isOwner)) {
      if (peer.multiaddrs.length === 0 || peer.peerId === selfPeerId) {
        continue;
      }
      ownerDialsAttempted++;
      try {
        const addrs = parseDialAddrs(peer.multiaddrs);

        log('Dialing owner peer: %s (%d addr(s))', peer.peerId, addrs.length);
        await dialPeerAddrs(node, addrs, this.dialBudget, `Owner dial of ${peer.peerId}`);
      } catch (error) {
        // Counted even when the owner reaches us only through our own relay: this node is still
        // not connected to it, and `ownerDialsFailed` is how the caller learns that.
        ownerDialsFailed++;
        if (error instanceof SelfRelayOnlyError) {
          log('Owner peer %s is reachable only by relaying through this node; waiting for it to reconnect', peer.peerId);
        } else {
          log('Failed to dial peer %s: %o', peer.peerId, error);
        }
        // Continue - not all peers need to be reachable
      }
    }

    log('Dialed seed owners: %d/%d owner dial(s) failed', ownerDialsFailed, ownerDialsAttempted);
    return { ownerDialsAttempted, ownerDialsFailed };
  }

  /**
   * Persist a signer that a pin/TOFU accepted into the node-local anchor, so a
   * later seed from the same owner is anchored without re-supplying the pin
   * or re-prompting. Only the policy decides this happens (`anchorAs` is unset
   * when the key was already anchored, so a plain re-apply writes nothing) and
   * `trust()` is idempotent, keeping the original provenance for a known key.
   *
   * Failure to PERSIST does not fail the seed: `trust()` reflects the key in the
   * in-memory anchor synchronously, so this seed and the rest of the session are
   * unaffected — only durability across a restart is lost, and that is logged.
   * That holds for pins and TOFU, which are re-supplied at the next start; a claim
   * is the opposite case, so `claimSecretTrustPolicy` anchors its signer itself,
   * awaits durability, and never sets `anchorAs` (the type excludes `'claim'`).
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
   * `target` is a multiaddr string, dialed as given, or a peer id with its addresses
   * ({@link SeedDeliveryTarget}). For the second, the connection is formed first and on
   * its own limits ({@link connectForDelivery}): an open one is reused, otherwise each
   * address is dialed in turn, so one that never answers cannot use up the time a later
   * one needed. Its addresses are also merged into the peer store, so identify and later
   * dials see them. A peer id with no addresses is dialed by id, which reuses an open
   * connection or tries the peer store's addresses. `options.claimProof` rides beside
   * the seed in the message when the target is a brand-new node being claimed
   * (`claim-proof.ts`).
   *
   * Sender hardening: the request — opening the stream (with its dial, for the forms
   * that dial by `dialProtocol`), write, ack read — is bounded by {@link seedDeliverTimeoutMs},
   * and the ack is capped at {@link MAX_SEED_SIZE}. The target is a NOT-YET-TRUSTED node the
   * instigator chose to dial during onboarding, so an unbounded read here is strictly more
   * exposed than the membership-gated receiver paths: without the bound a target that accepts
   * the stream and never replies parks this call forever, and one that streams arbitrary bytes
   * as a fake ack exhausts memory. A peer id with addresses can therefore take up to
   * `dialBudget.totalMs` plus {@link seedDeliverTimeoutMs} (114.5 s at the default declared
   * link) when none of its addresses answers.
   *
   * @throws {PeerUnreachableError} for a peer id with addresses, when no connection to it
   *   formed; nothing was sent. Anything else thrown after the connection formed means the
   *   node was reached and the exchange failed.
   */
  async deliverSeed(
    target: SeedDeliveryTarget,
    seed: ControlNetworkSeed,
    options?: { claimProof?: string },
  ): Promise<SeedAckMessage> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }
    const label = typeof target === 'string' ? target : target.peerId;
    log('Delivering seed to: %s', label);

    const openStream = await this.seedStreamOpener(this.libp2pNode, target);
    return await withDeadline(
      this.seedDeliverTimeoutMs,
      `Seed delivery to ${label}`,
      (signal) => this.sendSeed(openStream, seed, options?.claimProof, signal),
    );
  }

  /**
   * The part of {@link deliverSeed} that runs before its deadline: how the delivery's stream
   * will be opened, with any connection it needs already formed.
   */
  private async seedStreamOpener(node: Libp2p, target: SeedDeliveryTarget): Promise<SeedStreamOpener> {
    if (typeof target === 'string') {
      const addr = multiaddr(target);
      return (signal) => node.dialProtocol(addr, SEED_PROTOCOL, { signal });
    }
    const peerId = peerIdFromString(target.peerId);
    const addrs = deliveryDialAddrs(target.peerId, target.multiaddrs);
    await mergeSeedPeers(node, [{ peerId: target.peerId, multiaddrs: target.multiaddrs, isOwner: false }]);
    if (addrs.length === 0) {
      return (signal) => node.dialProtocol(peerId, SEED_PROTOCOL, { signal });
    }
    const connection = await this.connectForDelivery(node, peerId, addrs);
    return (signal) => connection.newStream(SEED_PROTOCOL, { signal });
  }

  /**
   * A connection to `peerId` for {@link deliverSeed}: one already open, or one dialed from
   * `addrs` by {@link dialPeerAddrs} — each address on `dialBudget.perAddressMs`, the whole
   * peer within `dialBudget.totalMs`, direct addresses before relayed ones and the given
   * order otherwise.
   *
   * @throws {PeerUnreachableError} when no connection formed, with the dial's error as `cause`.
   */
  private async connectForDelivery(node: Libp2p, peerId: PeerId, addrs: readonly Multiaddr[]): Promise<Connection> {
    const open = openUnlimitedConnection(node, peerId);
    if (open) {
      log('Seed delivery to %s reuses an open connection', peerId);
      return open;
    }
    try {
      return await dialPeerAddrs(node, addrs, this.dialBudget, `Seed delivery dial of ${peerId}`);
    } catch (error) {
      throw new PeerUnreachableError(peerId.toString(), error);
    }
  }

  /**
   * Open one stream to the target, send the seed frame, half-close, and read the ack.
   *
   * `signal` is the deadline from {@link deliverSeed}: it goes to `openStream` so a
   * timeout while dialing or opening the stream aborts it, and into {@link exchangeFrame}
   * so a timeout after the stream is open resets it — releasing the otherwise unbounded
   * ack-read.
   *
   * Deliberately NOT `runOnLimitedConnection`: a wake sets it because a wake is a
   * tiny frame over a relay, whereas a seed is up to 1MB, so a relayed address that
   * forms only a limited connection fails here when the stream is opened. Changing
   * that is a separate decision.
   */
  private async sendSeed(
    openStream: SeedStreamOpener,
    seed: ControlNetworkSeed,
    claimProof: string | undefined,
    signal: AbortSignal,
  ): Promise<SeedAckMessage> {
    const rawStream = await openStream(signal);

    const message: SeedMessage = {
      partyId: seed.partyId,
      peers: seed.peers,
      signature: seed.signature,
      signerKey: seed.signerKey,
      ...(claimProof !== undefined ? { claimProof } : {}),
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
   *
   * @param digestB64 - The seed's {@link seedDigest}, when the caller already computed it
   *   (`verifyAndMergeSeed` shares one digest between this check and the trust context).
   */
  validateSeedSignature(seed: ControlNetworkSeed, digestB64 = seedDigest(seed)): boolean {
    try {
      // The digest is over the shared canonical payload, so verification is
      // independent of key order; the payload is the fixed `{ partyId, peers }`
      // the producer emits.
      return verify(
        digestB64,
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
   * The peers a seed carries: the control database's own projection
   * ({@link ControlDatabase.querySeedPeers}, shared with the cadre invitation redemption
   * reply), which reads through the revocation filter and flags owners from the replicated
   * `OwnerKey` table — a dial hint, not a trust decision (the NOTE at `projectSeedPeers`).
   */
  private async queryPeers(): Promise<SeedPeer[]> {
    if (!this.controlDatabase) {
      return [];
    }
    return await this.controlDatabase.querySeedPeers();
  }

  /**
   * Register the seed protocol handler. The inbound closure just delegates to
   * {@link handleSeedStream} — extracted as a method so it has a unit-test seam
   * (mirroring wake's `handleStream`) the inline closure never had.
   */
  private async registerProtocolHandler(libp2pNode: Libp2p): Promise<void> {
    await libp2pNode.handle(SEED_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      await this.handleSeedStream(rawStream as ControlStream, remotePeerId);
    });

    log('Registered seed protocol handler: %s', SEED_PROTOCOL);
  }

  /**
   * Read one inbound seed frame, verify and merge it, write the ack and close the
   * stream, then dial the seed's owners.
   *
   * The ack and the close come BEFORE the owner dials: an unreachable owner can hold
   * a dial for `dialBudget.totalMs` (86 s at the default declared link), which is not
   * link time and does not belong inside the sender's delivery deadline. The close is
   * what releases the sender, which reads the ack to end-of-stream. The stream stays
   * counted in {@link activeStreams} through the dials, so {@link maxConcurrentSeeds}
   * still bounds concurrent owner-dial phases.
   *
   * Hardened against a buggy/compromised own-cadre node: a concurrency cap (over
   * {@link maxConcurrentSeeds}, reply without applying), a read timeout (a peer
   * that never half-closes is aborted inside `readStreamToEnd`), and the existing
   * malformed/oversized-frame guard — all reported as a non-accepting
   * {@link SeedAckMessage} rather than a dropped/hung stream.
   *
   * NOTE: a receiver configured with an interactive trust-on-first-use policy asks a
   * human before acking, and that wait sits inside the sender's delivery deadline. If
   * TOFU is ever used on this wire path, ack "pending" or move the confirmation out of
   * the exchange.
   */
  private async handleSeedStream(stream: ControlStream, remotePeerId: string): Promise<void> {
    log('Incoming seed delivery from: %s', remotePeerId);

    if (this.activeStreams >= this.maxConcurrentSeeds) {
      log('Rejecting seed from %s: %d concurrent streams at cap %d', remotePeerId, this.activeStreams, this.maxConcurrentSeeds);
      await replyAndClose(stream, { accepted: false, reason: 'Too many concurrent seed deliveries' } satisfies SeedAckMessage, 'Seed');
      return;
    }

    this.activeStreams++;
    let acked = false;
    try {
      const { seed, claimProof } = await this.readSeedFrame(stream);
      this.eventCallbacks.onSeedReceived?.(seed.partyId, remotePeerId);

      const merged = await this.verifyAndMergeSeed(seed, { claimProof, remotePeerId });
      acked = true;
      await replyAndClose(
        stream,
        { accepted: merged.success, reason: merged.error, code: merged.code } satisfies SeedAckMessage,
        'Seed',
      );

      if (merged.success) {
        await this.dialSeedOwners(seed);
        this.eventCallbacks.onSeedApplied?.(seed.partyId, merged.peersAdded, seed);
      } else {
        this.eventCallbacks.onSeedError?.(seed.partyId, merged.error ?? 'Unknown error');
      }
    } catch (error) {
      log('Error handling seed delivery: %o', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.eventCallbacks.onSeedError?.(this.config.partyId, errorMessage);
      // Once acked the stream is closed, so a later failure has no reply to make.
      if (!acked) {
        await replyAndClose(stream, { accepted: false, reason: errorMessage } satisfies SeedAckMessage, 'Seed');
      }
    } finally {
      this.activeStreams--;
    }
  }

  /**
   * Read the inbound seed frame to EOF (bounded and size-capped) and decode it. The
   * claim proof comes back beside the seed: it is not part of what the owner signed, so
   * `ControlNetworkSeed` does not carry it.
   */
  private async readSeedFrame(stream: ControlStream): Promise<{ seed: ControlNetworkSeed; claimProof?: string }> {
    const data = await readStreamToEnd(stream, {
      maxBytes: MAX_SEED_SIZE,
      timeoutMs: this.seedReadTimeoutMs,
      label: 'Seed',
    });
    const message = JSON.parse(new TextDecoder().decode(decodeLengthPrefixedFrame(data))) as SeedMessage;
    return {
      seed: {
        partyId: message.partyId,
        peers: message.peers,
        signature: message.signature,
        signerKey: message.signerKey,
      },
      claimProof: message.claimProof,
    };
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
   * Nothing here dials the drone or remembers its addresses beyond the unsigned
   * `CadrePeer` row, which no resolver accepts. `CadreNode.addDrone` is the entry
   * point that also retains them as a durable dial target, so the adder's
   * reconcile pass can open the connection — the drone cannot dial an owner that
   * does not listen. Call `CadreNode.reconcileControlCohort()` after delivering
   * the seed to dial at once.
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
}
