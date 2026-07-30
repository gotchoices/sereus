import debug from 'debug';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { Database, registerPlugin } from '@quereus/quereus';
import type { VTablePluginInfo, FunctionPluginInfo, SqlParameters } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import { digest, randomBytes } from '@optimystic/quereus-plugin-crypto';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { StrandRow, PeerAddressRecord, CadrePeerRow, DeviceTokenRecord, DeviceTokenRow, PushPlatform } from './types.js';
import { CONTROL_SCHEMA } from './control-schema.js';
import { canonicalDatetime } from './canonical-datetime.js';
import { controlAuthorizationFields, CONTROL_TABLES } from './control-authorization.js';
import type { ControlTable, RevocableTable, ControlDomain, ControlAction } from './control-authorization.js';

export type { ControlTable, RevocableTable, ControlDomain, ControlAction } from './control-authorization.js';

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
 * What a recorded `FormationUsage` row came out as.
 *
 * `usageStampId` is echoed back so a caller that obtained an approver sign-off can prove the
 * nonce it signed over is the one that landed — the two must match or
 * `FormationUsage.Authorized` rejects the row (see {@link formationVouchMessage}).
 */
export interface FormationUsageResult {
  /** The `UseNumber` assigned to this redemption (1-based per token). */
  useNumber: number;
  /** The single-use nonce written to `UsageStampId` — the caller's, or a freshly minted one. */
  usageStampId: string;
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
 * The exact bytes an outside approver signs to authorize ONE redemption of a
 * `ValidationUrl`-bearing `FormationInvite` — the TS mirror of the `'vouch'` digest in
 * `FormationUsage.Authorized`, in the schema's field order.
 *
 * The approval covers the whole redemption: the invitation (`token`), the single-use nonce
 * the redeeming node minted for THIS redemption (`usageStampId`), the network being joined
 * (`strandId`), the joining peer (`peerId`), and the disclosure text. That makes it
 * non-transferable — an approval cannot be re-presented for another use of the same
 * invitation, another network, or another joiner — and the nonce's `unique` column makes a
 * verbatim re-presentation a duplicate-row rejection. Mint the nonce first
 * ({@link generateStampId}), sign these bytes, then pass BOTH the same `usageStampId` and the
 * signature to {@link ControlDatabase.redeemInvitation} / {@link ControlDatabase.recordFormationUsage}:
 * signing one nonce and inserting another fails the CHECK.
 */
export function formationVouchMessage(fields: {
  token: string;
  usageStampId: string;
  strandId: string;
  peerId: string;
  disclosure: string;
}): Uint8Array {
  return buildAuthorizationMessage('CadreControl.FormationUsage', 'vouch', [
    fields.token, fields.usageStampId, fields.strandId, fields.peerId, fields.disclosure,
  ]);
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

/** Primary-key column of each {@link RevocableTable}. */
type GuardedKeyColumn = 'Key' | 'Id' | 'PeerId';

/**
 * Which column identifies one row of each guarded table — the ONLY place that mapping
 * lives, so a stamp read and the delete that binds to it can never disagree about it.
 * Derived rather than passed: every guarded table has exactly one primary key, so a
 * `(table, keyColumn)` pair on a signature is a mismatch waiting to happen.
 */
const GUARDED_KEY_COLUMN: Readonly<Record<RevocableTable, GuardedKeyColumn>> = {
  OwnerKey: 'Key',
  CadrePeer: 'PeerId',
  ValidationKey: 'Key',
  Strand: 'Id',
  DeviceToken: 'PeerId',
};

/**
 * Notified after a `CadreControl.CadrePeer` row write has COMMITTED.
 *
 * The one hook the party-membership snapshot a node admits control-DB traffic
 * against ({@link CadreNode.refreshMembershipGate}) hangs off, so that snapshot
 * is refreshed by the WRITE rather than by whoever remembered to ask. `reason`
 * only labels the log line. Must not reject (the notifier swallows and logs
 * anyway — a committed write never fails because a snapshot refresh did).
 */
export type MembershipChangeListener = (reason: string) => Promise<void>;

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
  private membershipListener: MembershipChangeListener | null = null;
  /** Tail of the local-write chain — see {@link withWriteLock}. */
  private writeQueue: Promise<unknown> = Promise.resolve();

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
   * Every approver public key currently enrolled in `CadreControl.ValidationKey` — the
   * set a `ValidationUrl` redemption's approval signature must be signed by (see
   * {@link ControlFormationUsageRecorder}, which checks one key at a time via
   * {@link queryValidationKeyStampId}).
   *
   * Sorted in TypeScript rather than SQL so the order is stable regardless of storage
   * order; the enrolled set is a handful of keys, so the sort is free.
   */
  async queryValidationKeys(): Promise<string[]> {
    this.ensureInitialized();
    const keys: string[] = [];
    for await (const row of this.db!.eval('select Key from CadreControl.ValidationKey')) {
      keys.push(row.Key as string);
    }
    return keys.sort();
  }

