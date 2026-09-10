import debug from 'debug';
import { Database } from '@quereus/quereus';
import { connectToStrand } from '@serfab/quereus-plugin-sereus';
import type { SereusPluginResult } from '@serfab/quereus-plugin-sereus';
import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { SAppConfig } from './types.js';
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
   * Strand type (`'o'` open / `'c'` closed) from the control-network strand row.
   * Drives the founder bootstrap: open strands get a `Header` only; closed strands
   * also get the founding `Member`+`Manager`.
   */
  strandType: 'o' | 'c';
  /**
   * The closed-strand `MemberPrivateKey` (base64 protobuf) from the strand row —
   * the strand-wide read secret every joining party receives. Carried for the
   * strand's read-gating story only; it derives NOBODY's identity (that used to be
   * this key's second job, which let any joiner sign as the founding manager —
   * gotchoices/sereus#4). Absent for open strands.
   */
  memberPrivateKey?: string;
  /**
   * THIS party's own strand membership private key (base64 protobuf), from the
   * control-layer `StrandPartyKey` row (or supplied explicitly at attach). Required
   * when `founder` is true and `strandType` is `'c'` — it derives the founding
   * `Member.Key`/`Manager.MemberKey`. Never shared outside the party; absent for
   * open strands and for joiners that have not yet persisted one.
   */
  partyMemberPrivateKey?: string;
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
  private resolvedTransactor: SereusPluginResult['transactor'] | null = null;
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
    log('Initializing StrandDatabase for strand: %s (sApp: %s v%s)',
      sid, this.config.sAppConfig.id, this.config.sAppConfig.version);

    this.db = new Database();

    // Delegate to the shared composition. The node is injected, so:
    //  - `connectToStrand` never creates a node (its `createdNode` stays null);
    //    `StrandInstanceManager` owns the node lifecycle. Its `shutdown` does
    //    still stop the injected node via the collection factory, so the
    //    manager's later `node.stop()` is an idempotent second stop;
    //  - no `storage` is passed: the plugin consumes it only to build a local
    //    transactor's raw-storage factory or to create a node it was not given,
    //    and cadre-core always injects the node and runs the network transactor.
    //    (The plugin keeps its `storage` option for the browser entry point.)
    const t0 = performance.now();
    const result = await connectToStrand(this.db, {
      strandId: sid,
      schema: this.config.sAppConfig.schema,
      libp2pNode: this.config.libp2pNode,
      coordinatedRepo: this.config.coordinatedRepo,
      enableCache: true,
    });
    this.shutdownStrand = result.shutdown;
    this.resolvedTransactor = result.transactor;
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
   * Derives the founding keypair from this PARTY's own `partyMemberPrivateKey` (the
   * `Member.Key`/`Manager.MemberKey` are its public key) — deliberately NOT from the
   * strand row's shared `MemberPrivateKey`, which every joining party receives and could
   * therefore use to forge the founder's identity. A closed strand with no
   * `partyMemberPrivateKey` throws, because it could never seat a founding manager.
   * The shared key's public half IS passed, but only so the bootstrap can refuse a strand
   * founded under it before the split (`PreSplitStrandIdentityError`). Open strands derive
   * no keypair (Header only). Idempotent — see {@link bootstrapFounderMembership}.
   */
  private async bootstrapFounder(): Promise<void> {
    const { strandId, strandType, memberPrivateKey, partyMemberPrivateKey, sAppConfig } = this.config;
    const closed = strandType === 'c';
    await bootstrapFounderMembership(this.db!, {
      strandId,
      type: strandType,
      sApp: sAppConfig,
      founderKeyPair: closed ? this.deriveFounderKeyPair(strandId, partyMemberPrivateKey) : undefined,
      sharedMemberPublicKey: closed && memberPrivateKey
        ? strandMemberKeyPair(memberPrivateKey).publicKeyB64
        : undefined,
    });
  }

  /**
   * Derive the founding keypair for a closed strand from the party's own
   * `partyMemberPrivateKey`, failing loudly when the key is absent (a closed strand
   * with no founding Manager can never admit anyone).
   */
  private deriveFounderKeyPair(strandId: string, partyMemberPrivateKey: string | undefined) {
    if (!partyMemberPrivateKey) {
      throw new Error(
        `Cannot found closed strand ${strandId}: this party has no StrandPartyKey for it. ` +
        'A closed strand needs a founding Member/Manager derived from the party\'s own ' +
        'membership key (minted at publishStrand, or at the founder launch that follows a ' +
        'publish interrupted before its mint) — the shared MemberPrivateKey deliberately ' +
        'no longer derives anyone\'s identity.',
      );
    }
    return strandMemberKeyPair(partyMemberPrivateKey);
  }

  /**
   * Run the founder membership bootstrap against an ALREADY-LIVE database — the
   * seam {@link StrandInstanceManager.foundExistingStrand} uses when a founder
   * request arrives for an instance that was first launched as a joiner.
   * Idempotent: every bootstrap write is insert-if-absent
   * ({@link bootstrapFounderMembership}), so calling it on an instance that
   * already founded writes nothing. On success also flips the captured config's
   * `founder`, so this object's own record of how it was launched stays coherent
   * with what actually ran (a construction-time `founder: false` is a statement
   * about the launch, not a permanent identity); a refused bootstrap leaves it a joiner.
   *
   * @param partyMemberPrivateKey - The party's own membership key, for a closed strand
   *   whose original (joiner) launch resolved none — e.g. the `StrandPartyKey` row had
   *   not been written or replicated yet. The captured config's key wins when both
   *   exist: it is the identity this instance launched under.
   */
  async ensureFounderBootstrap(partyMemberPrivateKey?: string): Promise<void> {
    this.ensureInitialized();
    this.config.partyMemberPrivateKey ??= partyMemberPrivateKey;
    await this.bootstrapFounder();
    this.config.founder = true;
  }

  /**
   * Get the underlying database for queries
   */
  getDatabase(): Database {
    this.ensureInitialized();
    return this.db!;
  }

  /**
   * The Optimystic transactor this strand's connection resolved to — always
   * `'network'` here, since cadre-core passes no `transactor` option and takes
   * the plugin's default. Exposed so a spec measuring or asserting the network
   * path (`strand-solo-write-budget.spec.ts`) can pin the engine it ran on
   * rather than assume it.
   */
  getTransactor(): SereusPluginResult['transactor'] {
    this.ensureInitialized();
    return this.resolvedTransactor!;
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
    this.resolvedTransactor = null;
    this.initialized = false;
    log('StrandDatabase for strand %s closed', this.config.strandId);
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.db) {
      throw new Error(`StrandDatabase for strand ${this.config.strandId} not initialized. Call initialize() first.`);
    }
  }
}
