/**
 * TestCadreNetwork - orchestrator for multi-party integration tests.
 *
 * Manages multiple parties, their cadres, strand creation, invitations,
 * and provides utilities for waiting on convergence and executing queries.
 */

import debug from 'debug';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode, ed25519KeyPairFromLibp2p, signSchema } from '@serfab/cadre-core';
import type { CadreNodeConfig, ControlDatabase, ControlTable, SAppConfig } from '@serfab/cadre-core';
import { createTestParty, shutdownTestParty } from './test-party.js';
import { releaseAllPorts } from './port-allocator.js';
import { waitForCount, waitUntil, type WaitOptions } from './wait-utils.js';
import type {
  TestParty,
  TestStrand,
  TestOpenInvitation,
  CreatePartyOptions,
  CreateStrandOptions
} from './types.js';

/**
 * Ed25519-sign the canonical authorization message bytes and return a base64url signature.
 *
 * The control schema's authorization constraints bind the signature to a domain-tagged
 * field vector — ('CadreControl.<Table>', <action>, row fields...) built by
 * `buildAuthorizationMessage` in cadre-core — so an approval verifies only against the
 * one rule it was minted for. The signer receives the raw message bytes and signs them
 * DIRECTLY — no SHA-256 pre-hash and no re-encode, since ed25519 hashes internally and
 * the bytes are already canonical.
 *
 * Exported so scenarios that insert their own owner-signed control rows
 * (e.g. bespoke `FormationInvite`s) sign through the SAME proven path the harness
 * uses for {@link TestCadreNetwork.createOpenInvitation}, rather than re-deriving it.
 */
export function signMessageEd25519(message: Uint8Array, privateKey: Uint8Array): string {
  // Ed25519 private key from libp2p is in protobuf format, extract the raw 32-byte seed.
  // The protobuf format is: type (1 byte) + length (1 byte) + key data (32 bytes) + public key...
  const rawPrivateKey = privateKey.slice(4, 36); // Skip protobuf header
  const signature = ed25519.sign(message, rawPrivateKey);
  // Use uint8ArrayToString to get raw base64url without multiformat prefix
  return uint8ArrayToString(signature, 'base64url');
}

const log = debug('sereus:integration:network');

/**
 * Options for TestCadreNetwork
 */
export interface TestNetworkOptions {
  /** Default timeout for wait operations (ms) */
  defaultTimeoutMs?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Main orchestrator for integration tests.
 * Creates parties, manages strands, and provides query utilities.
 */
export class TestCadreNetwork {
  private readonly parties = new Map<string, TestParty>();
  private readonly strands = new Map<string, TestStrand>();
  private readonly options: Required<TestNetworkOptions>;
  private isShutdown = false;

  constructor(options: TestNetworkOptions = {}) {
    this.options = {
      defaultTimeoutMs: options.defaultTimeoutMs ?? 10_000,
      verbose: options.verbose ?? false
    };
    log('TestCadreNetwork created');
  }

  /**
   * Create a new party with its cadre
   */
  async createParty(options: CreatePartyOptions | string): Promise<TestParty> {
    const opts = typeof options === 'string' ? { name: options } : options;
    
    log('Creating party: %s', opts.name);
    const party = await createTestParty(opts);
    this.parties.set(party.partyId, party);
    
    log('Party created: %s (partyId: %s)', party.name, party.partyId);
    return party;
  }

  /**
   * Get a party by name
   */
  getPartyByName(name: string): TestParty | undefined {
    for (const party of this.parties.values()) {
      if (party.name === name) return party;
    }
    return undefined;
  }

