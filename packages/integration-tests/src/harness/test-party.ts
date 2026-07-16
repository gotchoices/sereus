/**
 * TestParty factory for integration tests.
 *
 * Creates parties with owner nodes and optional drone nodes,
 * all using real libp2p networking and real ControlDatabase.
 */

import debug from 'debug';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { createLibp2pNode, MemoryRawStorage } from '@optimystic/db-p2p';
import { ControlDatabase } from '@serfab/cadre-core';
import type { Libp2p, PrivateKey } from '@libp2p/interface';
import type { IRepo } from '@optimystic/db-core';
import { allocatePort, releasePorts } from './port-allocator.js';
import type { TestParty, TestCadreNode, CreatePartyOptions } from './types.js';

const log = debug('sereus:integration:party');

/**
 * Extended Libp2p node with coordinatedRepo attached by createLibp2pNode.
 */
interface Libp2pNodeWithRepo extends Libp2p {
  coordinatedRepo: IRepo;
}

/**
 * Create a test cadre node with real libp2p networking
 */
async function createTestNode(
  networkName: string,
  bootstrapNodes: string[],
  profile: 'transaction' | 'storage',
  privateKey?: PrivateKey
): Promise<TestCadreNode> {
  const port = await allocatePort();

  log('Creating node on port %d for network %s', port, networkName);

  const node = await createLibp2pNode({
    port,
    bootstrapNodes,
    networkName,
    privateKey,
    storage: () => new MemoryRawStorage(),
    fretProfile: profile === 'storage' ? 'core' : 'edge',
    clusterSize: 3,
    clusterPolicy: {
      allowDownsize: true,
      sizeTolerance: 0.5,
      superMajorityThreshold: 0.51
    },
    arachnode: { enableRingZulu: true }
  }) as Libp2pNodeWithRepo;

  const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
  const peerId = node.peerId.toString();

  // If we requested an ephemeral port (0), infer the actual bound TCP port from the listen multiaddrs.
  // This is best-effort: if we can't find it, we keep the requested port.
  const inferredPort = multiaddrs
    .map(addr => addr.match(/\/tcp\/([0-9]+)/)?.[1])
    .find(Boolean);
  const actualPort = inferredPort ? Number(inferredPort) : port;

  log('Node created: %s listening on %j', peerId, multiaddrs);

  return {
    libp2p: node,
    peerId,
    port: actualPort,
    multiaddrs,
    profile,
    coordinatedRepo: node.coordinatedRepo
  };
}

/**
 * Create a test party with owner node and optional drones
 */
export async function createTestParty(options: CreatePartyOptions): Promise<TestParty> {
  const { name, droneCount = 0, droneProfile = 'storage' } = options;
  
  // Generate unique party ID
  const partyId = `party-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const networkName = `control-${partyId}`;
  
  log('Creating test party: %s (id: %s)', name, partyId);
  
  // Generate owner keypair
  const ownerKey = await generateKeyPair('Ed25519');
  const ownerPrivateKey = privateKeyToProtobuf(ownerKey);
  const ownerPeerId = peerIdFromPrivateKey(ownerKey);
  // Extract raw Ed25519 public key (32 bytes after 4-byte header and 32-byte seed)
  // and encode as base64url for use with crypto functions
  const rawPublicKey = ownerPrivateKey.slice(36, 68);
  const ownerPublicKey = uint8ArrayToString(rawPublicKey, 'base64url');

  log('Generated owner key: %s (peerId: %s)', ownerPublicKey, ownerPeerId.toString());

  // Create owner node first (no bootstrap - it IS the bootstrap).
  // The owner node MUST adopt the owner keypair as its libp2p identity:
  // seed/CadrePeer owner marking derives each peer's ed25519 key from its
  // transport PeerId and checks it against the OwnerKey table
  // (see seed-bootstrap.ts `ed25519PublicKeyB64FromPeerId` / `queryPeers`). A
  // fresh random node key would never match, so the owner would never be
  // marked `isOwner` in its own seeds.
  const ownerNode = await createTestNode(networkName, [], 'transaction', ownerKey);
  
  // Get bootstrap addresses from owner node
  const bootstrapAddrs = ownerNode.multiaddrs;
  
  // Create drone nodes if requested
  const droneNodes: TestCadreNode[] = [];
  for (let i = 0; i < droneCount; i++) {
    log('Creating drone node %d/%d for party %s', i + 1, droneCount, name);
    const drone = await createTestNode(networkName, bootstrapAddrs, droneProfile);
    droneNodes.push(drone);
  }
  
  log('Party %s created with %d total nodes', name, 1 + droneNodes.length);

  // Create and initialize the ControlDatabase for this party
  const controlDatabase = new ControlDatabase({
    partyId,
    libp2pNode: ownerNode.libp2p,
    coordinatedRepo: ownerNode.coordinatedRepo
  });
  await controlDatabase.initialize();
  log('ControlDatabase initialized for party %s', name);

  // Bootstrap: insert the owner key
  await controlDatabase.insertOwnerKey(ownerPublicKey);
  log('Owner key inserted for party %s', name);

  return {
    partyId,
    name,
    ownerPrivateKey,
    ownerPublicKey,
    ownerNode,
    droneNodes,
    bootstrapAddrs,
    controlDatabase
  };
}

/**
 * Shut down a test party and release resources
 */
export async function shutdownTestParty(party: TestParty): Promise<void> {
  log('Shutting down party: %s', party.name);

  // Close the ControlDatabase first
  try {
    await party.controlDatabase.close();
    log('ControlDatabase closed for party %s', party.name);
  } catch (err) {
    log('Error closing ControlDatabase for %s: %s', party.name, (err as Error).message);
  }

  const allNodes = [party.ownerNode, ...party.droneNodes];
  const ports: number[] = [];

  for (const node of allNodes) {
    try {
      await node.libp2p.stop();
      ports.push(node.port);
    } catch (err) {
      log('Error stopping node %s: %s', node.peerId, (err as Error).message);
    }
  }

  releasePorts(ports);
  log('Party %s shutdown complete', party.name);
}

