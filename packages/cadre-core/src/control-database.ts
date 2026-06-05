import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { Database, registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { digest, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord } from './types.js';
import { CONTROL_SCHEMA } from './control-schema.js';

const log = debug('sereus:cadre:control-db');
const timing = debug('sereus:cadre:timing');

/**
 * Generate a unique stamp ID for transaction authorization.
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 */
function generateStampId(peerId: string): string {
  // Hash the peer ID and get first 16 bytes (128 bits)
  const peerIdHash = digest(peerId, 'sha256', 'utf8', 'bytes') as Uint8Array;
  const peerIdHashPart = peerIdHash.slice(0, 16);

  // Generate 16 random bytes
  const randomPart = randomBytes(128, 'bytes') as Uint8Array;

  // Combine peer ID hash and random bytes
  const combined = new Uint8Array(32);
  combined.set(peerIdHashPart, 0);
  combined.set(randomPart, 16);

  // Convert to base64url
  return uint8ArrayToString(combined, 'base64url');
}

/**
 * Build the canonical authorization message that authority signatures are bound to.
 *
 * The message is the byte concatenation of the per-field SHA-256 digests, in a fixed
 * field order, with the single-use StampId as the final field:
 *
 *   message = sha256(utf8(field_1)) ++ sha256(utf8(field_2)) ++ ... ++ sha256(utf8(StampId))
 *
 * ed25519 signs these raw bytes DIRECTLY (no pre-hash). The SQL constraints verify the
 * identical bytes by concatenating the hex-encoded digests
 * (`digest(field, 'sha256', 'utf8', 'hex') || ...`) and decoding with verify's `'hex'`
 * input encoding — so signer and verifier operate on the same bytes. This binds the
 * signature to the row contents (not a bare stamp), closing the captured-stamp replay /
 * privilege-escalation hole. Single source of truth: every signed writer (and every
 * test/harness signer) MUST build the message through this function in the schema's field
 * order, or `verify` will reject the row.
 */
export function buildAuthorizationMessage(fields: string[]): Uint8Array {
  const parts = fields.map(field => digest(field, 'sha256', 'utf8', 'bytes') as Uint8Array);
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Minimal interface for the CollectionFactory returned by the optimystic plugin.
 * We only need the methods we actually use.
 */
interface CollectionFactory {
  registerLibp2pNode(networkName: string, node: Libp2p, coordinatedRepo: IRepo): void;
  shutdown(): Promise<void>;
}

/** Result of registering the optimystic plugin */
interface OptimysticPluginResult {
  collectionFactory: CollectionFactory;
  vtables: Array<{ name: string; module: unknown; auxData: unknown }>;
  functions: Array<{ schema: unknown }>;
  [key: string]: unknown;
}

export interface ControlDatabaseConfig {
  /** Party ID for the control network */
  partyId: string;
  /**
   * Optional path to the control schema file.
   * If not provided, uses the embedded schema for cross-platform compatibility.
   * Only use this if you need to override the default schema (e.g., for testing).
   */
  schemaPath?: string;
  /** Libp2p node for the control network (injected) */
  libp2pNode: Libp2p;
  /** Coordinated repo from the libp2p node */
  coordinatedRepo: IRepo;
}

/**
 * ControlDatabase manages the CadreControl schema using Quereus with Optimystic backend.
 * It provides typed query methods for accessing control network data.
 */
export class ControlDatabase {
  private db: Database | null = null;
  private collectionFactory: CollectionFactory | null = null;
  private readonly config: ControlDatabaseConfig;
  private initialized = false;

  constructor(config: ControlDatabaseConfig) {
    this.config = config;
  }

  /**
   * Initialize the database - load schema and register plugins
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log('ControlDatabase already initialized');
      return;
    }

    log('Initializing ControlDatabase for party: %s', this.config.partyId);

    // Create database instance
    this.db = new Database();

    // Register crypto plugin (provides digest, sign, verify functions)
    let t0 = performance.now();
    await registerPlugin(this.db, cryptoPlugin);
    timing('[controlDb] cryptoPlugin: %dms', Math.round(performance.now() - t0));
    log('Registered crypto plugin');

    // Register optimystic plugin with network transactor as default
    t0 = performance.now();
    const networkName = `control-${this.config.partyId}`;
    const pluginResult = optimysticPlugin(this.db, {
      default_transactor: 'network',
      default_key_network: 'libp2p',
      default_network_name: networkName,
      enable_cache: true,
    }) as OptimysticPluginResult;

    // Register vtables and functions manually since we need access to collectionFactory
    for (const vtable of pluginResult.vtables as Array<{ name: string; module: unknown; auxData: unknown }>) {
      this.db.registerModule(vtable.name, vtable.module as any, vtable.auxData);
    }
    for (const func of pluginResult.functions as Array<{ schema: unknown }>) {
      this.db.registerFunction(func.schema as any);
    }
    timing('[controlDb] optimysticPlugin: %dms', Math.round(performance.now() - t0));

    this.collectionFactory = pluginResult.collectionFactory;

    // Inject the libp2p node into the collection factory
    t0 = performance.now();
    this.collectionFactory.registerLibp2pNode(
      networkName,
      this.config.libp2pNode,
      this.config.coordinatedRepo
    );
    timing('[controlDb] registerLibp2pNode: %dms', Math.round(performance.now() - t0));
    log('Registered libp2p node with collection factory');

    // Load and execute the schema
    t0 = performance.now();
    await this.loadSchema();
    timing('[controlDb] loadSchema: %dms', Math.round(performance.now() - t0));

    this.initialized = true;
    log('ControlDatabase initialized successfully');
  }

  private async loadSchema(): Promise<void> {
    let schemaContent: string;

    if (this.config.schemaPath) {
      // Load from file if explicitly provided (for testing or custom schemas)
      // This only works in Node.js environments
      log('Loading schema from file: %s', this.config.schemaPath);

      // Check if we're in a Node.js environment
      if (typeof process !== 'undefined' && process.versions?.node) {
        try {
          // Use require to conditionally load fs only in Node.js.
          // This won't be bundled by React Native's Metro bundler — a dynamic
          // import() would be statically picked up by Metro, so require is
          // intentional here (cross-platform constraint, not lazy CommonJS).
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = require('fs/promises');
          schemaContent = await fs.readFile(this.config.schemaPath, 'utf-8');
        } catch (error) {
          throw new Error(
            `Failed to load schema from ${this.config.schemaPath}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        throw new Error(
          'Loading schema from file is not supported in React Native. ' +
          'Remove the schemaPath option to use the embedded schema instead.'
        );
      }
    } else {
      // Use embedded schema for cross-platform compatibility
      log('Using embedded control schema');
      schemaContent = CONTROL_SCHEMA;
    }

    await this.db!.exec(schemaContent);
    log('Schema loaded and executed');
  }

  /**
   * Query all strands from the control database
   */
  async queryStrands(): Promise<StrandRow[]> {
    this.ensureInitialized();
    const results: StrandRow[] = [];
    for await (const row of this.db!.eval('select Id, MemberPrivateKey, Type from CadreControl.Strand')) {
      results.push({
        Id: row.Id as string,
        MemberPrivateKey: row.MemberPrivateKey as string | null,
        Type: row.Type as 'o' | 'c',
      });
    }
    return results;
  }

  /**
   * Get the underlying database for advanced queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * Check whether any authority key exists in the control database.
   * Used to decide whether a fresh-party genesis insert is required.
   */
  async hasAuthorityKey(): Promise<boolean> {
    this.ensureInitialized();
    for await (const row of this.db!.eval('select count(1) as Count from CadreControl.AuthorityKey')) {
      return (row.Count as number) > 0;
    }
    return false;
  }

  /**
   * Idempotent genesis: insert `key` as the founding authority key only when
   * the party has none yet. Returns true if it inserted, false if an authority
   * key already existed (so a repeat `--authority` start is a no-op).
   */
  async ensureAuthorityKey(key: string): Promise<boolean> {
    this.ensureInitialized();
    if (await this.hasAuthorityKey()) {
      log('Authority key already present; skipping genesis insert');
      return false;
    }
    await this.insertAuthorityKey(key);
    return true;
  }

  /**
   * Collect every authority key (`CadreControl.AuthorityKey.Key`) as a set.
   *
   * This is the steady-state trust anchor for seeds: a seed's signer key is
   * trusted only if it is already enrolled here (see `SeedTrustPolicy`). It is
   * also the authority-identity source for `queryPeers`, decoupling authority
   * status from the libp2p transport peer ID.
   */
  async getAuthorityKeys(): Promise<Set<string>> {
    this.ensureInitialized();
    const keys = new Set<string>();
    for await (const row of this.db!.eval('select Key from CadreControl.AuthorityKey')) {
      keys.add(row.Key as string);
    }
    return keys;
  }

  /**
   * Enumerate the CadrePeer rows (cadre membership) for admin/membership reads.
   */
  async queryCadrePeers(): Promise<Array<{ peerId: string; multiaddr: string | null }>> {
    this.ensureInitialized();
    const rows: Array<{ peerId: string; multiaddr: string | null }> = [];
    for await (const row of this.db!.eval('select PeerId, Multiaddr from CadreControl.CadrePeer')) {
      rows.push({
        peerId: row.PeerId as string,
        multiaddr: (row.Multiaddr as string | null) ?? null,
      });
    }
    return rows;
  }

  /**
   * Read a single peer's address record (the full `CadrePeer` row) by PeerId.
   *
   * Returns null when no row exists. Missing/legacy column values are coalesced
   * to their empty form (`''` key/sig, `[]` addrs, `0` stamp) so the caller's
   * verify/freshness gates uniformly reject an unpublished or malformed row.
   * The split `addrs` re-join to the exact stored `Multiaddr` (split-on-`,` is
   * the inverse of join-on-`,`), so the resolver re-verifies over the same bytes
   * the publisher signed.
   */
  async queryPeerRecord(peerId: string): Promise<PeerAddressRecord | null> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select PeerId, PublicKey, Multiaddr, UpdatedAt, Sig from CadreControl.CadrePeer where PeerId = ?',
      [peerId]
    )) {
      const multiaddr = (row.Multiaddr as string | null) ?? '';
      return {
        peerId: row.PeerId as string,
        publicKey: (row.PublicKey as string | null) ?? '',
        addrs: multiaddr.length > 0 ? multiaddr.split(',') : [],
        updatedAt: (row.UpdatedAt as number | null) ?? 0,
        sig: (row.Sig as string | null) ?? '',
      };
    }
    return null;
  }

  /**
   * Apply a peer's own self-signed address-record update to an existing row.
   *
   * Authorization is carried entirely by the record: the `Sig` column (verified
   * by the `AuthorizedUpdate` self-branch against the stored `PublicKey`) plus
   * the strictly-increasing `UpdatedAt`. No authority key is involved, so this
   * is the refresh path for any member — authority or drone — once its row
   * exists. `PublicKey` is intentionally not in the SET list (it is immutable on
   * self-update and the constraint enforces `new.PublicKey = old.PublicKey`).
   */
  async updateSelfPeerRecord(record: PeerAddressRecord): Promise<void> {
    this.ensureInitialized();
    const multiaddr = record.addrs.join(',');
    await this.db!.exec(`
      update CadreControl.CadrePeer
        with context AuthorityKey = null, Signature = ?
        set Multiaddr = ?, UpdatedAt = ?, Sig = ?
        where PeerId = ?
    `, [record.sig, multiaddr, record.updatedAt, record.sig, record.peerId]);
    log('Self peer record updated: %s (updatedAt=%d)', record.peerId, record.updatedAt);
  }

  /**
   * Insert the initial authority key (bootstrap - no existing authorities required)
   */
  async insertAuthorityKey(key: string): Promise<void> {
    this.ensureInitialized();
    log('Inserting authority key: %s', key);

    // Bootstrap is authorized by the schema's `(select count(1) from AuthorityKey) <= 1`
    // branch, so no signature is needed. We still persist a fresh, unique StampId in the
    // row's own column to satisfy the not-null/unique anti-replay constraint — the StampId
    // is now a real column value, not the optimystic `StampId()` SQL function.
    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());
    await this.db!.exec(`
      insert into CadreControl.AuthorityKey (Key, StampId)
        with context AuthorityKey = null, Signature = null
        values (?, ?)
    `, [key, stampId]);
    log('Authority key inserted');
  }

  /**
   * Insert a strand into the control database using an authority signature.
   *
   * The authority signs the canonical row-bound authorization message (see
   * {@link buildAuthorizationMessage}) — NOT a bare stamp — so the signature is bound to
   * this strand's contents and cannot be transplanted onto an attacker-chosen row. The
   * StampId is persisted as a unique column for single-use anti-replay.
   *
   * @param strandId - Unique identifier for the strand
   * @param type - Strand type: 'o' for open, 'c' for closed
   * @param authorityKey - Public key of the authorizing authority
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the authority's private key, returning a base64url signature
   * @param memberPrivateKey - Optional private key for membership in closed strands
   */
  async insertStrand(
    strandId: string,
    type: 'o' | 'c',
    authorityKey: string,
    signMessage: (message: Uint8Array) => string,
    memberPrivateKey?: string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting strand: %s (type: %s)', strandId, type);

    // Generate a unique stamp ID using the peer ID for distributed uniqueness
    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's Strand `Authorized` verify:
    // Id, Type, MemberPrivateKey ('' when null), StampId.
    const message = buildAuthorizationMessage([strandId, type, memberPrivateKey ?? '', stampId]);
    const signature = signMessage(message);

    // StampId is a real, unique column (single-use anti-replay), no longer a context value.
    await this.db!.exec(`
      insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?, ?, ?)
    `, [authorityKey, signature, strandId, type, memberPrivateKey ?? null, stampId]);

    log('Strand inserted: %s', strandId);
  }

  /**
   * Insert a validation key into the control database using an authority signature.
   *
   * Mirrors {@link insertStrand}: the authority signs the canonical row-bound
   * authorization message over (Key, StampId), and the StampId is persisted as a unique
   * column for single-use anti-replay. A `ValidationKey` authorizes verifying strand
   * formation disclosures.
   *
   * @param key - The validation public key to enroll
   * @param authorityKey - Public key of the authorizing authority
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the authority's private key, returning a base64url signature
   */
  async insertValidationKey(
    key: string,
    authorityKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting validation key: %s', key);

    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's ValidationKey `Authorized` verify: Key, StampId.
    const message = buildAuthorizationMessage([key, stampId]);
    const signature = signMessage(message);

    await this.db!.exec(`
      insert into CadreControl.ValidationKey (Key, StampId)
        with context AuthorityKey = ?, Signature = ?
        values (?, ?)
    `, [authorityKey, signature, key, stampId]);

    log('Validation key inserted: %s', key);
  }

  /**
   * Close the database and cleanup resources
   */
  async close(): Promise<void> {
    if (this.collectionFactory) {
      await this.collectionFactory.shutdown();
      this.collectionFactory = null;
    }
    if (this.db) {
      void this.db.close();
      this.db = null;
    }
    this.initialized = false;
    log('ControlDatabase closed');
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error('ControlDatabase not initialized. Call initialize() first.');
    }
  }
}

