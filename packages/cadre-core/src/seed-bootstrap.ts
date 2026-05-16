import debug from 'debug';
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from 'uint8arrays';
import { digest, sign, verify, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p, PeerId, Connection } from '@libp2p/interface';
import { multiaddr } from '@multiformats/multiaddr';
import type { Multiaddr } from '@multiformats/multiaddr';
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
  SignedTransaction,
  AddDroneOptions,
  AddPhoneOptions,
  DroneInitResult,
  InviteResult,
  CadreInvite
} from './types.js';
import type { ControlDatabase } from './control-database.js';

const log = debug('sereus:cadre:seed-bootstrap');

/** Protocol ID for seed delivery */
export const SEED_PROTOCOL = '/sereus/seed/1.0.0';

/** Maximum seed message size (1MB) */
const MAX_SEED_SIZE = 1024 * 1024;

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
 * the new node's cache with peer information and optionally transactions.
 */
export class SeedBootstrapService {
  private readonly config: SeedBootstrapConfig;
  private libp2pNode: Libp2p | null = null;
  private controlDatabase: ControlDatabase | null = null;
  private readonly authorityPublicKey: string | null;
  private eventCallbacks: SeedEventCallbacks = {};

  constructor(config: SeedBootstrapConfig) {
    this.config = config;

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
   * Initialize the service with libp2p node and control database
   */
  initialize(libp2pNode: Libp2p, controlDatabase: ControlDatabase): void {
    this.libp2pNode = libp2pNode;
    this.controlDatabase = controlDatabase;
    
    // Register the seed protocol handler
    this.registerProtocolHandler();
    
    log('SeedBootstrapService initialized');
  }

  /**
   * Authorize a new peer to join the cadre.
   * Signs the peer ID with the authority key and inserts into CadrePeer table.
   */
  async authorizePeer(options: AuthorizePeerOptions): Promise<void> {
    const { peerId, multiaddrs } = options;
    
    if (!this.config.authorityPrivateKey) {
      throw new Error('Authority private key required to authorize peers');
    }
    
    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }
    
    log('Authorizing peer: %s', peerId);
    
    // Sign the peer ID with the authority key
    const peerIdDigest = digest(peerId, 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(
      peerIdDigest,
      this.config.authorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;
    
    // Insert into CadrePeer table with authority context
    const db = this.controlDatabase.getDatabase();
    // CadrePeer.Multiaddr is NOT NULL; use empty string when no addrs provided
    const multiaddrStr = multiaddrs?.length ? multiaddrs.join(',') : '';

    await db.exec(`
      insert into CadreControl.CadrePeer (PeerId, Multiaddr)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?)
    `, [this.authorityPublicKey, signature, peerId, multiaddrStr]);

    log('Peer %s authorized successfully', peerId);
  }

  /**
   * Remove a peer from the cadre by authority signature.
   *
   * The constraint over CadrePeer's `check on insert, delete` validates a
   * signature over `digest(old.PeerId, 'sha256', 'utf8')` by an authority
   * key. We use the same digest pattern as authorizePeer.
   */
  async removePeer(peerId: string): Promise<void> {
    if (!this.config.authorityPrivateKey) {
      throw new Error('Authority private key required to remove peers');
    }

    if (!this.controlDatabase) {
      throw new Error('Control database not initialized');
    }

    log('Removing peer: %s', peerId);

    const peerIdDigest = digest(peerId, 'sha256', 'utf8', 'base64url') as string;
    const signature = sign(
      peerIdDigest,
      this.config.authorityPrivateKey,
      'ed25519',
      'base64url',
      'base64url',
      'base64url'
    ) as string;

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
    
    // Sign the seed
    const seedJson = JSON.stringify(seedData);
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
   * Validates the seed signature before applying.
   */
  async applySeed(seed: ControlNetworkSeed): Promise<ApplySeedResult> {
    if (!this.libp2pNode) {
      return { success: false, peersAdded: 0, error: 'Service not initialized' };
    }

    log('Applying seed for party: %s', seed.partyId);

    // Validate the seed signature
    if (!this.validateSeedSignature(seed)) {
      return { success: false, peersAdded: 0, error: 'Invalid seed signature' };
    }

    // Verify the signer's key matches an authority peer's public key
    const signerIsAuthority = seed.peers.some(
      p => p.isAuthority && p.publicKey === seed.signerKey
    );
    if (!signerIsAuthority) {
      return { success: false, peersAdded: 0, error: 'Signer key does not match any authority peer' };
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
        transactions: seed.transactions,
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
      const responseLength = new DataView(responseData.buffer, responseData.byteOffset).getUint32(0, false);
      const responseJson = new TextDecoder().decode(responseData.slice(4, 4 + responseLength));
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
      // Reconstruct the signed data (seed without signature fields)
      const seedData = {
        partyId: seed.partyId,
        peers: seed.peers,
        ...(seed.transactions ? { transactions: seed.transactions } : {}),
      };

      const seedJson = JSON.stringify(seedData);
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
   */
  private async queryPeers(): Promise<SeedPeer[]> {
    if (!this.controlDatabase) {
      return [];
    }

    const db = this.controlDatabase.getDatabase();
    const peers: SeedPeer[] = [];

    // First, get all authority keys
    const authorityKeys = new Set<string>();
    for await (const row of db.eval('select Key from CadreControl.AuthorityKey')) {
      authorityKeys.add(row.Key as string);
    }

    // Query CadrePeer table
    for await (const row of db.eval('select PeerId, Multiaddr from CadreControl.CadrePeer')) {
      const peerId = row.PeerId as string;
      const multiaddr = row.Multiaddr as string | null;

      // Mark peer as authority if it matches the service's own peer ID
      const isAuthority = peerId === this.libp2pNode?.peerId.toString();

      peers.push({
        peerId,
        multiaddrs: multiaddr ? multiaddr.split(',') : [],
        isAuthority,
        ...(isAuthority && this.authorityPublicKey ? { publicKey: this.authorityPublicKey } : {}),
      });
    }

    return peers;
  }

  /**
   * Register the seed protocol handler.
   */
  private registerProtocolHandler(): void {
    if (!this.libp2pNode) return;

    this.libp2pNode.handle(SEED_PROTOCOL, async (rawStream: unknown, rawConnection: unknown) => {
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
        const messageLength = new DataView(data.buffer, data.byteOffset).getUint32(0, false);
        const messageJson = new TextDecoder().decode(data.slice(4, 4 + messageLength));
        const message = JSON.parse(messageJson) as SeedMessage;

        // Emit seed received event
        this.eventCallbacks.onSeedReceived?.(message.partyId, remotePeerId);

        // Convert to seed and apply
        const seed: ControlNetworkSeed = {
          partyId: message.partyId,
          peers: message.peers,
          transactions: message.transactions,
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

    // Get this node's dialable addresses
    const addrs = this.libp2pNode.getMultiaddrs();
    const authorityAddrs = addrs.map(a => a.toString());

    const now = Date.now();
    const invite: CadreInvite = {
      partyId: this.config.partyId,
      authorityAddrs,
      token,
      createdAt: now,
      expiresAt: expiresIn ? now + expiresIn : undefined,
    };

    const encodedInvite = this.encodeInvite(invite);

    log('Invite created with %d authority addresses', authorityAddrs.length);

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

