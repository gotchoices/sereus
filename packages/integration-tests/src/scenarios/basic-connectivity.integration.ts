/**
 * Basic connectivity integration test.
 * 
 * Verifies that the test harness can:
 * - Create parties with real libp2p nodes
 * - Nodes can connect to each other
 * - Cleanup works properly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCadreNetwork, waitForCount } from '../harness/index.js';

describe('Basic Connectivity', () => {
  let network: TestCadreNetwork;

  beforeAll(() => {
    network = new TestCadreNetwork({ verbose: true });
  });

  afterAll(async () => {
    await network.shutdown();
  });

  it('should create a single party with owner node', async () => {
    const alice = await network.createParty({ name: 'alice' });
    
    expect(alice.partyId).toMatch(/^party-alice-/);
    expect(alice.ownerNode).toBeDefined();
    expect(alice.ownerNode.peerId).toMatch(/^12D3KooW/); // Ed25519 peer ID format
    expect(alice.ownerNode.multiaddrs.length).toBeGreaterThan(0);
    expect(alice.droneNodes).toHaveLength(0);
  });

  it('should create a party with drone nodes', async () => {
    const bob = await network.createParty({ 
      name: 'bob',
      droneCount: 2,
      droneProfile: 'storage'
    });
    
    expect(bob.droneNodes).toHaveLength(2);
    
    for (const drone of bob.droneNodes) {
      expect(drone.peerId).toMatch(/^12D3KooW/);
      expect(drone.profile).toBe('storage');
      expect(drone.multiaddrs.length).toBeGreaterThan(0);
    }
  });

  it('should have drone nodes connected to owner node', async () => {
    const carol = await network.createParty({
      name: 'carol',
      droneCount: 2
    });
    
    // Give nodes a moment to establish connections via FRET
    // FRET is fast, but there's still network latency
    await waitForCount(
      () => carol.ownerNode.libp2p.getConnections().length,
      2,
      { 
        timeoutMs: 5000,
        description: 'owner node has 2 connections'
      }
    );
    
    const ownerConnections = carol.ownerNode.libp2p.getConnections();
    expect(ownerConnections.length).toBeGreaterThanOrEqual(2);
    
    // Verify drones are connected
    for (const drone of carol.droneNodes) {
      const droneConnections = drone.libp2p.getConnections();
      expect(droneConnections.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('should have unique peer IDs for all nodes', async () => {
    const dave = await network.createParty({
      name: 'dave',
      droneCount: 3
    });
    
    const allPeerIds = [
      dave.ownerNode.peerId,
      ...dave.droneNodes.map(d => d.peerId)
    ];
    
    const uniquePeerIds = new Set(allPeerIds);
    expect(uniquePeerIds.size).toBe(allPeerIds.length);
  });

  it('should have coordinated repo available on nodes', async () => {
    const eve = await network.createParty({ name: 'eve' });
    
    // The coordinatedRepo should be attached by createLibp2pNode
    expect(eve.ownerNode.coordinatedRepo).toBeDefined();
  });
});

