/**
 * Types for integration test harness
 */

import type { Libp2p } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import type { ControlDatabase } from '@serfab/cadre-core';

/**
 * Represents a party (person/organization) in the Sereus network.
 * A party has an authority (signing keys) and a cadre of nodes.
 */
export interface TestParty {
  /** Unique identifier for this party */
  partyId: string;

  /** Human-readable name for test output */
  name: string;

  /** Ed25519 private key for signing authority operations */
  authorityPrivateKey: Uint8Array;

  /** Ed25519 public key (base64 encoded) for verification */
  authorityPublicKey: string;

  /** The authority node ("phone") - has the signing keys */
  authorityNode: TestCadreNode;

  /** Additional drone nodes (provider-hosted) */
  droneNodes: TestCadreNode[];

  /** Bootstrap addresses for this party's control network */
  bootstrapAddrs: string[];

  /** The party's control database (real ControlDatabase instance) */
  controlDatabase: ControlDatabase;
}

/**
 * A single cadre node in a test party
 */
export interface TestCadreNode {
  /** The underlying libp2p node */
  libp2p: Libp2p;
  
  /** Peer ID as string */
  peerId: string;
  
  /** Port the node is listening on */
  port: number;
  
  /** Multiaddrs the node is reachable at */
  multiaddrs: string[];
  
  /** Node profile */
  profile: 'transaction' | 'storage';
  
  /** Coordinated repo from db-p2p (for Optimystic) */
  coordinatedRepo: IRepo;
}

/**
 * Information about a strand (shared database)
 */
export interface TestStrand {
  /** UUID of the strand */
  strandId: string;
  
  /** The sApp ID (author public key) */
  sAppId: string;
  
  /** The sApp schema */
  schema: string;
  
  /** Type: open or closed */
  type: 'o' | 'c';

  /**
   * Party that created the strand and owns its control network (the inviter).
   * This is the ONLY real membership fact the harness tracks: the strand,
   * its invites, and its usages all live in this party's ControlDatabase, so
   * `joinStrand` needs it to locate the inviter's DB. It is deliberately NOT a
   * roster of joiners — joiners are recorded as real FormationUsage rows in the
   * inviter's control DB, which is what tests assert.
   */
  inviterPartyId: string;
}

/**
 * Open invitation for strand formation
 */
export interface TestOpenInvitation {
  token: string;
  sAppId: string;
  strandId: string;
  expiration: Date;
  bootstrap: string[];
}

/**
 * Options for creating a test party
 */
export interface CreatePartyOptions {
  /** Human-readable name */
  name: string;
  
  /** Number of drone nodes to create (default: 0) */
  droneCount?: number;
  
  /** Profile for drone nodes (default: 'storage') */
  droneProfile?: 'transaction' | 'storage';
}

/**
 * Options for creating a strand
 */
export interface CreateStrandOptions {
  /** The sApp schema SQL */
  schema: string;
  
  /** sApp ID (defaults to party's authority key) */
  sAppId?: string;
  
  /** Strand type (default: 'o' for open) */
  type?: 'o' | 'c';
}

/**
 * Query result for data synchronization checks
 */
export interface QueryResult {
  rows: Record<string, unknown>[];
}

