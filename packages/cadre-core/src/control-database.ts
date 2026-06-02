import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { Database, registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { digest, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord } from './types.js';

const log = debug('sereus:cadre:control-db');
const timing = debug('sereus:cadre:timing');

/**
 * Embedded control schema for cross-platform compatibility.
 * This schema is embedded directly in the code to work in React Native and other
 * environments where file system access is not available.
 */
const CONTROL_SCHEMA = `-- This manages a Sereus party's cadre, or set of nodes, and their participation in strands (networks)
declare schema CadreControl {
    -- A key that can authorize various control changes
    table AuthorityKey (
        Key text primary key,
        constraint Authorized check (
            -- Bootstrap: first authority key needs no existing authorization
            (select count(1) from AuthorityKey) <= 1

                -- Old authority can authorize by signature and transaction stamp id (not repeatable)
                or (old.Key is not null and old.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, old.Key, 'ed25519'))

                -- or other authorities can authorize by signature and transaction stamp id (not repeatable)
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text null, StampId text);

    -- A key that can validate a strand formation disclosure
    table ValidationKey (
        Key text primary key,
        constraint Authorized check (
            -- Authorities can authorize by signature and transaction stamp id (not repeatable)
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text, StampId text, Signature text);

    -- A network of members sharing an sApp database, each contributing peer nodes (their cadre) to the overall cohort
    -- Cadre peers should participate in each of these strands
    table Strand (
        Id text primary key,    -- UUID
        MemberPrivateKey text null unique,   -- Our private key as a member of this strand
        Type text, -- Types: 'o' = Open, 'c' = Closed -- Open can still control writes in the sApp, but only Closed controls reads
        constraint Authorized check (
            -- Authorized by authority signature and transaction stamp id (not repeatable)
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))

                -- or authorized by a cadre peer who has received a valid formation invitation
                or exists (select 1 from FormationUsage FU where FU.StrandId = new.Id)
        ),
        -- TODO: constraint to ensure member private key only if closed
    ) with context (AuthorityKey text, StampId text, Signature text);

    -- A peer (node) that is part of the cadre, carrying a self-published,
    -- freshness-stamped, self-signed address record (see PeerAddressRecord).
    -- The row IS the peer-address record: a resolver reads it, re-verifies Sig against
    -- PublicKey, checks freshness (UpdatedAt) and trust, then dials the addrs.
    table CadrePeer (
        PeerId text primary key,
        PublicKey text null,            -- ed25519 (base64url) whose libp2p identity == PeerId (null if non-Ed25519)
        Multiaddr text,                 -- comma-joined current addrs (signaling / p2p-circuit first)
        UpdatedAt int null,             -- epoch ms; strictly increases per self-update (replay/rollback guard)
        Sig text null,                  -- ed25519 self-signature over the signed payload (base64url); null until self-published
        constraint AuthorizedInsert check on insert, delete (
            -- Authorized by an authority key, which vouches both membership and the
            -- PublicKey<->PeerId binding (cadre-core derives PublicKey from PeerId before insert).
            -- Use utf8 input encoding since peer IDs are base58btc strings, not base64url
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(coalesce(new.PeerId, old.PeerId), 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        ),
        constraint AuthorizedUpdate check on update (
            -- Peer self-updates its own addrs + freshness, signing with its OWN ed25519 key
            -- (the key behind PeerId). PeerId/PublicKey are immutable on self-update, UpdatedAt
            -- must strictly increase (replay guard), and Sig is verified against the stored
            -- PublicKey over the same payload the publish path signs
            -- (peer-record.ts:peerRecordSignedPayload).
            (
                new.PeerId = old.PeerId
                and new.PublicKey = old.PublicKey
                and new.UpdatedAt > coalesce(old.UpdatedAt, 0)
                and verify(
                        digest(new.PeerId || '|' || new.Multiaddr || '|' || cast(new.UpdatedAt as text), 'sha256', 'utf8'),
                        new.Sig, new.PublicKey, 'ed25519')
            )
                -- or an authority re-authorizes (rotation / correction)
                or exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(new.PeerId, 'sha256', 'utf8'), context.Signature, A.Key, 'ed25519'))
        )
    ) with context (AuthorityKey text null, Signature text);

    -- An open invitation to form a strand with this party
    table FormationInvite (
        Token text primary key, -- Just a random string
        sAppId text, -- The app for the strand that will be formed
        ExpiresAt datetime null,
        TotalUses int null check (TotalUses >= 0),
        ValidationUrl text null,   -- Web hook - send disclosure, IP address...
        constraint AuthorizedAddOrRemove check on insert, delete (
            -- Authorized by an authority key to add or remove this invite
            exists (select 1 from AuthorityKey A where A.Key = context.AuthorityKey and verify(digest(context.StampId), context.Signature, A.Key))
        )
    ) with context (AuthorityKey text, StampId text, Signature text);

    table FormationUsage (
        Token text,
        UseNumber int,
        Disclosure text,
        StrandId text,
        primary key (Token, UseNumber),
        constraint InsertOnly check on update, delete (false),
        constraint Monotonic check (
            new.UseNumber = coalesce((select max(UseNumber) from FormationUsage U where U.Token = new.Token), 0) + 1
        ),
        constraint Authorized check on insert (
            -- Satisfies an invitation
            exists (
                select 1 from FormationInvite FI
                    where FI.Token = new.Token
                        and (FI.TotalUses is null or FI.TotalUses >= new.UseNumber)
                        and (FI.ExpiresAt is null or FI.ExpiresAt > context.Now)
                        and (FI.ValidationUrl is null or verify(digest(new.Token, new.Disclosure), context.ValidationSignature, context.ValidationKey))
            )
        ),
        constraint StrandExists check (exists (select 1 from Strand S where S.Id = new.StrandId)),
    ) with context (PeerId text, PeerSignature text, Now datetime, ValidationKey text null, ValidationSignature text null);
}

apply schema CadreControl;`;

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
          // Use require to conditionally load fs only in Node.js
          // This won't be bundled by React Native's Metro bundler
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

    // For bootstrap, context values are not verified since no existing authorities
    // Use fully qualified table name since schema is CadreControl
    // StampId() provides the transaction's unique stamp from the optimystic transaction
    await this.db!.exec(`
      insert into CadreControl.AuthorityKey (Key)
        with context AuthorityKey = null, Signature = null, StampId = StampId()
        values (?)
    `, [key]);
    log('Authority key inserted');
  }

  /**
   * Insert a strand into the control database using authority signature.
   * This starts a transaction, gets the StampId, signs it, and inserts the strand.
   *
   * @param strandId - Unique identifier for the strand
   * @param type - Strand type: 'o' for open, 'c' for closed
   * @param authorityKey - Public key of the authorizing authority
   * @param signStampId - Function to sign the stamp ID with the authority's private key
   * @param memberPrivateKey - Optional private key for membership in closed strands
   */
  async insertStrand(
    strandId: string,
    type: 'o' | 'c',
    authorityKey: string,
    signStampId: (stampId: string) => string,
    memberPrivateKey?: string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting strand: %s (type: %s)', strandId, type);

    // Generate a unique stamp ID using the peer ID for distributed uniqueness
    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Sign the stamp ID with the authority key
    const signature = signStampId(stampId);

    // Insert with the signed stamp ID
    await this.db!.exec(`
      insert into CadreControl.Strand (Id, Type, MemberPrivateKey)
        with context AuthorityKey = ?, Signature = ?, StampId = ?
        values (?, ?, ?)
    `, [authorityKey, signature, stampId, strandId, type, memberPrivateKey ?? null]);

    log('Strand inserted: %s', strandId);
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
      this.db.close();
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