  /**
   * Read one guarded row's single-use `StampId` nonce (null when the row does not
   * exist). Every owner-signed delete / re-touch path must bind its signature to the
   * row's CURRENT nonce, so they all read through here first.
   *
   * `table` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
   * come from closed literal unions — no caller-supplied string can reach the statement
   * (same injection-surface discipline as {@link countRows}'s `CONTROL_TABLE_SET` guard).
   */
  private async queryStampId(
    table: RevocableTable,
    keyValue: string
  ): Promise<string | null> {
    this.ensureInitialized();
    const sql = `select StampId from CadreControl.${table} where ${GUARDED_KEY_COLUMN[table]} = ?`;
    for await (const row of this.db!.eval(sql, [keyValue])) {
      return (row.StampId as string | null) ?? null;
    }
    return null;
  }

  /**
   * `CadrePeer` stamp nonce — bound into {@link cadrePeerVoucherDigest} by the owner
   * re-touch path, and read by {@link SeedBootstrapService.removePeer} as its
   * row-present gate before it delegates to {@link deleteCadrePeer}.
   */
  queryCadrePeerStampId(peerId: string): Promise<string | null> {
    return this.queryStampId('CadrePeer', peerId);
  }

  /**
   * `DeviceToken` stamp nonce. {@link deleteDeviceToken} reads the stamp itself, so this
   * is the reader for callers that need to observe a live row's nonce — asserting a token
   * was seated, or that a removal retired the stamp it named.
   */
  queryDeviceTokenStampId(peerId: string): Promise<string | null> {
    return this.queryStampId('DeviceToken', peerId);
  }

  /** `Strand` stamp nonce — bound into {@link deleteStrand}'s remove digest. */
  queryStrandStampId(strandId: string): Promise<string | null> {
    return this.queryStampId('Strand', strandId);
  }

