/**
 * Happy-path integration: cadre bring-up + real intra-cadre control records.
 *
 * What this exercises for real:
 *   - Party/cadre bring-up over real libp2p (owner + drone nodes).
 *   - Real writes to the INVITING party's ControlDatabase, each asserted by
 *     reading the owner's control DB back (waitForControlSync / queryStrands)
 *     through the real CadreControl CHECK constraints: a Strand row
 *     (createStrand), a FormationInvite (createInvitation), and one FormationUsage
 *     per redemption (joinStrand).
 *   - Intra-cadre libp2p connectivity (owner <-> its own drones).
 *
 * What this deliberately does NOT do: a real CROSS-party strand join. The
 * FormationInvite/FormationUsage consent model is intra-cadre — the invite lives
 * only in the inviting party's control network — so "Bob joins Alice's strand"
 * is a control-record fiction here, not cross-network transport. Real cross-party
 * strand formation over libp2p (StrandSolicitationService + addStrand, with
 * replication) is covered end-to-end by `strand-formation-e2e.integration.ts`.
 * Accordingly there are NO assertions on harness membership bookkeeping
 * (`strand.parties`) — only on real control-DB state and real connectivity.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCadreNetwork, waitForCount } from '../harness/index.js';
import { loadSimpleSApp } from '../fixtures/index.js';

describe('Happy Path - Cadre bring-up & intra-cadre control records', () => {
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

  it('brings up two cadres and persists real intra-cadre strand, invite, and usage records', async () => {
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

    expect(alice.ownerNode).toBeDefined();
    expect(alice.droneNodes).toHaveLength(2);
    expect(alice.bootstrapAddrs.length).toBeGreaterThan(0);

    // Bob is a customer with just an owner node (phone)
    const bob = await network.createParty({
      name: 'bob-customer',
      droneCount: 0
    });

    expect(bob.ownerNode).toBeDefined();
    expect(bob.droneNodes).toHaveLength(0);

    // ========================================
    // Step 2: Alice creates a strand with sApp
    // ========================================

    const strand = await network.createStrand(alice, {
      schema: simpleSApp,
      type: 'o' // Open strand
    });

    expect(strand.strandId).toBeDefined();
    expect(strand.sAppId).toBe(alice.ownerPublicKey);
    expect(strand.type).toBe('o');

    // Real control-DB read: the owner's CadreControl.Strand now holds the row
    // (createStrand inserts it through the schema's AuthorizedInsert constraint). This
    // replaces the old `strand.parties` (harness-stub) membership assertion.
    await network.waitForControlSync(alice, 'Strand', 1);
    const aliceStrands = await alice.controlDatabase.queryStrands();
    expect(aliceStrands.some(s => s.Id === strand.strandId)).toBe(true);

    // ========================================
    // Step 3: Alice creates an invitation
    // ========================================

    const invitation = await network.createInvitation(alice, strand, 60_000);

    expect(invitation.token).toBeDefined();
    expect(invitation.strandId).toBe(strand.strandId);
    expect(invitation.bootstrap).toEqual(alice.bootstrapAddrs);
    expect(invitation.expiration.getTime()).toBeGreaterThan(Date.now());

    // The FormationInvite really lands in Alice's control network.
    await network.waitForControlSync(alice, 'FormationInvite', 1);

    // ========================================
    // Step 4: Bob redeems the invitation
    // ========================================

    // In the harness this records a FormationUsage against the strand in ALICE's
    // control network (the intra-cadre consent record), NOT cross-party transport.
    // Assert that real row instead of harness membership bookkeeping. A genuine
    // cross-party join is covered by strand-formation-e2e.integration.ts (header).
    await network.joinStrand(bob, invitation);
    await network.waitForControlSync(alice, 'FormationUsage', 1);

    // ========================================
    // Step 5: Verify intra-cadre connectivity
    // ========================================

    // Alice's cadre should be fully connected
    await waitForCount(
      () => alice.ownerNode.libp2p.getConnections().length,
      2, // Connected to both drones
      {
        timeoutMs: 5000,
        description: 'alice owner connected to drones'
      }
    );

    // Each drone should be connected to owner
    for (const drone of alice.droneNodes) {
      const connections = drone.libp2p.getConnections();
      expect(connections.length).toBeGreaterThanOrEqual(1);
    }

    // ========================================
    // Summary: real control-DB state (no stub membership)
    // ========================================

    const usageCount = await alice.controlDatabase.countRows('FormationUsage');
    console.log('\n=== Happy Path Complete ===');
    console.log(`Alice (${alice.partyId}): 1 owner + ${alice.droneNodes.length} drones`);
    console.log(`Bob (${bob.partyId}): 1 owner`);
    console.log(`Strand: ${strand.strandId}`);
    console.log(`Alice control DB: ${aliceStrands.length} strand(s), ${usageCount} usage(s) (intra-cadre)`);
    console.log('===========================\n');
  });

  it('persists multiple distinct intra-cadre strands and their usages in one cadre', async () => {
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

    // Both strands really land in Carol's control DB.
    await network.waitForControlSync(carol, 'Strand', 2);
    const carolStrands = await carol.controlDatabase.queryStrands();
    expect(carolStrands.some(s => s.Id === strand1.strandId)).toBe(true);
    expect(carolStrands.some(s => s.Id === strand2.strandId)).toBe(true);

    // Dave redeems both invitations
    const invite1 = await network.createInvitation(carol, strand1);
    const invite2 = await network.createInvitation(carol, strand2);
    await network.waitForControlSync(carol, 'FormationInvite', 2);

    await network.joinStrand(dave, invite1);
    await network.joinStrand(dave, invite2);

    // Two redemptions => two FormationUsage rows in Carol's control DB.
    await network.waitForControlSync(carol, 'FormationUsage', 2);

    // Strands are independent (real returned identifiers, not stub membership).
    expect(strand1.strandId).not.toBe(strand2.strandId);
  });
});