  /**
   * Create a strand in a party's control network
   */
  async createStrand(party: TestParty, options: CreateStrandOptions): Promise<TestStrand> {
    const strandId = `strand-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sAppId = options.sAppId ?? party.ownerPublicKey;
    const strandType = options.type ?? 'o';

    log('Creating strand %s for party %s', strandId, party.name);

    // Insert strand into the party's control database.
    // The callback signs the canonical row-bound authorization message (built inside
    // insertStrand) directly — binding the signature to this strand's contents + stamp.
    await party.controlDatabase.insertStrand(
      strandId,
      strandType,
      party.ownerPublicKey,
      (message: Uint8Array) => signMessageEd25519(message, party.ownerPrivateKey)
    );

    // Track locally for test assertions
    const strand: TestStrand = {
      strandId,
      sAppId,
      schema: options.schema,
      type: strandType,
      inviterPartyId: party.partyId
    };

    this.strands.set(strandId, strand);
    log('Strand created: %s', strandId);

    return strand;
  }

  /**
   * Create an open invitation for a strand
   */
  async createInvitation(
    party: TestParty,
    strand: TestStrand,
    expirationMs: number = 300_000
  ): Promise<TestOpenInvitation> {
    const token = `invite-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    log('Creating invitation for strand %s from party %s', strand.strandId, party.name);

    // Persist an owner-signed FormationInvite into the INVITING party's control
    // network (the consent tables are intra-cadre). TotalUses is left null
    // (unlimited) so multi-party join scenarios can redeem the same invite more
    // than once. The signer mirrors createStrand: ed25519 over the raw domain-tagged
    // authorization message insertFormationInvite builds ('CadreControl.FormationInvite',
    // 'add', Token, sAppId, ExpiresAt, TotalUses, ValidationUrl, StrandId, StampId),
    // verified by FormationInvite.AuthorizedInsert.
    await party.controlDatabase.insertFormationInvite(
      token,
      strand.sAppId,
      party.ownerPublicKey,
      (message: Uint8Array) => signMessageEd25519(message, party.ownerPrivateKey),
      { expiresAtMs: Date.now() + expirationMs }
    );

    const invitation: TestOpenInvitation = {
      token,
      sAppId: strand.sAppId,
      strandId: strand.strandId,
      expiration: new Date(Date.now() + expirationMs),
      bootstrap: party.bootstrapAddrs
    };

    log('Invitation created: %s', token);
    return invitation;
  }

  /**
   * Join a strand via invitation
   */
  async joinStrand(
    joiner: TestParty,
    invitation: TestOpenInvitation
  ): Promise<void> {
    log('Party %s joining strand %s via invitation', joiner.name, invitation.strandId);
    
    const strand = this.strands.get(invitation.strandId);
    if (!strand) {
      throw new Error(`Strand ${invitation.strandId} not found`);
    }

    // The FormationInvite + Strand both live in the INVITING party's control
    // network. Record a FormationUsage there against the existing strand to
    // consume the invitation: the consent record authorising the joiner's
    // membership. (Cross-party strand transport/replication is handled by the
    // formation protocol, not here.) Nothing tracks a local joiner roster — the
    // real, asserted membership fact is the FormationUsage row written below.
    const inviter = this.parties.get(strand.inviterPartyId);
    if (!inviter) {
      throw new Error(`Inviting party ${strand.inviterPartyId} not found for strand ${invitation.strandId}`);
    }
    await inviter.controlDatabase.recordFormationUsage({
      token: invitation.token,
      strandId: invitation.strandId,
      peerId: joiner.partyId,
    });

    log('Party %s joined strand %s', joiner.name, invitation.strandId);
  }

  /**
   * Wait until a party's control database has converged to at least
   * `expectedRows` rows in `table`.
   *
   * SCOPE — authoritative view only: the harness builds ONE `ControlDatabase`
   * per party, on the owner node (`createTestParty` in test-party.ts). Drone
   * nodes are libp2p peers in the same `control-<partyId>` network but have no
   * `ControlDatabase` instance, so this polls the OWNER's control DB only. It
   * proves the authoritative control-network view holds the rows — NOT that any
   * drone has converged. That is sufficient for the current scenarios; proving
   * drone-side convergence would require standing up a `ControlDatabase` on a
   * drone node and polling it here as well.
   */
  async waitForControlSync(
    party: TestParty,
    table: ControlTable,
    expectedRows: number,
    timeoutMs?: number
  ): Promise<void> {
    log('Waiting for control sync (owner view): %s.%s >= %d rows', party.name, table, expectedRows);

    await waitForCount(
      () => party.controlDatabase.countRows(table),
      expectedRows,
      {
        timeoutMs: timeoutMs ?? this.options.defaultTimeoutMs,
        description: `${party.name} control DB ${table} >= ${expectedRows} rows`
      }
    );

    log('Control sync complete for %s.%s', party.name, table);
  }

