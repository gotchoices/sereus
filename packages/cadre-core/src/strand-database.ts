import debug from 'debug';
import { Database } from '@quereus/quereus';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import type { SereusPluginResult } from '@serfab/quereus-plugin-sereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { IRawStorage } from '@optimystic/db-p2p';
import type { SAppConfig, StrandMode } from './types.js';
import { bootstrapFounderMembership } from './strand-membership-writer.js';
import { strandMemberKeyPair } from './strand-member-key.js';

const log = debug('sereus:cadre:strand-db');
const timing = debug('sereus:cadre:timing');

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
  /**
   * Strand type (`'o'` open / `'c'` closed) from the control-network strand row.
   * Drives the founder bootstrap: open strands get a `Header` only; closed strands
   * also get the founding `Member`+`Manager`.
   */
  strandType: 'o' | 'c';
  /**
   * The closed-strand `MemberPrivateKey` (base64 protobuf) from the strand row.
   * Required when `founder` is true and `strandType` is `'c'` — it derives the
   * founding `Member.Key`/`Manager.MemberKey`. Absent for open strands.
   */
  memberPrivateKey?: string;
  /**
   * Whether this node founds the strand. When true, {@link initialize} runs the
   * one-time founder membership bootstrap after the schema is applied. Joiners
   * leave this false and write nothing (rows arrive via sync). Defaults to false.
   */
  founder?: boolean;
}

/**
 * StrandDatabase manages the sApp schema for a strand using Quereus with the
 * Optimystic backend. Each strand instance has its own isolated database with
 * the sApp's schema applied.
 *
 * This class owns the `Database` lifecycle (creation, `getDatabase()`, `close()`)
 * but delegates the actual SQL-surface composition — plugin registration, node
 * wiring, catalog hydration, schema apply — to `connectToStrand` from
 * `@serfab/quereus-plugin-sereus`, the single shared composition. The libp2p
 * node is injected here, so `connectToStrand` never *creates* the node;
 * `StrandInstanceManager` owns the node lifecycle. (The strand connection's
 * `shutdown` still stops the injected node via the collection factory, so the
 * manager's own `node.stop()` is an idempotent second stop — see `close()`.)
 */
export class StrandDatabase {
  private db: Database | null = null;
  private shutdownStrand: SereusPluginResult['shutdown'] | null = null;
  private readonly config: StrandDatabaseConfig;
  private initialized = false;

  constructor(config: StrandDatabaseConfig) {
    this.config = config;
  }

  /**
   * Initialize the database — create the `Database` and delegate the strand
   * SQL-surface composition (plugins, node wiring, hydrate, schema apply) to
   * `connectToStrand` with the injected libp2p node.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      log('StrandDatabase for strand %s already initialized', this.config.strandId);
      return;
    }

    const sid = this.config.strandId;
    const mode: StrandMode = this.config.mode ?? 'networked';
    log('Initializing StrandDatabase for strand: %s (sApp: %s v%s, mode=%s)',
      sid, this.config.sAppConfig.id, this.config.sAppConfig.version, mode);

    this.db = new Database();

    // Delegate to the shared composition. The node is injected, so:
    //  - `connectToStrand` never creates a node (its `createdNode` stays null);
    //    `StrandInstanceManager` owns the node lifecycle. Its `shutdown` does
    //    still stop the injected node via the collection factory, so the
    //    manager's later `node.stop()` is an idempotent second stop;
    //  - `storage` (the strand's raw storage, same instance the node uses) is
    //    handed to the plugin's local transactor in bootstrap mode so DML lands
    //    on the host backend rather than in-memory.
    const t0 = performance.now();
    const result = await connectToStrand(this.db, {
      strandId: sid,
      schema: this.config.sAppConfig.schema,
      mode,
      storage: this.config.rawStorage,
      libp2pNode: this.config.libp2pNode,
      coordinatedRepo: this.config.coordinatedRepo,
      enableCache: true,
    });
    this.shutdownStrand = result.shutdown;
    timing('[strandDb:%s] connectToStrand: %dms (hydrated tables=%d, indexes=%d)',
      sid, Math.round(performance.now() - t0),
      result.hydrated?.tables ?? 0, result.hydrated?.indexes ?? 0);

    // Founder-only: write the one-time membership bootstrap now that the schema is
    // applied (connectToStrand has returned). A throw here propagates out of
    // initialize() so buildStrandRuntime's rollback tears the half-built strand
    // down rather than leaking a node. Joiners skip this — their rows arrive via sync.
    if (this.config.founder === true) {
      await this.bootstrapFounder();
    }

    this.initialized = true;
    log('StrandDatabase for strand %s initialized successfully', sid);
  }

  /**
   * Run the founder membership bootstrap against the freshly-composed strand DB.
   *
   * Derives the founding keypair from the closed-strand `memberPrivateKey` (the
   * `Member.Key`/`Manager.MemberKey` are its public key); a closed strand with no
   * `memberPrivateKey` throws, because it could never seat a founding manager.
   * Open strands derive no keypair (Header only). Idempotent — see
   * {@link bootstrapFounderMembership}.
   */
  private async bootstrapFounder(): Promise<void> {
    const { strandId, strandType, memberPrivateKey, sAppConfig } = this.config;
    const founderKeyPair = strandType === 'c'
      ? this.deriveFounderKeyPair(strandId, memberPrivateKey)
      : undefined;
    await bootstrapFounderMembership(this.db!, {
      strandId,
      type: strandType,
      sApp: sAppConfig,
      founderKeyPair,
    });
  }

  /**
   * Derive the founding keypair for a closed strand from its `memberPrivateKey`,
   * failing loudly when the key is absent (a closed strand with no founding
   * Manager can never admit anyone).
   */
  private deriveFounderKeyPair(strandId: string, memberPrivateKey: string | undefined) {
    if (!memberPrivateKey) {
      throw new Error(
        `Cannot found closed strand ${strandId}: the strand row has no MemberPrivateKey. ` +
        'A closed strand needs a founding Member/Manager derived from that key.',
      );
    }
    return strandMemberKeyPair(memberPrivateKey);
  }

  /**
   * Get the underlying database for queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * Close the database and cleanup resources. Runs the strand-connection
   * shutdown (collection-factory teardown, which also stops the injected node),
   * then closes the `Database`. `StrandInstanceManager.releaseRuntime` issues a
   * further idempotent `node.stop()` after this returns.
   */
  async close(): Promise<void> {
    if (this.shutdownStrand) {
      await this.shutdownStrand();
      this.shutdownStrand = null;
    }
    if (this.db) {
      void this.db.close();
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
