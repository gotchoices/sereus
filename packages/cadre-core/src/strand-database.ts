import debug from 'debug';
import { Database, registerPlugin } from '@quereus/quereus';
import cryptoPlugin from '@optimystic/quereus-plugin-crypto/plugin';
import optimysticPlugin from '@optimystic/quereus-plugin-optimystic/plugin';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { SAppConfig, StrandMode } from './types.js';

const log = debug('sereus:cadre:strand-db');
const timing = debug('sereus:cadre:timing');

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
  hydrate: (db: Database) => Promise<{ tables: number; indexes: number }>;
  [key: string]: unknown;
}

export interface StrandDatabaseConfig {
  /** The strand ID */
  strandId: string;
  /** sApp configuration containing the schema */
  sAppConfig: SAppConfig;
  /** Libp2p node for the strand network */
  libp2pNode: Libp2p;
  /** Coordinated repo from the libp2p node */
  coordinatedRepo: IRepo;
  /**
   * Lifecycle mode. `'bootstrap'` selects a purely local transactor so the strand
   * can initialize (e.g. apply schema DDL) without network round trips on a solo
   * node. `'networked'` (the default) uses the network transactor.
   */
  mode?: StrandMode;
  /**
   * Raw storage backing the strand. When mode is `'bootstrap'` this is also used
   * by the optimystic plugin's local transactor so DML lands on the host's
   * persistent storage instead of in-memory. Must be the same instance the
   * libp2p node was created with — sharing the instance avoids cache divergence
   * across the two consumers.
   */
  rawStorage?: IRawStorage;
}

/**
 * StrandDatabase manages the sApp schema for a strand using Quereus with Optimystic backend.
 * Each strand instance has its own isolated database with the sApp's schema applied.
 */
export class StrandDatabase {
  private db: Database | null = null;
  private collectionFactory: CollectionFactory | null = null;
  private readonly config: StrandDatabaseConfig;
  private initialized = false;

  constructor(config: StrandDatabaseConfig) {
    this.config = config;
  }