  /**
   * Shutdown all parties and release resources
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) return;
    
    log('Shutting down TestCadreNetwork with %d parties', this.parties.size);
    
    for (const party of this.parties.values()) {
      await shutdownTestParty(party);
    }
    
    this.parties.clear();
    this.strands.clear();
    releaseAllPorts();
    this.isShutdown = true;

    log('TestCadreNetwork shutdown complete');
  }
}

/**
 * Wait until a predicate over an ARBITRARY node's control database holds.
 *
 * SCOPE — deliberately broader than {@link TestCadreNetwork.waitForControlSync},
 * which is pinned to a single party's *owner* control DB (the harness builds
 * exactly one `ControlDatabase` per party). This waiter takes ANY node's
 * `ControlDatabase` directly, so a scenario can prove that a row written on
 * node A becomes readable on a SECOND node B over the live control network —
 * read-driven Optimystic convergence, where each poll IS the read that pulls
 * A's block into B's cohort view. Convergence is asserted on the predicate,
 * never on elapsed time; widen a flaky window with `timeoutMs`, not a fixed
 * sleep.
 *
 * @param readerDb   the control DB to poll (e.g. `B.getControlDatabase()`)
 * @param predicate  resolves true once the reader DB has converged
 * @param opts       wait tuning (defaults: 20s timeout, 250ms interval)
 */
export async function waitForCrossNodeControlSync(
  readerDb: ControlDatabase,
  predicate: (db: ControlDatabase) => Promise<boolean> | boolean,
  opts: WaitOptions = {}
): Promise<void> {
  await waitUntil(() => predicate(readerDb), {
    timeoutMs: opts.timeoutMs ?? 20_000,
    intervalMs: opts.intervalMs ?? 250,
    description: opts.description ?? 'cross-node control DB convergence',
  });
}

/**
 * Convenience over {@link waitForCrossNodeControlSync}: wait until `readerDb`
 * observes a `CadrePeer` row for `peerId` — the exact membership fact
 * `CadreNode.isMember` gates on. Returns once converged; throws on timeout.
 */
export async function waitForCadrePeerConverged(
  readerDb: ControlDatabase,
  peerId: string,
  opts: WaitOptions = {}
): Promise<void> {
  await waitForCrossNodeControlSync(
    readerDb,
    async (db) => (await db.queryCadrePeers()).some((p) => p.peerId === peerId),
    { description: `CadrePeer ${peerId} visible on reader control DB`, ...opts }
  );
}

/** WebSocket + circuit-relay transports shared by every e2e/integration scenario. */
export function wsTransports(): Libp2pTransports {
  return [webSockets(), circuitRelayTransport()];
}

/**
 * A properly signed sApp config with a NON-realtime `latencyHint` (`'interactive'`) —
 * realtime strands never hibernate, so any wake/hibernation scenario requires this.
 */
export function createSignedSAppConfig(schema: string, version: string): SAppConfig {
  const authorPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
  const authorPublicKey = getPublicKey(authorPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
  const signature = signSchema(schema, version, authorPrivateKey);
  return { id: authorPublicKey, version, schema, signature, latencyHint: 'interactive' as const };
}

export interface ControlNodeOpts {
  partyId: string;
  privateKey?: PrivateKey;
  bootstrapNodes?: string[];
  profile?: 'storage' | 'transaction';
  enableRelay?: boolean;
  listenAddrs?: string[];
  hibernation?: boolean;
  /** Override the proactive control-cohort reconcile cadence (ms). */
  reconcileMs?: number;
}

/** Build a `CadreNodeConfig` for one control-network test node. */
export function controlNodeConfig(opts: ControlNodeOpts): CadreNodeConfig {
  return {
    controlNetwork: { partyId: opts.partyId, bootstrapNodes: opts.bootstrapNodes ?? [] },
    profile: opts.profile ?? 'transaction',
    strandFilter: { mode: 'all' },
    storage: { provider: () => new MemoryRawStorage() },
    ...(opts.privateKey ? { privateKey: opts.privateKey } : {}),
    network: {
      transports: wsTransports(),
      listenAddrs: opts.listenAddrs ?? ['/ip4/127.0.0.1/tcp/0/ws'],
      ...(opts.enableRelay ? { enableRelay: true } : {}),
      ...(opts.reconcileMs ? { controlCohort: { reconcileMs: opts.reconcileMs } } : {})
    },
    hibernation: { enabled: opts.hibernation ?? false },
  };
}

/**
 * Make a freshly-started node its own control owner (genesis): enroll its derived
 * public key in `OwnerKey` and wire seed-bootstrap with the matching private key, so
 * it can owner-sign `CadrePeer` inserts (and mint seeds). Returns the owner PUBLIC key
 * (base64url) — the key an enrollee pins into its node-local trusted-owner anchor
 * (`trustOwnerKeys`) so this owner's membership vouchers pass its authorized-member
 * predicate. Callers that don't need the anchor key (most current callers) simply
 * discard the return value.
 */
export async function makeOwnOwner(node: CadreNode, key: PrivateKey): Promise<string> {
  const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
  const db = node.getControlDatabase();
  if (!db) throw new Error('control database missing after start');
  await db.insertOwnerKey(publicKeyB64);
  node.initializeSeedBootstrap(privateKeyB64);
  return publicKeyB64;
}

/** A real Ed25519 peer id for a peer that is NEVER started (a pure row subject). */
export async function randomPeerId(): Promise<string> {
  return peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
}

/**
 * Establish a DIRECT control-network connection from `reader` to `writer` and wait
 * until BOTH sides report it, SCOPED to this specific peer pair (so the recipe stays
 * correct when several readers attach to one writer, e.g. a 3-node full-mesh
 * scenario). This is the test-only stand-in for production control-cohort discovery.
 * Both-sides confirmation is a hard precondition of a replicating write: only once
 * each peer sees the connection can the control collection's cohort span them and a
 * commit be non-local-only.
 */
export async function connectControlNodes(reader: CadreNode, writer: CadreNode): Promise<void> {
  const readerNode = reader.getControlNode()!;
  const writerNode = writer.getControlNode()!;
  const writerAddrs = writerNode.getMultiaddrs();
  if (writerAddrs.length === 0) throw new Error('writer control node has no listen addresses');
  const readerPeerId = reader.peerId!.toString();
  const writerPeerId = writer.peerId!.toString();

  await readerNode.dial(writerAddrs[0]!);
  await waitUntil(() => readerNode.getConnections().some((c) => c.remotePeer.toString() === writerPeerId), {
    timeoutMs: 15_000,
    intervalMs: 250,
    description: 'reader control node connects to writer',
  });
  await waitUntil(() => writerNode.getConnections().some((c) => c.remotePeer.toString() === readerPeerId), {
    timeoutMs: 15_000,
    intervalMs: 250,
    description: 'writer control node sees inbound connection from reader',
  });
}

/**
 * Boot node A (owner + writer, storage profile so it holds the CadrePeer blocks) and
 * node B (a plain READER — deliberately NOT its own owner, so every row it observes
 * must have arrived over the wire) on a fresh party, DISCONNECTED. A vouches B
 * (`authorizePeer`) right after B starts, so A's inbound connection gate later admits
 * B's dial. Caller owns shutdown (`A.stop()` / `B.stop()`) and owns connecting them.
 *
 * `partyId` is built as `${partyIdPrefix}-${tag}-<timestamp>`; pass `partyIdPrefix` to
 * keep an existing scenario's party-id namespacing (default `'ctrl'`).
 */
export async function bootPair(
  tag: string,
  partyIdPrefix = 'ctrl',
): Promise<{ A: CadreNode; B: CadreNode }> {
  const partyId = `${partyIdPrefix}-${tag}-${Date.now()}`;

  const aKey = await generateKeyPair('Ed25519');
  const A = new CadreNode(controlNodeConfig({ partyId, privateKey: aKey, profile: 'storage', enableRelay: true }));
  await A.start();
  await makeOwnOwner(A, aKey);

  const bKey = await generateKeyPair('Ed25519');
  const B = new CadreNode(controlNodeConfig({ partyId, privateKey: bKey, profile: 'transaction' }));
  await B.start();

  // A vouches B so B's inbound pull streams pass A's per-stream control-DB gate
  // (A's snapshot is non-empty once it has an anchor + any member row). B still
  // pins nobody — row presence (`isMember`) is what these scenarios assert, not
  // trust.
  await A.authorizePeer(B.peerId!.toString());

  return { A, B };
}

