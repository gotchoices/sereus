import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { digest, sign, verify, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p, Connection } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';

/**
 * Minimal libp2p stream surface compatible with libp2p 3.x.
 * In libp2p 3.x, streams are AsyncIterable for reading and use send() for writing.
 */
interface LibP2PStream extends AsyncIterable<Uint8Array> {
  send(data: Uint8Array): boolean;
  close(): Promise<void>;
  abort(err: Error): void;
}
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
import { canonicalJson } from './canonical-json.js';
import { peerAuthorizationDigest } from './peer-authorization.js';
import {
  type SeedTrustPolicy,
  dbAnchoredTrustPolicy,
} from './seed-trust-policy.js';

const log = debug('sereus:cadre:seed-bootstrap');

/** Protocol ID for seed delivery */
export const SEED_PROTOCOL = '/sereus/seed/1.0.0';

/** Maximum seed message size (1MB) */
const MAX_SEED_SIZE = 1024 * 1024;

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
 * base64url form matches the `AuthorityKey.Key` representation (and
 * `authorityKeyFromLibp2p().publicKeyB64`). Returns null for a non-Ed25519
 * id, a missing embedded key, or any parse failure — callers treat null as
 * "not an authority" rather than throwing.
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
 * Configuration for the SeedBootstrapService
 */
export interface SeedBootstrapConfig {
  /** Party ID for this cadre */
  partyId: string;
  /** Authority private key for signing seeds and peer authorizations (base64url) */
  authorityPrivateKey?: string;
  /** Authority public key (base64url) - derived from private key if not provided */
  authorityPublicKey?: string;
  /**
   * Optional async resolver returning the multiaddrs to embed in invites.
   * When unset, `libp2pNode.getMultiaddrs()` is used. Hosts behind NAT supply
   * this (via `@serfab/cadre-host`'s NatService) to substitute the host's
   * DDNS hostname and externally-mapped port.
   */
  inviteAddressResolver?: () => Promise<string[]>;
  /**
   * Trust anchor for incoming seeds. Decides whether a signature-verified
   * `signerKey` should be trusted, against the receiver's known authority
   * keys (NOT the seed body). Defaults to `dbAnchoredTrustPolicy()`, which
   * rejects any signer not already in the `AuthorityKey` table. An enrollment
   * caller can pass a per-seed override to `applySeed` instead.
   *
   * A `CadreNode` forwards its node-wide `CadreNodeConfig.seedTrustPolicy` here
   * — that is the only seam the inbound libp2p seed-protocol handler can use,
   * since a network-delivered seed has no per-call override.
   */
  trustPolicy?: SeedTrustPolicy;
}

/**
 * Event callbacks for seed-related events
 */
export interface SeedEventCallbacks {
  /** Called when a seed is received via the protocol */
  onSeedReceived?: (partyId: string, peerId: string) => void;
  /** Called when a seed is successfully applied */
  onSeedApplied?: (partyId: string, peersAdded: number) => void;
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
  private readonly authorityPublicKey: string | null;
  private readonly trustPolicy: SeedTrustPolicy;
  private eventCallbacks: SeedEventCallbacks = {};