  /**
   * Initialize the database - register plugins and execute sApp schema
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log('StrandDatabase for strand %s already initialized', this.config.strandId);
      return;
    }

    log('Initializing StrandDatabase for strand: %s (sApp: %s v%s)',
      this.config.strandId,
      this.config.sAppConfig.id,
      this.config.sAppConfig.version
    );

    // Create database instance
    this.db = new Database();
    const sid = this.config.strandId;

    // Register crypto plugin (provides digest, sign, verify functions)
    let t0 = performance.now();
    await registerPlugin(this.db, cryptoPlugin);
    timing('[strandDb:%s] cryptoPlugin: %dms', sid, Math.round(performance.now() - t0));
    log('Registered crypto plugin');

    // Register optimystic plugin. In `bootstrap` mode we route through the
    // local transactor so a solo node can initialize (schema apply etc.)
    // without network round trips. In `networked` mode the network transactor
    // is used. The mode is supplied by the caller; CadreNode auto-selects it
    // from CadrePeer cohort membership when not given explicitly. Mode is fixed
    // for the lifetime of this Database instance; the caller must restart the
    // strand to transition modes.
    t0 = performance.now();
    const networkName = `strand-${sid}`;
    const mode: StrandMode = this.config.mode ?? 'networked';
    const defaultTransactor = mode === 'bootstrap' ? 'local' : 'network';
    // In bootstrap mode the local transactor IS the data path. Hand the plugin
    // the strand's raw storage (same instance the libp2p node uses) so writes
    // persist to the host backend instead of in-memory storage.
    const rawStorage = this.config.rawStorage;
    const pluginConfig: Record<string, unknown> = {
      default_transactor: defaultTransactor,
      default_key_network: 'libp2p',
      default_network_name: networkName,
      enable_cache: true,
    };
    if (mode === 'bootstrap' && rawStorage) {
      pluginConfig.rawStorageFactory = () => rawStorage;
    }
    // The plugin's published signature is `Record<string, SqlValue>` but it
    // also reads `rawStorageFactory` (a function reference) from the same map.
    // Cast through unknown rather than widen the public type.
    const pluginResult = optimysticPlugin(
      this.db,
      pluginConfig as unknown as Parameters<typeof optimysticPlugin>[1]
    ) as OptimysticPluginResult;
    log('Optimystic plugin registered for strand %s (mode=%s, transactor=%s, persistentStorage=%s)',
      sid, mode, defaultTransactor, mode === 'bootstrap' && !!rawStorage);

    // Register vtables and functions manually since we need access to collectionFactory
    for (const vtable of pluginResult.vtables as Array<{ name: string; module: unknown; auxData: unknown }>) {
      this.db.registerModule(vtable.name, vtable.module as any, vtable.auxData);
    }
    for (const func of pluginResult.functions as Array<{ schema: unknown }>) {
      this.db.registerFunction(func.schema as any);
    }
    timing('[strandDb:%s] optimysticPlugin: %dms', sid, Math.round(performance.now() - t0));

    this.collectionFactory = pluginResult.collectionFactory;

    // Inject the libp2p node into the collection factory
    t0 = performance.now();
    this.collectionFactory.registerLibp2pNode(
      networkName,
      this.config.libp2pNode,
      this.config.coordinatedRepo
    );
    timing('[strandDb:%s] registerLibp2pNode: %dms', sid, Math.round(performance.now() - t0));
    log('Registered libp2p node with collection factory');

    // Set optimystic as the default virtual table module so that
    // `declare schema` tables (which omit USING) are backed by optimystic
    // instead of the built-in memory module.
    t0 = performance.now();
    this.db.setDefaultVtabName('optimystic');
    this.db.setDefaultVtabArgs({
      networkName,
      transactor: defaultTransactor,
      keyNetwork: 'libp2p',
    });
    timing('[strandDb:%s] setDefaultVtab: %dms', sid, Math.round(performance.now() - t0));
    log('Set default vtab to optimystic (networkName=%s, transactor=%s)', networkName, defaultTransactor);

    // Hydrate Quereus's catalog from any persisted optimystic vtab schemas
    // before running `apply schema App;`. Without this, a warm restart diffs
    // the wrapped DDL against an empty catalog and re-emits CREATE TABLE /
    // CREATE INDEX for every persisted object — which round-trips through
    // optimystic storage and is the cause of the ~160s warm-start regression
    // tracked in strand-database-must-hydrate-catalog-before-apply-schema.
    // No-op on first launch (empty storage).
    t0 = performance.now();
    const hydrated = await pluginResult.hydrate(this.db);
    timing('[strandDb:%s] hydrate: %dms (tables=%d, indexes=%d)',
      sid, Math.round(performance.now() - t0), hydrated.tables, hydrated.indexes);
    log('Hydrated catalog for strand %s (tables=%d, indexes=%d)',
      sid, hydrated.tables, hydrated.indexes);

    // Execute the sApp schema DDL
    t0 = performance.now();
    await this.executeSchema();
    timing('[strandDb:%s] executeSchema: %dms', sid, Math.round(performance.now() - t0));

    this.initialized = true;
    log('StrandDatabase for strand %s initialized successfully', sid);
  }

  private async executeSchema(): Promise<void> {
    const rawSchema = this.config.sAppConfig.schema;
    log('Applying sApp schema for strand %s', this.config.strandId);

    // Wrap the raw schema DDL in a declarative schema block and apply it.
    // This ensures proper schema management with diff/apply semantics.
    // The schema is applied to a named schema 'App' to keep it isolated.
    const wrappedSchema = `
      declare schema App {
        ${rawSchema}
      }
      apply schema App;
    `;

    await this.db!.exec(wrappedSchema);
    log('sApp schema applied to strand %s', this.config.strandId);
  }

  /**
   * Get the underlying database for queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
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
    log('StrandDatabase for strand %s closed', this.config.strandId);
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error(`StrandDatabase for strand ${this.config.strandId} not initialized. Call initialize() first.`);
    }
  }
}