  /** `ValidationKey` stamp nonce — bound into {@link deleteValidationKey}'s remove digest. */
  queryValidationKeyStampId(key: string): Promise<string | null> {
    return this.queryStampId('ValidationKey', key);
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
   *
   * Deliberately NOT wrapped in {@link mutateCadrePeer}, the one `CadrePeer` mutator that
   * is not: it only ever touches THIS node's own row (sole caller
   * `CadreNode.publishSelfRecord`), and `CadreNode.listAuthorizedMembers` filters self out
   * of the membership snapshot, so it cannot change that snapshot. It also runs on the
   * periodic self-registration refresh, where a notify would add a recurring membership
   * read for nothing.
   *
   * Its INSERT counterpart (`SeedBootstrapService.insertSelfPeerRecord`) does notify. Not an
   * inconsistency: it shares the one owner-signed insert path with every other member's
   * row, and a self insert happens once at startup, so the wasted refresh is a single read
   * — cheaper than a conditional carve-out inside the shared writer. Only the repeating
   * path is worth exempting.
   */
  async updateSelfPeerRecord(record: PeerAddressRecord): Promise<void> {
    this.ensureInitialized();
    const multiaddr = record.addrs.join(',');
    await this.execWrite(`
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
   *
   * `stampId` rides along ({@link DeviceTokenRow}) because the resolver must drop a
   * row whose stamp is retired in `CadreControl.Revocation`; it is NOT part of
   * {@link DeviceTokenRecord}, which is the self-signed shape the peer's `Sig` covers.
   */
  async queryDeviceToken(peerId: string): Promise<DeviceTokenRow | null> {
    this.ensureInitialized();
    for await (const row of this.db!.eval(
      'select PeerId, Platform, Token, UpdatedAt, Sig, StampId from CadreControl.DeviceToken where PeerId = ?',
      [peerId]
    )) {
      return {
        peerId: row.PeerId as string,
        platform: (row.Platform as string ?? '') as PushPlatform,
        token: (row.Token as string | null) ?? '',
        updatedAt: (row.UpdatedAt as number | null) ?? 0,
        sig: (row.Sig as string | null) ?? '',
        stampId: (row.StampId as string | null) ?? '',
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
    await this.execWrite(`
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
    await this.execWrite(`
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
    await this.execWrite(`
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
   * Body shared with every other guarded delete via {@link deleteGuardedRow}.
   *
   * The remove digest binds only (Id, StampId) — not Type/MemberPrivateKey — so this
   * works identically for open and closed strands.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteStrand(
    strandId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.withWriteLock(() => this.deleteGuardedRow('Strand', strandId, ownerKey, signMessage));
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

    await this.execWrite(`
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
   * could re-seat the key. Body shared with every other guarded delete via
   * {@link deleteGuardedRow}.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteValidationKey(
    key: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.withWriteLock(() => this.deleteGuardedRow('ValidationKey', key, ownerKey, signMessage));
  }

  /**
   * Owner-signed removal of one `CadrePeer` membership row, notifying the membership
   * listener once it has committed.
   *
   * Mirrors {@link deleteStrand} for the membership table: the owner signs the DISTINCT
   * `'remove'`-tagged digest over (PeerId, StampId), so the row's stored `VouchSig` can
   * never be replayed to delete it, and the `Revocation` tombstone retiring the stamp
   * lands in the SAME transaction — `CadrePeer.RevocationRecorded` refuses a bare delete,
   * and without the tombstone the never-expiring admission approval (which the removed
   * peer holds a copy of) could re-seat the row.
   *
   * The {@link mutateCadrePeer} wrapper lives here rather than in the caller so no
   * `CadrePeer` remover can forget it. It notifies whenever the body resolves, including
   * the absent-row no-op below — a caller that must not notify for an already-absent peer
   * gates on {@link queryCadrePeerStampId} first (see
   * {@link SeedBootstrapService.removePeer}).
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteCadrePeer(
    peerId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.mutateCadrePeer('peer-remove', () =>
      this.deleteGuardedRow('CadrePeer', peerId, ownerKey, signMessage));
  }

  /**
   * Owner-signed removal of one peer's `DeviceToken` row (logout / token invalidation).
   *
   * Mirrors {@link deleteStrand}: the owner signs the DISTINCT `'remove'`-tagged digest
   * over (PeerId, StampId), so the insert approval can never be replayed to clear a token,
   * and the `Revocation` tombstone retiring the stamp lands in the SAME transaction —
   * `DeviceToken.RevocationRecorded` refuses a bare delete, and without the tombstone the
   * never-expiring insert approval (which the cleared device holds a copy of) could
   * re-seat the token.
   *
   * A no-op (no throw, no tombstone) when the row does not exist — `false` then, `true`
   * when a row was actually removed.
   */
  deleteDeviceToken(
    peerId: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    return this.withWriteLock(() => this.deleteGuardedRow('DeviceToken', peerId, ownerKey, signMessage));
  }

  /**
   * Owner-signed delete of one guarded row plus the `Revocation` tombstone retiring its
   * stamp, in ONE transaction. The single body behind EVERY guarded delete —
   * {@link deleteStrand}, {@link deleteValidationKey}, {@link deleteCadrePeer},
   * {@link deleteDeviceToken}; see any of them for the per-table security rationale. Each
   * of those is a thin named wrapper, so callers never pass a table name and this
   * generic shape stays off the public surface.
   *
   * `OwnerKey` is excluded from `table` only because no owner-key removal path exists in
   * production yet — the schema has the `'remove'` branch (`OwnerKey.Authorized`, which
   * requires a DIFFERENT owner as signer) and `control-revocation-replay.spec.ts` drives
   * it with hand-rolled SQL. Widen this and add a wrapper when that path lands; the body
   * needs no change.
   *
   * The row's CURRENT stamp is read first and signed over, so the remove digest binds to
   * this exact row instance. A no-op (no throw, no tombstone) when the row is absent —
   * reported as `false` so a caller can tell "removed" from "was never there" without a
   * second read (e.g. {@link CadreNode.unpublishStrand}'s committed-while-alone warning,
   * which must not fire for a no-op).
   *
   * NOTE: the stamp read is outside the transaction. A concurrent writer that removes
   * the row in between makes the signature bind a stamp that is no longer live; the
   * delete then matches nothing and the tombstone insert collides with the other
   * writer's on `Revocation`'s (TableName, StampId) primary key, so the transaction
   * fails rather than silently half-applying. If concurrent owner-device removals ever
   * become routine, fold the stamp read into the transaction instead.
   *
   * Deliberately NOT wrapped in {@link withWriteLock}: every public entry point already
   * holds the (non-re-entrant) lock, so taking it again here would self-deadlock.
   *
   * `table` and its {@link GUARDED_KEY_COLUMN} column are interpolated into the SQL; both
   * come from closed literal unions — no caller-supplied string reaches the statement.
   */
  private async deleteGuardedRow(
    table: Exclude<RevocableTable, 'OwnerKey'>,
    keyValue: string,
    ownerKey: string,
    signMessage: (message: Uint8Array) => string
  ): Promise<boolean> {
    this.ensureInitialized();
    const stampId = await this.queryStampId(table, keyValue);
    if (stampId === null) {
      log('delete %s: no row for %s (already absent)', table, keyValue);
      return false;
    }

    const message = buildAuthorizationMessage(`CadreControl.${table}`, 'remove', [keyValue, stampId]);
    const signature = signMessage(message);
    // The tombstone carries its OWN owner signature (`Revocation.Authorized`): retiring a
    // stamp is permanent and party-wide, so the delete's signature deliberately does not
    // cover it — the digests are domain-separated and neither replays as the other.
    const revocationSignature = signMessage(
      buildAuthorizationMessage('CadreControl.Revocation', 'remove', [table, keyValue, stampId]),
    );

    await this.inTransaction(`delete ${table}`, async () => {
      await this.db!.exec(`
        delete from CadreControl.${table}
          with context OwnerKey = ?, Signature = ?
          where ${GUARDED_KEY_COLUMN[table]} = ?
      `, [ownerKey, signature, keyValue]);
      await this.db!.exec(`
        insert into CadreControl.Revocation (TableName, RowKey, StampId)
          with context OwnerKey = ?, Signature = ?
          values (?, ?, ?)
      `, [ownerKey, revocationSignature, table, keyValue, stampId]);
    });

    log('%s deleted: %s (stamp retired)', table, keyValue);
    return true;
  }

  /**
   * Run `body` between `beginTransaction` and `commit`, rolling back on failure.
   *
   * A failed `commit()` has already torn the transaction down, so the `rollback()` in
   * the failure path would itself throw "No transaction active" and mask the real
   * cause — that secondary throw is logged and swallowed, and the original error always
   * propagates.
   *
   * It opens a transaction unconditionally (Quereus hard-throws on a nested
   * `beginTransaction`), so a caller already inside one must not call it. A `CadrePeer`
   * write nests this INSIDE {@link mutateCadrePeer}, never the reverse — see
   * {@link assertCommitBoundary}.
   *
   * Private: every multi-statement control write lives in this class (the owner-signed
   * delete/tombstone pairs all go through {@link deleteGuardedRow}), so needing to widen
   * this is a sign the writer that wants it belongs in here too.
   *
   * Deliberately NOT wrapped in {@link withWriteLock}: callers already hold the
   * (non-re-entrant) lock, so taking it again here would self-deadlock.
   *
   * @param label - What the transaction was doing, for the rollback log line.
   */
  private async inTransaction(label: string, body: () => Promise<void>): Promise<void> {
    this.ensureInitialized();
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
   * Wire (or clear, with null) the single listener notified after every committed
   * `CadreControl.CadrePeer` row write.
   *
   * At most one listener: a ControlDatabase instance belongs to exactly one
   * {@link CadreNode}, which wires this in `start()` and clears it on teardown. A
   * second call replaces the first rather than fanning out, so a stale node can
   * never keep receiving notifications for a database it no longer owns.
   */
  setMembershipChangeListener(listener: MembershipChangeListener | null): void {
    this.membershipListener = listener;
  }

  /**
   * Run a `CadrePeer` row mutation and notify the membership listener once it has
   * COMMITTED.
   *
   * EVERY `CadrePeer` writer goes through here, with one documented exception
   * ({@link updateSelfPeerRecord}, which cannot change the snapshot) — that is what makes
   * the party-membership snapshot refresh automatic rather than a caller obligation. A
   * writer necessarily holds the target node's ControlDatabase (the `SeedBootstrapService`'s
   * event callbacks are NOT a viable seam: the temp services `CadreNode.applySeed`/
   * `dialInvite` build, and services constructed outside `CadreNode` entirely, never get
   * callbacks wired), so this is the one point on the write path that cannot be bypassed.
   *
   * `body` owns its own transaction if it needs one and must COMMIT before returning, so
   * the notification never makes the listener read uncommitted state. A throwing `body`
   * propagates and does NOT notify: nothing changed.
   *
   * That contract is enforced, not merely documented — see {@link assertCommitBoundary}.
   *
   * Runs under {@link withWriteLock}, notification included: with the lock held through
   * the notify, no other local writer can have a transaction open while the listener
   * reads, so the listener always sees exactly the committed state it was told about.
   * The listener itself only READS (it re-materializes the membership snapshot) — a
   * listener that wrote through a locked method would deadlock.
   *
   * @param reason - Label for the log line only (e.g. `'peer-insert'`).
   */
  async mutateCadrePeer<T>(reason: string, body: () => Promise<T>): Promise<T> {
    this.ensureInitialized();
    return this.withWriteLock(async () => {
      this.assertCommitBoundary(reason, 'on entry to');
      const result = await body();
      this.assertCommitBoundary(reason, 'on return from');
      await this.notifyMembershipChanged(reason);
      return result;
    });
  }

  /**
   * Run one local write under the database-wide write lock, serializing it against
   * every other local writer on this ControlDatabase.
   *
   * Quereus tracks transaction state per `Database` (`getAutocommit()`), and a write
   * statement's implicit transaction stays open across the awaits inside `exec`. Two
   * local writers interleaving mid-statement therefore either trip
   * {@link assertCommitBoundary} (any `CadrePeer` path) or silently join each other's
   * open transaction — a torn commit if either side rolls back. This lock closes that
   * class: every public write method of this class runs its statement(s) under it, and
   * `SeedBootstrapService` wraps its direct `db.exec` writes in it too. The race is
   * real, not theoretical: the background self-record publish on a control connection
   * opening (`CadreNode.drainPendingControlReplication` → `registerSelf`) collided with
   * a foreground `authorizePeer` — both `CadrePeer` inserts — and tripped the boundary
   * assert.
   *
   * Reads are deliberately not locked: they take no transaction of their own, and
   * serializing them here would let a listener that reads during a notify (see
   * {@link mutateCadrePeer}) deadlock. The lock is NOT re-entrant — a locked writer's
   * body must never call another locked public method; the private bodies it composes
   * ({@link deleteGuardedRow}, {@link inTransaction}) stay bare for exactly that reason.
   *
   * NOTE: re-entry fails SILENTLY and PERMANENTLY. A locked body that calls another
   * locked public method (including a {@link mutateCadrePeer} body, which runs an
   * arbitrary caller-supplied callback) queues behind its own tail and never resolves —
   * no error, and it strands the whole write queue, not only that call. There is no
   * cheap fail-fast: a "held" flag cannot tell re-entry from a legitimately queued
   * concurrent writer. Compose bare private bodies instead.
   */
  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    // Chain behind the current tail regardless of how it settled, then park a
    // swallowed copy as the new tail so one failed write never poisons the queue.
    const run = this.writeQueue.then(fn, fn);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * One-statement local write, serialized by {@link withWriteLock}. Prefer this over a
   * bare `getDatabase().exec` so a new writer cannot forget the lock — the hazard
   * {@link assertCommitBoundary} can only catch after the fact.
   *
   * Public so `SeedBootstrapService`'s direct `CadrePeer`/`DeviceToken` SQL writes go
   * through the same seam. Must NOT be called from inside an already-locked body (the
   * lock is not re-entrant); such a caller uses a bare `getDatabase().exec` instead.
   */
  execWrite(sql: string, params?: SqlParameters): Promise<void> {
    this.ensureInitialized();
    return this.withWriteLock(() => this.db!.exec(sql, params));
  }

  /**
   * Throw unless the database sits at a committed boundary — `getAutocommit()` is false
   * exactly while a transaction is open.
   *
   * Both ends of a {@link mutateCadrePeer} body are checked, because either open
   * transaction would notify a listener that then reads PRE-commit state and materializes
   * a membership snapshot silently missing the write it was told about:
   *
   * - open on entry: the wrapper sits INSIDE an enclosing transaction and must be moved
   *   out to enclose that outer commit.
   * - open on return: the body opened a transaction and never committed it.
   *
   * Neither is reachable from today's callers, so this is a fail-fast guard on a future
   * mistake rather than a live code path.
   *
   * NOTE: `getAutocommit()` reports the whole `Database`, not this call. Local writers
   * serialize through {@link withWriteLock}, so with every writer locked this can only
   * trip on the two misuses above. A writer that bypasses the lock (a new method that
   * forgets it, or raw `getDatabase().exec` outside a locked wrapper) re-opens the
   * concurrent-writer window, and this assert is what catches it — it throws instead of
   * silently joining the other write's transaction.
   */
  private assertCommitBoundary(reason: string, where: string): void {
    if (this.db!.getAutocommit()) {
      return;
    }
    throw new Error(
      `mutateCadrePeer(${reason}): a transaction is open ${where} the mutation body — a ` +
      'CadrePeer write must commit before the membership listener runs; move the ' +
      'mutateCadrePeer wrapper out to enclose the commit'
    );
  }

  /**
   * Best-effort notify. A listener that throws is logged and swallowed: the write has
   * already committed, and it must never be reported as failed because a downstream
   * snapshot refresh did. A null listener (no `CadreNode` attached — e.g. the service
   * unit tests drive a bare control DB) is a silent no-op.
   */
  private async notifyMembershipChanged(reason: string): Promise<void> {
    if (!this.membershipListener) {
      return;
    }
    try {
      await this.membershipListener(reason);
    } catch (error) {
      log('Membership change listener failed (%s): %s', reason, error);
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
    await this.execWrite(`
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
   * Mint the single-use `UsageStampId` nonce for ONE redemption, from this database's own
   * libp2p peer id ({@link generateStampId}). Exists so a caller obtaining an approver
   * sign-off can mint the nonce BEFORE the hook is contacted — the approval is signed over
   * it (see {@link formationVouchMessage}) and the identical value must then be passed to
   * {@link redeemInvitation} / {@link recordFormationUsage} — without reaching for the peer
   * id itself. Callers that skip the approval flow simply omit `usageStampId` and those
   * methods mint their own.
   */
  mintUsageStampId(): string {
    this.ensureInitialized();
    return generateStampId(this.config.libp2pNode.peerId.toString());
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
   * serialise, since the next use number is read before the insert. A caller that already
   * holds an approver sign-off should retry a lost race with the SAME `usageStampId` — the
   * approval is bound to the nonce, not to the use number, so it survives the retry.
   */
  async redeemInvitation(params: {
    token: string;
    strandId: string;
    /** The joining peer. Required: it is inside the approver's signed digest (see {@link formationVouchMessage}). */
    peerId: string;
    disclosure?: string;
    /** Single-use nonce for this redemption; supply the one the approval was signed over. Minted fresh when absent. */
    usageStampId?: string;
    peerSignature?: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
  }): Promise<FormationUsageResult> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerId, peerSignature, usageStampId,
      nowMs, validationKey, validationSignature,
    } = params;
    log('Redeeming invitation %s -> strand %s', token, strandId);

    const localPeerId = this.config.libp2pNode.peerId.toString();
    const strandStampId = generateStampId(localPeerId);
    const stampId = usageStampId ?? generateStampId(localPeerId);
    const useNumber = await this.nextUseNumber(token);

    await this.withWriteLock(() => this.inTransaction('redemption', async () => {
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
        token, useNumber, usageStampId: stampId, disclosure, strandId, strandStampId,
        peerId, peerSignature: peerSignature ?? null, nowMs: nowMs ?? Date.now(),
        validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
      });
    }));

    log('Redeemed invitation %s -> strand %s (use #%d)', token, strandId, useNumber);
    return { useNumber, usageStampId: stampId };
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
    /** The joining peer. Required: it is inside the approver's signed digest (see {@link formationVouchMessage}). */
    peerId: string;
    disclosure?: string;
    /** Single-use nonce for this redemption; supply the one the approval was signed over. Minted fresh when absent. */
    usageStampId?: string;
    peerSignature?: string;
    nowMs?: number;
    validationKey?: string;
    validationSignature?: string;
  }): Promise<FormationUsageResult> {
    this.ensureInitialized();
    const {
      token, strandId, disclosure = '',
      peerId, peerSignature, usageStampId, nowMs, validationKey, validationSignature,
    } = params;

    const localPeerId = this.config.libp2pNode.peerId.toString();
    const stampId = usageStampId ?? generateStampId(localPeerId);
    const strandStampId = await this.queryStrandStampId(strandId);
    if (strandStampId === null) {
      throw new MissingHostStrandError(strandId, token);
    }
    const useNumber = await this.nextUseNumber(token);

    await this.withWriteLock(() => this.execFormationUsageInsert({
      token, useNumber, usageStampId: stampId, disclosure, strandId, strandStampId,
      peerId, peerSignature: peerSignature ?? null, nowMs: nowMs ?? Date.now(),
      validationKey: validationKey ?? null, validationSignature: validationSignature ?? null,
    }));

    log('Recorded formation usage: token=%s strand=%s (use #%d)', token, strandId, useNumber);
    return { useNumber, usageStampId: stampId };
  }

  /** Parameterised `FormationUsage` insert shared by redeem + record paths. */
  private async execFormationUsageInsert(opts: {
    token: string;
    useNumber: number;
    /** Single-use nonce bound into the approver's signed digest; `unique`, so one approval spends once. */
    usageStampId: string;
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
      insert into CadreControl.FormationUsage (Token, UseNumber, UsageStampId, PeerId, Disclosure, StrandId, StrandStampId)
        with context PeerSignature = ?, Now = ?, ValidationKey = ?, ValidationSignature = ?
        values (?, ?, ?, ?, ?, ?, ?)
    `, [
      opts.peerSignature, nowCanonical,
      opts.validationKey, opts.validationSignature,
      opts.token, opts.useNumber, opts.usageStampId, opts.peerId,
      opts.disclosure, opts.strandId, opts.strandStampId,
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
   * Close the database and cleanup resources.
   *
   * Drains the local-write chain first: {@link withWriteLock} can park a write behind
   * others across an await, and a queued closure evaluates `this.db!` only when it
   * finally runs — so nulling the handle out from under it would throw a TypeError on a
   * null handle instead of committing. The tail never rejects (it swallows both
   * outcomes), so the bare await is safe.
   *
   * NOTE: this makes `close()` wait on a stuck write. Acceptable today — every locked
   * body is a bounded local `exec` — but revisit (bounded drain, or abandon after a
   * deadline) if a write can ever hang.
   */
  async close(): Promise<void> {
    await this.writeQueue;
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