  constructor(config: SeedBootstrapConfig) {
    this.config = config;
    this.trustPolicy = config.trustPolicy ?? dbAnchoredTrustPolicy();

    // Derive public key from private key if not provided
    if (config.authorityPrivateKey && !config.authorityPublicKey) {
      this.authorityPublicKey = getPublicKey(
        config.authorityPrivateKey,
        'ed25519',
        'base64url',
        'base64url'
      ) as string;
    } else {
      this.authorityPublicKey = config.authorityPublicKey ?? null;
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
   * Signs the peer ID with the authority key and inserts into CadrePeer table.
   *
   * The authority vouches the `PublicKey <-> PeerId` binding: rather than trust a
   * caller-supplied key, the binding is enforced by construction — `PublicKey` is
   * DERIVED from the (Ed25519) `peerId`. A non-Ed25519 peer id yields a null
   * `PublicKey`, and such a row can never be self-updated (it has no key to
   * verify against), which is correct. The row is inserted with a fresh
   * `UpdatedAt` but no self-signature (`Sig` null) — the authority cannot produce
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
   * Authority-signed INSERT of this node's OWN self-signed address record.
   *
   * Used by {@link CadreNode.registerSelf} when the node is not yet a member and
   * is its own authority (it holds the authority key): the row is authority-signed
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
   * Shared authority-signed `CadrePeer` INSERT. Signs `digest(peerId)` with the
   * authority key (satisfying `AuthorizedInsert`) and writes the full record
   * row. The authority signature does NOT cover the address columns — those are
   * vouched only as far as the authority asserts them, and a peer's own `Sig`
   * (when present) is what makes the row resolvable.
   */
  private async insertCadrePeerRow(row: {
    peerId: string;
    publicKey: string | null;
    multiaddr: string;
    updatedAt: number;
    sig: string | null;
  }): Promise<void> {
    const signature = this.signPeerAuthorization(row.peerId);
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      insert into CadreControl.CadrePeer (PeerId, PublicKey, Multiaddr, UpdatedAt, Sig)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?, ?, ?, ?)
    `, [this.authorityPublicKey, signature, row.peerId, row.publicKey, row.multiaddr, row.updatedAt, row.sig]);
  }

  /**
   * Authority-signed INSERT of a peer's OWN self-signed `DeviceToken` row.
   *
   * Counterpart to {@link insertSelfPeerRecord} for the device-token registry: the
   * row is authority-signed (satisfying `DeviceToken.AuthorizedInsert`, which vouches
   * membership exactly as `CadrePeer.AuthorizedInsert` does) AND carries the peer's
   * own self-`Sig` over the token payload. The authority signature covers only the
   * PeerId — it does NOT vouch the token contents; the peer's `Sig` (verified at
   * resolve time against the bound `CadrePeer.PublicKey`) is what makes the row
   * resolvable. Used by {@link CadreNode.registerDeviceToken} for the first publish
   * when the node is its own authority.
   */
  async insertSelfDeviceToken(record: DeviceTokenRecord): Promise<void> {
    const signature = this.signPeerAuthorization(record.peerId);
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      insert into CadreControl.DeviceToken (PeerId, Platform, Token, UpdatedAt, Sig)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?, ?, ?, ?)
    `, [this.authorityPublicKey, signature, record.peerId, record.platform, record.token, record.updatedAt, record.sig]);
    log('Device token inserted (authority-signed): %s', record.peerId);
  }

