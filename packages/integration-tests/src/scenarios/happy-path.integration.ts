/**
 * Full happy path integration test.
 * 
 * End-to-end test that exercises the complete flow:
 * 1. Create two parties with cadres
 * 2. Party A creates a strand with an sApp
 * 3. Party A invites Party B
 * 4. Party B joins the strand
 * 5. Both parties have connected nodes
 * 
 * This test validates the core Sereus workflow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCadreNetwork, waitForCount, sleep } from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

describe('Happy Path - Full Workflow', () => {
  let network: TestCadreNetwork;

  beforeAll(() => {
    network = new TestCadreNetwork({ 
      verbose: true,
      defaultTimeoutMs: 20_000
    });
  });

  afterAll(async () => {
    await network.shutdown();
  });

  it('should complete the full strand formation workflow', async () => {
    const simpleSApp = await loadSimpleSApp();

    // ========================================
    // Step 1: Create two parties with cadres
    // ========================================
    
    // Alice is a business with 2 drone nodes (provider-hosted)
    const alice = await network.createParty({
      name: 'alice-business',
      droneCount: 2,
      droneProfile: 'storage'
    });
    
    expect(alice.authorityNode).toBeDefined();
    expect(alice.droneNodes).toHaveLength(2);
    expect(alice.bootstrapAddrs.length).toBeGreaterThan(0);
    
    // Bob is a customer with just an authority node (phone)
    const bob = await network.createParty({
      name: 'bob-customer',
      droneCount: 0
    });
    
    expect(bob.authorityNode).toBeDefined();
    expect(bob.droneNodes).toHaveLength(0);
    
    // ========================================
    // Step 2: Alice creates a strand with sApp
    // ========================================
    
    const strand = await network.createStrand(alice, {
      schema: simpleSApp,
      type: 'o' // Open strand
    });
    
    expect(strand.strandId).toBeDefined();
    expect(strand.sAppId).toBe(alice.authorityPublicKey);
    expect(strand.type).toBe('o');
    expect(strand.parties).toContain(alice.partyId);
    
    // ========================================
    // Step 3: Alice creates an invitation
    // ========================================
    
    const invitation = await network.createInvitation(alice, strand, 60_000);
    
    expect(invitation.token).toBeDefined();
    expect(invitation.strandId).toBe(strand.strandId);
    expect(invitation.bootstrap).toEqual(alice.bootstrapAddrs);
    expect(invitation.expiration.getTime()).toBeGreaterThan(Date.now());
    
    // ========================================
    // Step 4: Bob joins the strand
    // ========================================
    
    await network.joinStrand(bob, invitation);
    
    expect(strand.parties).toContain(bob.partyId);
    expect(strand.parties).toHaveLength(2);
    
    // ========================================
    // Step 5: Verify connectivity
    // ========================================
    
    // Alice's cadre should be fully connected
    await waitForCount(
      () => alice.authorityNode.libp2p.getConnections().length,
      2, // Connected to both drones
      { 
        timeoutMs: 5000,
        description: 'alice authority connected to drones'
      }
    );
    
    // Each drone should be connected to authority
    for (const drone of alice.droneNodes) {
      const connections = drone.libp2p.getConnections();
      expect(connections.length).toBeGreaterThanOrEqual(1);
    }
    
    // ========================================
    // Summary: All steps completed successfully
    // ========================================
    
    console.log('\n=== Happy Path Complete ===');
    console.log(`Alice (${alice.partyId}): 1 authority + ${alice.droneNodes.length} drones`);
    console.log(`Bob (${bob.partyId}): 1 authority`);
    console.log(`Strand: ${strand.strandId}`);
    console.log(`Parties in strand: ${strand.parties.length}`);
    console.log('===========================\n');
  });

  it('should handle multiple strands in the same workflow', async () => {
    const simpleSApp = await loadSimpleSApp();

    // Create parties
    const carol = await network.createParty({ name: 'carol-multi', droneCount: 1 });
    const dave = await network.createParty({ name: 'dave-multi', droneCount: 1 });

    // Carol creates two different sApps
    const strand1 = await network.createStrand(carol, {
      schema: simpleSApp,
      sAppId: 'inventory-app'
    });

    const strand2 = await network.createStrand(carol, {
      schema: simpleSApp,
      sAppId: 'orders-app'
    });
    
    // Dave joins both strands
    const invite1 = await network.createInvitation(carol, strand1);
    const invite2 = await network.createInvitation(carol, strand2);
    
    await network.joinStrand(dave, invite1);
    await network.joinStrand(dave, invite2);
    
    // Both strands should have both parties
    expect(strand1.parties).toHaveLength(2);
    expect(strand2.parties).toHaveLength(2);
    
    // Strands should be independent
    expect(strand1.strandId).not.toBe(strand2.strandId);
  });
});

