import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { Database, registerPlugin } from '@quereus/quereus';
import type { VTablePluginInfo, FunctionPluginInfo } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { digest, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord, CadrePeerRow, DeviceTokenRecord, PushPlatform } from './types.js';
import { CONTROL_SCHEMA } from './control-schema.js';
import { canonicalDatetime } from './canonical-datetime.js';
import { controlAuthorizationFields, CONTROL_TABLES } from './control-authorization.js';
import type { ControlTable, ControlDomain, ControlAction } from './control-authorization.js';

export type { ControlTable, ControlDomain, ControlAction } from './control-authorization.js';

const log = debug('sereus:cadre:control-db');
const timing = debug('sereus:cadre:timing');

/**
 * Generate a unique stamp ID for transaction authorization.
 * Format: 32 bytes base64url encoded
 * - First 16 bytes: SHA-256 hash of peer ID (for distributed uniqueness)
 * - Last 16 bytes: Random bytes (for collision resistance)
 */
export function generateStampId(peerId: string): string {
  // Hash the peer ID and get first 16 bytes (128 bits). A purely local ID
  // generator: never signed/verified against SQL, so the framed single-field
  // digest is fine (the changed framing is not cross-checked anywhere).
  const peerIdHash = digest([peerId], 'sha256', 'bytes') as Uint8Array;
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
 * A `FormationUsage` was to be recorded against a host `Strand` row that is not
 * present locally.
 *
 * Consent is bound to the strand's one-off `StampId` (see the consent branch of
 * `Strand.AuthorizedInsert`), so the writer must read the live row before inserting.
 * The ordinary "host strand has not converged on this responder yet" case is caught
 * earlier and reported as `missing` by `ControlFormationUsageRecorder.resolveStrand`;
 * reaching here means the row vanished between that check and the write, which is a
 * genuine race and is surfaced rather than left to fail the deferred `StrandExists`
 * CHECK at commit (which would drop the write with a far less legible error).
 */
export class MissingHostStrandError extends Error {
  constructor(readonly strandId: string, readonly token: string) {
    super(`Cannot record formation usage for token ${token}: host strand ${strandId} is not present`);
    this.name = 'MissingHostStrandError';
  }
}

/**
 * Parse a stored Quereus `datetime` value into epoch milliseconds.
 *
 * Quereus canonicalises a `datetime` column to a bare UTC `PlainDateTime` string
 * (e.g. `2026-06-04T12:34:56`, no `Z`). JS `Date` reads a timezone-less
 * date-time as LOCAL, so we append `Z` when no offset/zone is present to keep the
 * value anchored to UTC. Numbers (already epoch ms) pass through.
 */
function parseStoredDatetimeMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(value);
  return new Date(hasZone ? value : `${value}Z`).getTime();
}

/**
 * Parse a nullable stored `datetime` column into epoch ms, mapping both "absent"
 * and "unparseable" to null — i.e. "no expiry". Shared by every `ExpiresAt`
 * reader so the NaN guard cannot drift between them.
 */
function parseNullableStoredDatetimeMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = parseStoredDatetimeMs(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Build the canonical authorization message that owner signatures are bound to.
 *
 * The message is a SINGLE framed SHA-256 digest over the ordered field vector from
 * {@link controlAuthorizationFields} (the crypto plugin's injective multi-field
 * encoding): two fixed literals — the domain tag naming the table rule and the action
 * tag — followed by the row fields in the schema's fixed order, with the single-use
 * StampId as the final field where the table has one:
 *
 *   message = sha256(encodeFields([domain, action, field_1, ..., StampId]))   // raw digest bytes
 *
 * ed25519 signs these raw digest bytes DIRECTLY (no second hash). The SQL constraints
 * verify the identical bytes with one variadic call
 * (`verify(digest('CadreControl.X', 'add', field_1, ...), context.Signature, A.Key, 'ed25519')`):
 * SQL `digest(...)` returns the base64url string of the same digest, which `verify`'s default
 * base64url input encoding decodes back to those raw bytes — so signer and verifier
 * operate on the same bytes. Every field is TEXT on both sides (the SQL columns are
 * `cast(... as text)` / `coalesce(...,'')`; the TS args are strings), so the per-field
 * type tags agree. Binding the row contents closes captured-stamp replay; the leading
 * domain/action tags scope the signature to ONE table rule, so an approval minted for
 * one constraint can never satisfy another (e.g. a ValidationKey enrollment can no
 * longer double as an OwnerKey enrollment). Single source of truth: every signed writer
 * (and every test/harness signer) MUST build the message through this function with the
 * schema's tags and field order, or `verify` will reject the row.
 */
export function buildAuthorizationMessage(
  domain: ControlDomain,
  action: ControlAction,
  rowFields: string[],
): Uint8Array {
  return digest(controlAuthorizationFields(domain, action, rowFields), 'sha256', 'bytes') as Uint8Array;
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
  vtables: VTablePluginInfo[];
  functions: FunctionPluginInfo[];
  /**
   * Hydrate Quereus's in-memory catalog from persisted optimystic vtab schemas.
   * Must run BEFORE applying CONTROL_SCHEMA on a warm restart so the declarative
   * diff sees the existing tables and skips re-emitting CREATE TABLE / CREATE INDEX
   * for each persisted control object. Idempotent; `{ tables: 0, indexes: 0 }` on a
   * cold/in-memory start. Mirrors the strand path's hydrate-before-apply (see
   * compose-strand.ts).
   */
  hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>;
  [key: string]: unknown;
}

/** Runtime guard for the dynamic-`from` count, over the one table list. */
const CONTROL_TABLE_SET: ReadonlySet<ControlTable> = new Set<ControlTable>(CONTROL_TABLES);

/**
 * The control tables whose rows carry a single-use `StampId` retired into
 * `CadreControl.Revocation` on delete — i.e. the ones the schema's
 * `NotRevoked` / `RevocationRecorded` CHECK pair guards. `Extract` from
 * {@link ControlTable} rather than a fresh literal list, so a renamed table is a
 * compile error here instead of a silently dead branch.
 */
export type RevocableTable = Extract<ControlTable, 'OwnerKey' | 'CadrePeer' | 'ValidationKey' | 'Strand'>;

/** Primary-key column of each {@link RevocableTable}, in that order. */
type GuardedKeyColumn = 'Key' | 'Id' | 'PeerId';

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
    }) as unknown as OptimysticPluginResult;

    // Register vtables and functions manually since we need access to collectionFactory
    for (const vtable of pluginResult.vtables) {
      this.db.registerModule(vtable.name, vtable.module, vtable.auxData);
    }
    for (const func of pluginResult.functions) {
      this.db.registerFunction(func.schema);
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

    // Network-back the control tables. CONTROL_SCHEMA's `declare schema CadreControl
    // { table ... }` tables carry NO per-table `using optimystic(...)`, so storage is
    // chosen by the database's DEFAULT vtab. Routing the default to optimystic (with
    // the network transactor + this party's control network) is what makes a control
    // write replicate peer-to-peer — exactly what connectToStrand does for strand
    // tables (compose-strand.ts). Without these two calls the tables fall back to
    // Quereus's in-memory vtab and never converge across the cadre.
    this.db.setDefaultVtabName('optimystic');
    this.db.setDefaultVtabArgs({
      networkName,
      transactor: 'network',
      keyNetwork: 'libp2p',
    });
    log('Set default vtab to optimystic (networkName=%s, transactor=network)', networkName);

    // Hydrate Quereus's catalog from any persisted optimystic vtab schemas BEFORE
    // applying CONTROL_SCHEMA, so a warm restart with persistent storage diffs the
    // control DDL against the already-present tables and re-emits nothing — the same
    // warm-start regression connectToStrand's hydrate-before-apply guards against.
    // No-op on a cold / in-memory start (`{ tables: 0, indexes: 0 }`).
    t0 = performance.now();
    const hydrated = await pluginResult.hydrate(this.db);
    timing('[controlDb] hydrate: %dms (tables=%d, indexes=%d)',
      Math.round(performance.now() - t0), hydrated.tables, hydrated.indexes);
    log('Hydrated control catalog (tables=%d, indexes=%d)', hydrated.tables, hydrated.indexes);

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
            `Failed to load schema from ${this.config.schemaPath}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
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
   * Read a single strand row by id, or null when absent. Single-row sibling of
   * {@link queryStrands}; the responder uses it to read a host strand's
   * `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
   * validated invitee during provision-then-record formation.
   */
  async queryStrand(strandId: string): Promise<StrandRow | null> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select Id, MemberPrivateKey, Type from CadreControl.Strand where Id = ?',
      [strandId]
    )) {
      return {
        Id: row.Id as string,
        MemberPrivateKey: row.MemberPrivateKey as string | null,
        Type: row.Type as 'o' | 'c',
      };
    }
    return null;
  }

  /**
   * Count rows in a CadreControl table as seen by THIS database instance.
   *
   * `table` is validated against {@link CONTROL_TABLE_SET} before it is interpolated
   * into the `from` clause: the names are not user input, but the check keeps the
   * dynamic query off the injection surface and fails loudly on a typo instead of
   * emitting a malformed statement. The count reflects only the rows this node's
   * control DB has converged on — in the integration harness that is the owner
   * node (one ControlDatabase per party), i.e. the authoritative control-network
   * view, not a per-drone convergence guarantee.
   */
  async countRows(table: ControlTable): Promise<number> {
    this.ensureInitialized();
    if (!CONTROL_TABLE_SET.has(table)) {
      throw new Error(`Unknown CadreControl table: ${table}`);
    }
    for await (const row of this.db!.eval(`select count(1) as Count from CadreControl.${table}`)) {
      return (row.Count as number) ?? 0;
    }
    return 0;
  }

  /**
   * Get the underlying database for advanced queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * Check whether any owner key exists in the control database.
   * Used to decide whether a fresh-party genesis insert is required.
   */
  async hasOwnerKey(): Promise<boolean> {
    this.ensureInitialized();
    for await (const row of this.db!.eval('select count(1) as Count from CadreControl.OwnerKey')) {
      return (row.Count as number) > 0;
    }
    return false;
  }

  /**
   * Idempotent genesis: insert `key` as the founding owner key only when
   * the party has none yet. Returns true if it inserted, false if an owner
   * key already existed (so a repeat `--owner` start is a no-op).
   */
  async ensureOwnerKey(key: string): Promise<boolean> {
    this.ensureInitialized();
    if (await this.hasOwnerKey()) {
      log('Owner key already present; skipping genesis insert');
      return false;
    }
    await this.insertOwnerKey(key);
    return true;
  }

  /**
   * Collect every owner key (`CadreControl.OwnerKey.Key`) as a set.
   *
   * This is the steady-state trust anchor for seeds: a seed's signer key is
   * trusted only if it is already enrolled here (see `SeedTrustPolicy`). It is
   * also the owner-identity source for `queryPeers`, decoupling owner
   * status from the libp2p transport peer ID.
   */
  async getOwnerKeys(): Promise<Set<string>> {
    this.ensureInitialized();
    const keys = new Set<string>();
    for await (const row of this.db!.eval('select Key from CadreControl.OwnerKey')) {
      keys.add(row.Key as string);
    }
    return keys;
  }

  /**
   * Enumerate the CadrePeer rows (cadre membership) for admin/membership reads.
   * Includes the persisted voucher columns, which
   * {@link CadreNode.listAuthorizedMembers} re-checks against its node-local anchor.
   */
  async queryCadrePeers(): Promise<CadrePeerRow[]> {
    this.ensureInitialized();
    const rows: CadrePeerRow[] = [];
    for await (const row of this.db!.eval('select PeerId, Multiaddr, StampId, VouchOwner, VouchSig from CadreControl.CadrePeer')) {
      rows.push({
        peerId: row.PeerId as string,
        multiaddr: (row.Multiaddr as string | null) ?? null,
        stampId: (row.StampId as string | null) ?? null,
        vouchOwner: (row.VouchOwner as string | null) ?? null,
        vouchSig: (row.VouchSig as string | null) ?? null,
      });
    }
    return rows;
  }

  /**
   * Read one guarded row's single-use `StampId` nonce (null when the row does not
   * exist). Every owner-signed delete / re-touch path must bind its signature to the
   * row's CURRENT nonce, so they all read through here first.
   *
   * `table` / `keyColumn` are interpolated into the SQL, so both are typed as closed
   * literal unions — no caller-supplied string can reach the statement (same
   * injection-surface discipline as {@link countRows}'s `CONTROL_TABLE_SET` guard).
   */
  private async queryStampId(
    table: RevocableTable,
    keyColumn: GuardedKeyColumn,
    keyValue: string
  ): Promise<string | null> {
    this.ensureInitialized();
    const sql = `select StampId from CadreControl.${table} where ${keyColumn} = ?`;
    for await (const row of this.db!.eval(sql, [keyValue])) {
      return (row.StampId as string | null) ?? null;
    }
    return null;
  }

  /**
   * `CadrePeer` stamp nonce — bound into {@link cadrePeerRemoveDigest} /
   * {@link cadrePeerVoucherDigest} by the owner delete / re-touch paths.
   */
  queryCadrePeerStampId(peerId: string): Promise<string | null> {
    return this.queryStampId('CadrePeer', 'PeerId', peerId);
  }

  /** `Strand` stamp nonce — bound into {@link deleteStrand}'s remove digest. */
  queryStrandStampId(strandId: string): Promise<string | null> {
    return this.queryStampId('Strand', 'Id', strandId);
  }

  /** `ValidationKey` stamp nonce — bound into {@link deleteValidationKey}'s remove digest. */
  queryValidationKeyStampId(key: string): Promise<string | null> {
    return this.queryStampId('ValidationKey', 'Key', key);
  }

  /**
   * Collect the retired `StampId` nonces recorded in `CadreControl.Revocation` for one
   * {@link RevocableTable}. A stamp
   * lands here when its row is removed ({@link SeedBootstrapService.removePeer},
   * {@link deleteValidationKey}, {@link deleteStrand}), and retirement is permanent —
   * the table is append-only. Read-side mitigation for the write-time race: the
   * schema's `NotRevoked` CHECK only sees locally visible tombstones, so a node that
   * converged on a resurrected row before its tombstone can hold both; readers
   * ({@link CadreNode.listAuthorizedMembers}) drop any row whose stamp appears here.
   *
   * NOTE: re-reads the whole retired set on every call, and the caller runs per inbound
   * gate request while the table only ever grows. Cheap today (a cadre removes peers
   * rarely); if removals ever become routine, cache the set and invalidate it on write.
   */
  async queryRevokedStamps(tableName: RevocableTable): Promise<Set<string>> {
    this.ensureInitialized();
    const stamps = new Set<string>();
    for await (const row of this.db!.eval('select StampId from CadreControl.Revocation where TableName = ?', [tableName])) {
      stamps.add(row.StampId as string);
    }
    return stamps;
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
   * the strictly-increasing `UpdatedAt`. No owner key is involved, so this
   * is the refresh path for any member — owner or drone — once its row
   * exists. `PublicKey` is intentionally not in the SET list (it is immutable on
   * self-update and the constraint enforces `new.PublicKey = old.PublicKey`).
   */
  async updateSelfPeerRecord(record: PeerAddressRecord): Promise<void> {
    this.ensureInitialized();
    const multiaddr = record.addrs.join(',');
    await this.db!.exec(`
      update CadreControl.CadrePeer
        with context OwnerKey = null, Signature = ?
        set Multiaddr = ?, UpdatedAt = ?, Sig = ?
        where PeerId = ?
    `, [record.sig, multiaddr, record.updatedAt, record.sig, record.peerId]);
    log('Self peer record updated: %s (updatedAt=%d)', record.peerId, record.updatedAt);
  }

  /**
   * Read a single peer's device push token (the full `DeviceToken` row) by PeerId.
   *
   * Returns null when no row exists. Missing/legacy column values are coalesced to
   * their empty form (`''` token/sig, `0` stamp) so the caller's verify/freshness
   * gates uniformly reject an unpublished or malformed row. `platform` is returned
   * verbatim (the resolver validates it against {@link PushPlatform} and re-verifies
   * the self-signature, which covers the platform field).
   */
  async queryDeviceToken(peerId: string): Promise<DeviceTokenRecord | null> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select PeerId, Platform, Token, UpdatedAt, Sig from CadreControl.DeviceToken where PeerId = ?',
      [peerId]
    )) {
      return {
        peerId: row.PeerId as string,
        platform: (row.Platform as string ?? '') as PushPlatform,
        token: (row.Token as string | null) ?? '',
        updatedAt: (row.UpdatedAt as number | null) ?? 0,
        sig: (row.Sig as string | null) ?? '',
      };
    }
    return null;
  }

  /**
   * Apply a peer's own self-signed device-token update to an existing row.
   *
   * Authorization is carried entirely by the record: the `Sig` column (verified by
   * the `DeviceToken.AuthorizedUpdate` self-branch against the stored
   * `CadrePeer.PublicKey`) plus the strictly-increasing `UpdatedAt`. No owner key
   * is involved, so this is the refresh / rotation path for any member once both its
   * `CadrePeer` row (for the PublicKey) and its `DeviceToken` row exist. `PeerId` is
   * intentionally not in the SET list (immutable; the constraint enforces
   * `new.PeerId = old.PeerId`). Mirrors {@link updateSelfPeerRecord}.
   */
  async updateSelfDeviceToken(record: DeviceTokenRecord): Promise<void> {
    this.ensureInitialized();
    await this.db!.exec(`
      update CadreControl.DeviceToken
        with context OwnerKey = null, Signature = ?
        set Platform = ?, Token = ?, UpdatedAt = ?, Sig = ?
        where PeerId = ?
    `, [record.sig, record.platform, record.token, record.updatedAt, record.sig, record.peerId]);
    log('Self device token updated: %s (platform=%s, updatedAt=%d)', record.peerId, record.platform, record.updatedAt);
  }

  /**
   * Insert the initial owner key (bootstrap - no existing owners required)
   */
  async insertOwnerKey(key: string): Promise<void> {
    this.ensureInitialized();
    log('Inserting owner key: %s', key);

    // Bootstrap is authorized by the schema's genesis branch — `(select count(1) from
    // committed.OwnerKey) = 0`, i.e. the party had no owner before this transaction — so no
    // signature is needed. Every other branch of `OwnerKey.Authorized` requires a signature
    // from a PRE-EXISTING owner, so this method only ever succeeds on a fresh party; seating
    // a second owner (or removing one) has no writer here and must sign the digests
    // documented on the schema's `Authorized` constraint. We still persist a fresh, unique
    // StampId in the row's own column to satisfy the not-null/unique anti-replay constraint —
    // the StampId is a real column value, not the optimystic `StampId()` SQL function.
    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());
    await this.db!.exec(`
      insert into CadreControl.OwnerKey (Key, StampId)
        with context OwnerKey = null, Signature = null
        values (?, ?)
    `, [key, stampId]);
    log('Owner key inserted');
  }

  /**
   * Insert a strand into the control database using an owner signature.
   *
   * The owner signs the canonical row-bound authorization message (see
   * {@link buildAuthorizationMessage}) — NOT a bare stamp — so the signature is bound to
   * this strand's contents and cannot be transplanted onto an attacker-chosen row. The
   * StampId is persisted as a unique column for single-use anti-replay.
   *
   * @param strandId - Unique identifier for the strand
   * @param type - Strand type: 'o' for open, 'c' for closed
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the owner's private key, returning a base64url signature
   * @param memberPrivateKey - Optional private key for membership in closed strands
   */
  async insertStrand(
    strandId: string,
    type: 'o' | 'c',
    ownerKey: string,
    signMessage: (message: Uint8Array) => string,
    memberPrivateKey?: string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting strand: %s (type: %s)', strandId, type);

    // Generate a unique stamp ID using the peer ID for distributed uniqueness
    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's Strand `AuthorizedInsert` verify:
    // Id, Type, MemberPrivateKey ('' when null), StampId.
    const message = buildAuthorizationMessage('CadreControl.Strand', 'add', [strandId, type, memberPrivateKey ?? '', stampId]);
    const signature = signMessage(message);

    // StampId is a real, unique column (single-use anti-replay), no longer a context value.
    await this.db!.exec(`
      insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?)
    `, [ownerKey, signature, strandId, type, memberPrivateKey ?? null, stampId]);

    log('Strand inserted: %s', strandId);
  }

  /**
   * Delete a strand from the control database using an owner signature.
   *
   * Mirrors {@link insertStrand}'s row-bound approach for the delete half: the owner
   * signs the canonical `'remove'`-tagged authorization message over (Id, StampId) — the
   * schema's `Strand.AuthorizedDelete` verifies this DISTINCT digest, so the insert
   * approval (which never expires) can never be replayed as a removal. The delete and
   * the `Revocation` tombstone retiring the row's StampId commit in ONE transaction —
   * `Strand.RevocationRecorded` refuses a bare delete, and without the tombstone the
   * stamp would free up and the original formation approval could re-seat the strand.
   * Transaction shape mirrors {@link SeedBootstrapService.removePeer}.
   *
   * The remove digest binds only (Id, StampId) — not Type/MemberPrivateKey — so this
   * works identically for open and closed strands.
   *
   * A no-op (no throw, no tombstone) when the row does not exist.
   */
  deleteStrand(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    return this.deleteGuardedRow('Strand', 'Id', strandId, ownerKey, signMessage);
  }

  /**
   * Insert a validation key into the control database using an owner signature.
   *
   * Mirrors {@link insertStrand}: the owner signs the canonical row-bound
   * authorization message over (Key, StampId), and the StampId is persisted as a unique
   * column for single-use anti-replay. A `ValidationKey` authorizes verifying strand
   * formation disclosures.
   *
   * @param key - The validation public key to enroll
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - Function that ed25519-signs the raw message bytes (no pre-hash)
   *   with the owner's private key, returning a base64url signature
   */
  async insertValidationKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting validation key: %s', key);

    const peerId = this.config.libp2pNode.peerId.toString();
    const stampId = generateStampId(peerId);

    // Field order MUST match the schema's ValidationKey `AuthorizedInsert` verify: Key, StampId.
    const message = buildAuthorizationMessage('CadreControl.ValidationKey', 'add', [key, stampId]);
    const signature = signMessage(message);

    await this.db!.exec(`
      insert into CadreControl.ValidationKey (Key, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?)
    `, [ownerKey, signature, key, stampId]);

    log('Validation key inserted: %s', key);
  }

  /**
   * Delete a validation key from the control database using an owner signature.
   *
   * Mirrors {@link insertValidationKey}'s row-bound approach for the delete half: the
   * owner signs the canonical `'remove'`-tagged authorization message over (Key,
   * StampId) — the schema's `ValidationKey.AuthorizedDelete` verifies this DISTINCT
   * digest, so the enrollment approval (which never expires) can never be replayed as a
   * removal. The delete and the `Revocation` tombstone retiring the row's StampId commit
   * in ONE transaction — `ValidationKey.RevocationRecorded` refuses a bare delete, and
   * without the tombstone the stamp would free up and the original enrollment approval
   * could re-seat the key. Transaction shape mirrors {@link SeedBootstrapService.removePeer}.
   *
   * A no-op (no throw, no tombstone) when the row does not exist.
   */
  deleteValidationKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    return this.deleteGuardedRow('ValidationKey', 'Key', key, ownerKey, signMessage);
  }

  /**
   * Owner-signed delete of one guarded row plus the `Revocation` tombstone retiring its
   * stamp, in ONE transaction. Shared body of {@link deleteStrand} /
   * {@link deleteValidationKey}; see either for the security rationale.
   *
   * The row's CURRENT stamp is read first and signed over, so the remove digest binds to
   * this exact row instance. A no-op (no throw, no tombstone) when the row is absent.
   *
   * NOTE: the stamp read is outside the transaction. A concurrent writer that removes
   * the row in between makes the signature bind a stamp that is no longer live; the
   * delete then matches nothing and the tombstone insert collides with the other
   * writer's on `Revocation`'s (TableName, StampId) primary key, so the transaction
   * fails rather than silently half-applying. If concurrent owner-device removals ever
   * become routine, fold the stamp read into the transaction instead.
   *
   * `table` / `keyColumn` are interpolated into the SQL and typed as closed literal
   * unions — no caller-supplied string reaches the statement.
   */
  private async deleteGuardedRow(
    table: Extract<RevocableTable, 'Strand' | 'ValidationKey'>,
    keyColumn: GuardedKeyColumn,
    keyValue: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<void> {
    this.ensureInitialized();
    const stampId = await this.queryStampId(table, keyColumn, keyValue);
    if (stampId === null) {
      log('delete %s: no row for %s (already absent)', table, keyValue);
      return;
    }

    const message = buildAuthorizationMessage(`CadreControl.${table}`, 'remove', [keyValue, stampId]);
    const signature = signMessage(message);

    await this.inTransaction(`delete ${table}`, async () => {
      await this.db!.exec(`
        delete from CadreControl.${table}
          with context OwnerKey = ?, Signature = ?
          where ${keyColumn} = ?
      `, [ownerKey, signature, keyValue]);
      await this.db!.exec(`
        insert into CadreControl.Revocation (TableName, StampId)
          values (?, ?)
      `, [table, stampId]);
    });

    log('%s deleted: %s (stamp retired)', table, keyValue);
  }

  /**
   * Run `body` between `beginTransaction` and `commit`, rolling back on failure.
   *
   * A failed `commit()` has already torn the transaction down, so the `rollback()` in
   * the failure path would itself throw "No transaction active" and mask the real
   * cause — that secondary throw is logged and swallowed, and the original error always
   * propagates.
   *
   * @param label - What the transaction was doing, for the rollback log line.
   */
  private async inTransaction(label: string, body: () => Promise<void>): Promise<void> {
    await this.db!.beginTransaction();
    try {
      await body();
      await this.db!.commit();
    } catch (error) {
      try {
        await this.db!.rollback();
      } catch (rollbackError) {
        log('Rollback after %s failure was a no-op: %s', label, rollbackError);
      }
      throw error;
    }
  }

  /**
   * Insert an owner-signed `FormationInvite` (open invitation token).
   *
   * The invite is the on-network record that later authorizes an
   * owner-signature-FREE `Strand` creation: an invited cadre peer redeems it
   * by inserting a matching `FormationUsage` row (see {@link redeemInvitation}),
   * which satisfies the consent branch of `Strand.AuthorizedInsert`.
   *
   * Like {@link insertStrand}/{@link insertValidationKey}, the owner signs the
   * canonical row-bound authorization message (see {@link buildAuthorizationMessage})
   * over (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId) — NOT a
   * bare stamp — so the signature is bound to this invite's contents and cannot be
   * transplanted onto an attacker-chosen row. The StampId is persisted as a unique
   * column for single-use anti-replay. `FormationInvite.AuthorizedInsert` gates insert
   * over an `'add'`-tagged digest; deletes verify a DISTINCT `'remove'`-tagged digest
   * (`AuthorizedDelete`), so this insert approval can never be replayed as a revocation.
   *
   * `StrandId` binds the invite to a pre-existing host strand (provision-then-record):
   * when set, a responder redeeming this token records a `FormationUsage` against that
   * strand and returns it (see {@link ControlFormationUsageRecorder.resolveStrand}); a
   * null `StrandId` (the default) leaves the legacy responder-provisions path in place.
   * Like ValidationUrl it is a nullable bound field, signed as `''` when absent.
   *
   * The ExpiresAt and TotalUses message fields must byte-match what the (auto-deferred,
   * because it has a subquery) CHECK sees AFTER column coercion: TotalUses becomes a
   * decimal string (`String(totalUses)` ⇔ `cast(new.TotalUses as text)`) and ExpiresAt
   * becomes the engine's canonical `PlainDateTime` string — sourced here from
   * {@link canonicalDatetime} (a `select datetime(?)` round-trip) rather than a hand-rolled
   * ISO formatter, so signer and verifier agree exactly. A null ExpiresAt / TotalUses /
   * ValidationUrl signs as `''`, matching the schema's `coalesce(..., '')`.
   *
   * @param token - Invitation token (the `FormationInvite` primary key)
   * @param sAppId - The sApp a redeemed strand will use
   * @param ownerKey - Public key of the authorizing owner
   * @param signMessage - ed25519-signs the raw message bytes (no pre-hash),
   *   returning a base64url signature — the same callback shape {@link insertStrand} uses
   * @param options - Optional `expiresAtMs` (epoch ms), `totalUses`, `validationUrl`,
   *   `strandId` (bind to a pre-existing host strand for provision-then-record)
   */
  async insertFormationInvite(
    token: string,
    sAppId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string,
    options: { expiresAtMs?: number; totalUses?: number; validationUrl?: string; strandId?: string } = {}
  ): Promise<void> {
    this.ensureInitialized();
    log('Inserting formation invite: %s', token);

    const stampId = generateStampId(this.config.libp2pNode.peerId.toString());

    // Build each bound field exactly as the deferred CHECK sees it post-coercion:
    //   - ExpiresAt: engine-canonical datetime string (or '' when absent), sourced from
    //     the engine so it byte-matches the column's stored/coerced form.
    //   - TotalUses: decimal string via String(...) (⇔ cast(new.TotalUses as text)), '' when absent.
    //   - ValidationUrl: the url or '' when absent.
    //   - StrandId: the host strand id or '' when absent (text column, no coercion).
    const expiresAtCanonical = options.expiresAtMs == null
      ? null
      : await canonicalDatetime(this.db!, options.expiresAtMs);
    const expiresAtField = expiresAtCanonical ?? '';
    const totalUsesField = options.totalUses == null ? '' : String(options.totalUses);
    const validationUrlField = options.validationUrl ?? '';
    const strandIdField = options.strandId ?? '';

    // Field order MUST match the schema's FormationInvite `AuthorizedInsert` verify:
    // Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId.
    const message = buildAuthorizationMessage('CadreControl.FormationInvite', 'add', [
      token, sAppId, expiresAtField, totalUsesField, validationUrlField, strandIdField, stampId,
    ]);
    const signature = signMessage(message);

    // Persist the canonical ExpiresAt string (datetime parse is idempotent on it) so the
    // signed source-of-truth and the stored value are produced once. StampId is a real,
    // unique column (single-use anti-replay), no longer a context value.
    await this.db!.exec(`
      insert into CadreControl.FormationInvite (Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId)
        with context OwnerKey = ?, Signature = ?
        values (?, ?, ?, ?, ?, ?, ?)
    `, [
      ownerKey, signature,
      token, sAppId,
      expiresAtCanonical,
      options.totalUses ?? null,
      options.validationUrl ?? null,
      options.strandId ?? null,
      stampId,
    ]);

    log('Formation invite inserted: %s', token);
  }

  /**
   * Redeem a `FormationInvite` by inserting the `Strand` row and a matching
   * `FormationUsage` row **atomically, in one transaction**.
   *
   * The two CHECK constraints are mutually circular under immediate evaluation:
   * `Strand.AuthorizedInsert`'s consent branch requires a `FormationUsage` row naming
   * this strand's `(Id, StampId)`, while `FormationUsage.StrandExists` requires a
   * `Strand` row matching that same pair — the ONE freshly-minted `strandStampId` below
   * satisfies both, which is what binds the consent record to this specific strand ROW
   * (so a later owner-signed, tombstoned removal cannot be undone by re-inserting the
   * id with a fresh stamp). Both CHECKs contain
   * subqueries, so Quereus auto-defers them to transaction commit — wrapping both
   * inserts in a single explicit `begin … commit` lets both deferred CHECKs see
   * both rows at commit. The strand is authorised WITHOUT an owner signature
   * (the `FormationUsage` branch of `Strand.AuthorizedInsert`) but still gets a fresh,
   * unique `StampId` column to satisfy the not-null/unique anti-replay column.
   *
   * The seated strand is always open (`'o'`) and keyless — the consent branch of
   * `Strand.AuthorizedInsert` accepts nothing else, the invite must be UNBOUND
   * (`FormationInvite.StrandId` null; a bound invite's host strand is owner-provisioned
   * and only ever record-only, see {@link recordFormationUsage}), and a given strand id
   * may be consent-seated once, EVER: after an owner-signed removal, re-joining that id
   * takes an owner re-seat ({@link insertStrand}) plus a bound invite, never another
   * redemption.
   *
   * `UseNumber` is computed as `max(UseNumber)+1` for the token (the `Monotonic`
   * constraint); callers redeeming concurrently against the same token must
   * serialise, since the next use number is read before the insert.
   */
  async redeemInvitation(params: {
    token: string;
    strandId: string;
    disclosure?: string;
    peerId?: string;
    peerSignature?: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
  }): Promise<void> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerId, peerSignature,
      nowMs, validationKey, validationSignature,
    } = params;
    log('Redeeming invitation %s -> strand %s', token, strandId);

    const localPeerId = this.config.libp2pNode.peerId.toString();
    const strandStampId = generateStampId(localPeerId);
    const useNumber = await this.nextUseNumber(token);

    await this.inTransaction('redemption', async () => {
      // 1. Strand row — authorised by the FormationUsage branch (no owner sig),
      //    still carrying a fresh unique StampId for the anti-replay column.
      //    Hard-coded open + keyless: the consent branch admits no other shape.
      await this.db!.exec(`
        insert into CadreControl.Strand (Id, Type, MemberPrivateKey, StampId)
          with context OwnerKey = null, Signature = null
          values (?, 'o', null, ?)
      `, [strandId, strandStampId]);

      // 2. FormationUsage row — authorised by the matching FormationInvite, and
      //    carrying the strand's stamp so it authorizes THIS row and no other.
      await this.execFormationUsageInsert({
        token, useNumber, disclosure, strandId, strandStampId,
        peerId: peerId ?? localPeerId, peerSignature: peerSignature ?? null, nowMs: nowMs ?? Date.now(),
        validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
      });
    });

    log('Redeemed invitation %s -> strand %s (use #%d)', token, strandId, useNumber);
  }

  /**
   * Record a `FormationUsage` against an **already-existing** `Strand` (no strand
   * insert). This is the redemption path when the strand was provisioned
   * separately (e.g. owner-signed) and the consent record is added after the
   * fact: the single insert auto-commits, and the deferred `StrandExists` CHECK
   * is satisfied by the pre-existing committed strand row. Returns the assigned
   * `UseNumber`.
   *
   * Use {@link redeemInvitation} instead when the strand must be created by
   * consent atomically with the usage.
   *
   * The strand's live `StampId` is read first and written onto the usage row:
   * `FormationUsage.StrandExists` matches the (id, stamp) PAIR, and
   * `Strand.AuthorizedInsert`'s consent branch reads the same pair back, so a consent
   * record authorizes exactly the strand ROW it was recorded against. A missing strand
   * THROWS here rather than being left to the deferred `StrandExists` CHECK — the
   * ordinary "host strand has not converged yet" case is already reported as `missing`
   * by {@link ControlFormationUsageRecorder.resolveStrand}, so an absent row at this
   * point is a genuine race and deserves a named error, not a silent rollback.
   */
  async recordFormationUsage(params: {
    token: string;
    strandId: string;
    disclosure?: string;
    peerId?: string;
    peerSignature?: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
  }): Promise<number> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerId, peerSignature, nowMs, validationKey, validationSignature,
    } = params;

    const localPeerId = this.config.libp2pNode.peerId.toString();
    const strandStampId = await this.queryStrandStampId(strandId);
    if (strandStampId === null) {
      throw new MissingHostStrandError(strandId, token);
    }
    const useNumber = await this.nextUseNumber(token);

    await this.execFormationUsageInsert({
      token, useNumber, disclosure, strandId, strandStampId,
      peerId: peerId ?? localPeerId, peerSignature: peerSignature ?? null, nowMs: nowMs ?? Date.now(),
      validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
    });

    log('Recorded formation usage: token=%s strand=%s (use #%d)', token, strandId, useNumber);
    return useNumber;
  }

  /** Parameterised `FormationUsage` insert shared by redeem + record paths. */
  private async execFormationUsageInsert(opts: {
    token: string;
    useNumber: number;
    disclosure: string;
    strandId: string;
    /** The live `Strand.StampId` this consent record authorizes (`StrandExists` matches the pair). */
    strandStampId: string;
    peerId: string;
    peerSignature: string | null;
    nowMs: number;
    validationKey: string | null;
    validationSignature: string | null;
  }): Promise<void> {
    // Derive `context.Now` through the same `canonicalDatetime` transform that
    // produced the stored `ExpiresAt`, so the deferred CHECK's `FI.ExpiresAt >
    // context.Now` compares two byte-identical engine-`datetime` strings. The
    // previous `new Date(nowMs).toISOString()` form differed only by a trailing
    // `.000Z` (the engine `datetime()` separator is `T`, not a space), which never
    // flipped the strict `>` against a second-granular `ExpiresAt` — so this is a
    // robustness/consistency change, matching the strand layer's `consumeInvite`,
    // not a fix for an observable mis-ordering.
    const nowCanonical = await canonicalDatetime(this.db!, opts.nowMs);
    await this.db!.exec(`
      insert into CadreControl.FormationUsage (Token, UseNumber, Disclosure, StrandId, StrandStampId)
        with context PeerId = ?, PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?
        values (?, ?, ?, ?, ?)
    `, [
      opts.peerId, opts.peerSignature, nowCanonical,
      opts.validationKey, opts.validationSignature,
      opts.token, opts.useNumber, opts.disclosure, opts.strandId, opts.strandStampId,
    ]);
  }

  /**
   * Read a `FormationInvite` row by token, or null when absent. `expiresAtMs` is
   * the parsed epoch-ms of the stored `datetime` (null when the invite never
   * expires); the caller compares it against the wall clock for freshness.
   */
  async queryFormationInvite(token: string): Promise<{
    token: string;
    sAppId: string;
    expiresAtMs: number | null;
    totalUses: number | null;
    validationUrl: string | null;
    strandId: string | null;
  } | null> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId from CadreControl.FormationInvite where Token = ?',
      [token]
    )) {
      return {
        token: row.Token as string,
        sAppId: row.sAppId as string,
        expiresAtMs: parseNullableStoredDatetimeMs(row.ExpiresAt as string | number | null),
        totalUses: (row.TotalUses as number | null) ?? null,
        validationUrl: (row.ValidationUrl as string | null) ?? null,
        strandId: (row.StrandId as string | null) ?? null,
      };
    }
    return null;
  }

  /**
   * Count `FormationUsage` rows recorded against a token (uses consumed so far).
   */
  async countFormationUsage(token: string): Promise<number> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select count(1) as Count from CadreControl.FormationUsage where Token = ?',
      [token]
    )) {
      return (row.Count as number) ?? 0;
    }
    return 0;
  }

  /**
   * Is any `FormationInvite` row still redeemable — unexpired AND with usage
   * below its `TotalUses`? A null `ExpiresAt` never expires and a null
   * `TotalUses` is unlimited, matching {@link ControlFormationUsageRecorder}'s
   * per-token semantics (`isTokenValid` / `isTokenUsed`).
   *
   * Answers the control-network connection gate's coarse "does this node expect
   * a stranger?" question, which has no token to ask about. The expiry
   * comparison is `expiresAtMs <= now` — identical to `isTokenValid`'s — so an
   * invite the formation handler would reject can never hold the gate open.
   *
   * The scan is deliberately not pushed into SQL: nothing else here compares a
   * stored `datetime` with an inequality, so the parse stays in JS via the
   * shared {@link parseNullableStoredDatetimeMs}. Only invites that are
   * unexpired AND use-metered cost a {@link countFormationUsage} read, and an
   * unlimited-use invite anywhere in the scan short-circuits all of them.
   */
  async hasOutstandingFormationInvite(nowMs: number = Date.now()): Promise<boolean> {
    this.ensureInitialized();
    // NOTE: scans every FormationInvite row (expired ones included) on the
    // stranger path of an inbound connection. Cadre-scale invite counts make
    // that free today; if a long-lived cadre accumulates thousands of expired
    // invites and inbound upgrades slow down, add an expiry-ordered index or
    // prune redeemed/expired rows.
    const metered: Array<{ token: string; totalUses: number }> = [];
    let unlimitedOutstanding = false;
    for await (const row of this.db!.eval(
      'select Token, ExpiresAt, TotalUses from CadreControl.FormationInvite'
    )) {
      const expiresAtMs = parseNullableStoredDatetimeMs(row.ExpiresAt as string | number | null);
      if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        continue;
      }
      const totalUses = (row.TotalUses as number | null) ?? null;
      if (totalUses === null) {
        unlimitedOutstanding = true;
      } else {
        metered.push({ token: row.Token as string, totalUses });
      }
    }
    if (unlimitedOutstanding) {
      return true;
    }
    for (const invite of metered) {
      if (await this.countFormationUsage(invite.token) < invite.totalUses) {
        return true;
      }
    }
    return false;
  }

  /** Next `UseNumber` for a token = max(existing)+1, per the `Monotonic` constraint. */
  private async nextUseNumber(token: string): Promise<number> {
    for await (const row of this.db!.eval(
      'select coalesce(max(UseNumber), 0) as MaxUse from CadreControl.FormationUsage where Token = ?',
      [token]
    )) {
      return (row.MaxUse as number) + 1;
    }
    return 1;
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