  /**
   * Authority-signed DELETE of a peer's `DeviceToken` row (logout / token
   * invalidation). The `DeviceToken.AuthorizedInsert` constraint gates both insert
   * AND delete on an authority signature over `digest(old.PeerId)`, so — like
   * {@link removePeer} for `CadrePeer` — clearing a token requires the authority key.
   */
  async deleteDeviceToken(peerId: string): Promise<void> {
    const signature = this.signPeerAuthorization(peerId);
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      delete from CadreControl.DeviceToken
        with context AuthorityKey = ?, Signature = ?
        where PeerId = ?
    `, [this.authorityPublicKey, signature, peerId]);
    log('Device token removed (authority-signed): %s', peerId);
  }

  /**
   * Sign a peer ID with the authority key for a `CadrePeer` / `DeviceToken`
   * insert-or-delete. The signed bytes come from the shared
   * {@link peerAuthorizationDigest} helper so the offline `cadre enroll register`
   * verifier checks the exact same construction. Throws if no authority key is set.
   */
  private signPeerAuthorization(peerId: string): string {
    if (!this.config.authorityPrivateKey) {
      throw new Error('Authority private key required to authorize peers');
    }
    return sign(
      peerAuthorizationDigest(peerId),
      this.config.authorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
  }

  /**
   * Remove a peer from the cadre by authority signature.
   *
   * The constraint over CadrePeer's `check on insert, delete` validates a
   * signature over `digest(old.PeerId, 'sha256', 'utf8')` by an authority
   * key. We use the same digest pattern as authorizePeer.
   */
  async removePeer(peerId: string): Promise<void> {
    // Same canonical digest as the authorizing INSERT (see peerAuthorizationDigest);
    // also validates the authority key is present before touching the database.
    const signature = this.signPeerAuthorization(peerId);
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }

    log('Removing peer: %s', peerId);

    const db = this.controlDatabase.getDatabase();
    await db.exec(`
      delete from CadreControl.CadrePeer
        with context AuthorityKey = ?, Signature = ?
        where PeerId = ?
    `, [this.authorityPublicKey, signature, peerId]);

    log('Peer %s removed successfully', peerId);
  }

  /**
   * Create a seed from the current control network state.
   * The seed contains peer information and is signed by an authority.
   */
  async createSeed(): Promise<ControlNetworkSeed> {
    if (!this.config.authorityPrivateKey || !this.authorityPublicKey) {
      throw new Error('Authority key required to create seeds');
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
    const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(
      seedDigest,
      this.config.authorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    
    const seed: ControlNetworkSeed = {
      ...seedData,
      signature,
      signerKey: this.authorityPublicKey,
    };
    
    log('Created seed with %d peers', peers.length);
    return seed;
  }

  /**
   * Apply a seed to populate the peer cache and enable connections.
   *
   * Validates the seed signature, then evaluates a trust anchor for the
   * `signerKey` that does NOT come from the seed body: the receiver's
   * `AuthorityKey` table (DB-anchored), optionally augmented by pinned keys or
   * TOFU via the configured/overriding `SeedTrustPolicy`. A forged
   * self-asserting seed — one that merely lists its own signer as an authority
   * peer — no longer passes.
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
      return { success: false, peersAdded: 0, error: 'Service not initialized' };
    }

    log('Applying seed for party: %s', seed.partyId);

    // Validate the seed signature
    if (!this.validateSeedSignature(seed)) {
      return { success: false, peersAdded: 0, error: 'Invalid seed signature' };
    }

    // Evaluate the trust anchor for the signer key. The known-authority set is
    // sourced from the receiver's control DB, never from the seed itself; a
    // cold-start node with no DB and no override therefore sees an empty set.
    const knownAuthorityKeys = this.controlDatabase
      ? await this.controlDatabase.getAuthorityKeys()
      : new Set<string>();
    const policy = options?.trustPolicy ?? this.trustPolicy;
    const decision = await policy.evaluate({
      partyId: seed.partyId,
      signerKey: seed.signerKey,
      knownAuthorityKeys,
    });
    if (!decision.trusted) {
      return {
        success: false,
        peersAdded: 0,
        error: decision.reason ?? 'Signer key not trusted by trust policy',
      };
    }

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

    // Dial authority peers to establish connections
    for (const peer of seed.peers.filter(p => p.isAuthority)) {
      try {
        if (peer.multiaddrs.length > 0) {
          const addr = multiaddr(peer.multiaddrs[0]);

          log('Dialing authority peer: %s', peer.peerId);
          await this.libp2pNode.dial(addr);
        }
      } catch (error) {
        log('Failed to dial peer %s: %o', peer.peerId, error);
        // Continue - not all peers need to be reachable
      }
    }

    log('Applied seed: %d peers added', peersAdded);
    return { success: true, peersAdded };
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
   */
  async deliverSeed(targetMultiaddr: string, seed: ControlNetworkSeed): Promise<SeedAckMessage> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }

    const addr = multiaddr(targetMultiaddr);

    log('Delivering seed to: %s', targetMultiaddr);

    // Dial the target and open a stream
    const rawStream = await this.libp2pNode.dialProtocol(addr, SEED_PROTOCOL);
    const stream = rawStream as unknown as LibP2PStream;

    try {
      // Send the seed message
      const message: SeedMessage = {
        partyId: seed.partyId,
        peers: seed.peers,
        signature: seed.signature,
        signerKey: seed.signerKey,
      };

      const messageBytes = new TextEncoder().encode(JSON.stringify(message));

      // Write length-prefixed message using libp2p 3.x send() API
      const lengthBytes = new Uint8Array(4);
      new DataView(lengthBytes.buffer).setUint32(0, messageBytes.length, false);

      stream.send(lengthBytes);
      stream.send(messageBytes);

      // In libp2p v3.x, close() closes the write end only (signals EOF),
      // while the read end remains open for receiving the ack.
      await stream.close();

      // Read the acknowledgment (stream is AsyncIterable in libp2p 3.x)
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
        chunks.push(bytes);
      }

      const responseData = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        responseData.set(chunk, offset);
        offset += chunk.length;
      }

      // Parse length-prefixed response
      const responseBody = decodeLengthPrefixedFrame(responseData);
      const responseJson = new TextDecoder().decode(responseBody);
      const ack = JSON.parse(responseJson) as SeedAckMessage;

      log('Seed delivery response: accepted=%s', ack.accepted);
      return ack;

    } catch (err) {
      stream.abort(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
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
      const seedDigest = digest(seedJson, 'sha256', 'utf8', 'base64url') as string;

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
   * Authority identity is sourced from the `AuthorityKey` table, not from the
   * transport peer ID. An Ed25519 libp2p PeerId embeds its public key (identity
   * multihash), so each peer's ed25519 key is derivable from its `PeerId`; a
   * peer is an authority iff that derived key is in the `AuthorityKey` set.
   * This makes any authority node markable — not just the local one — and ties
   * `isAuthority` to the control table rather than to `peerId === self`.
   */
  private async queryPeers(): Promise<SeedPeer[]> {
    if (!this.controlDatabase) {
      return [];
    }

    const authorityKeys = await this.controlDatabase.getAuthorityKeys();
    const db = this.controlDatabase.getDatabase();
    const peers: SeedPeer[] = [];

    // Query CadrePeer table
    for await (const row of db.eval('select PeerId, Multiaddr from CadreControl.CadrePeer')) {
      const peerId = row.PeerId as string;
      const multiaddr = row.Multiaddr as string | null;

      // Derive the peer's ed25519 key from its PeerId; a non-Ed25519 peer or an
      // unparsable id yields null and is treated as a non-authority rather than
      // failing the whole seed creation.
      const pubKeyB64 = ed25519PublicKeyB64FromPeerId(peerId);
      const isAuthority = pubKeyB64 !== null && authorityKeys.has(pubKeyB64);

      peers.push({
        peerId,
        multiaddrs: multiaddr ? multiaddr.split(',') : [],
        isAuthority,
        ...(isAuthority ? { publicKey: pubKeyB64 } : {}),
      });
    }

    return peers;
  }

  /**
   * Register the seed protocol handler.
   */
  private registerProtocolHandler(): void {
    if (!this.libp2pNode) return;

    void this.libp2pNode.handle(SEED_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
      const stream = rawStream as LibP2PStream;
      const remotePeerId = (rawConnection as Connection).remotePeer.toString();
      log('Incoming seed delivery from: %s', remotePeerId);

      try {
        // Read the seed message (stream is AsyncIterable in libp2p 3.x)
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        for await (const chunk of stream) {
          const bytes = chunk instanceof Uint8Array ? chunk : (chunk as { subarray(): Uint8Array }).subarray();
          chunks.push(bytes);
          totalLength += bytes.length;
          if (totalLength > MAX_SEED_SIZE) {
            throw new Error('Seed message too large');
          }
        }

        const data = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }

        // Parse length-prefixed message
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
          this.eventCallbacks.onSeedApplied?.(seed.partyId, result.peersAdded);
        } else {
          this.eventCallbacks.onSeedError?.(seed.partyId, result.error ?? 'Unknown error');
        }

        // Send acknowledgment using libp2p 3.x send() API
        const ack: SeedAckMessage = {
          accepted: result.success,
          reason: result.error,
        };

        const ackBytes = new TextEncoder().encode(JSON.stringify(ack));
        const lengthBytes = new Uint8Array(4);
        new DataView(lengthBytes.buffer).setUint32(0, ackBytes.length, false);

        stream.send(lengthBytes);
        stream.send(ackBytes);

      } catch (error) {
        log('Error handling seed delivery: %o', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Emit error event
        this.eventCallbacks.onSeedError?.(this.config.partyId, errorMessage);

        // Send error acknowledgment
        const ack: SeedAckMessage = {
          accepted: false,
          reason: errorMessage,
        };

        const ackBytes = new TextEncoder().encode(JSON.stringify(ack));
        const lengthBytes = new Uint8Array(4);
        new DataView(lengthBytes.buffer).setUint32(0, ackBytes.length, false);

        try {
          stream.send(lengthBytes);
          stream.send(ackBytes);
        } catch {
          // Ignore send errors
        }
      } finally {
        await stream.close();
      }
    });

    log('Registered seed protocol handler: %s', SEED_PROTOCOL);
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
    let authorityAddrs: string[];
    if (this.config.inviteAddressResolver) {
      try {
        authorityAddrs = await this.config.inviteAddressResolver();
      } catch (err) {
        log('inviteAddressResolver threw, falling back to libp2pNode.getMultiaddrs(): %o', err);
        authorityAddrs = this.libp2pNode.getMultiaddrs().map(a => a.toString());
      }
    } else {
      authorityAddrs = this.libp2pNode.getMultiaddrs().map(a => a.toString());
    }

    // Carry the cadre's authority keys out-of-band so a cold-start invitee can
    // pin the trusted authority set before applying any seed.
    const authorityKeys = this.controlDatabase
      ? Array.from(await this.controlDatabase.getAuthorityKeys())
      : [];

    const now = Date.now();
    const invite: CadreInvite = {
      partyId: this.config.partyId,
      authorityAddrs,
      authorityKeys: authorityKeys.length ? authorityKeys : undefined,
      token,
      createdAt: now,
      expiresAt: expiresIn ? now + expiresIn : undefined,
    };

    const encodedInvite = this.encodeInvite(invite);

    log('Invite created with %d authority addresses, %d authority keys', authorityAddrs.length, authorityKeys.length);

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
   * Dial an authority from an invite.
   * Use this on a phone after receiving an invite to connect to the authority.
   *
   * @param invite - The invite received out-of-band
   * @returns Connection to the authority
   */
  async dialInvite(invite: CadreInvite): Promise<void> {
    if (!this.libp2pNode) {
      throw new Error('Service not initialized');
    }

    // Check expiration
    if (invite.expiresAt && Date.now() > invite.expiresAt) {
      throw new Error('Invite has expired');
    }

    log('Dialing invite authority with %d addresses', invite.authorityAddrs.length);

    // Try each authority address until one succeeds
    let lastError: Error | null = null;
    for (const addrStr of invite.authorityAddrs) {
      try {
        const addr = multiaddr(addrStr);
        await this.libp2pNode.dial(addr);
        log('Connected to authority at: %s', addrStr);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        log('Failed to dial %s: %o', addrStr, error);
      }
    }

    throw lastError ?? new Error('No authority addresses available');
  }
}

