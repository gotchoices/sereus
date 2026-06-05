/**
 * Multi-party integration: independent cadres + real intra-cadre control records.
 *
 * What this exercises for real:
 *   - Bringing up SEPARATE parties, each with its own `control-<partyId>`
 *     network and authority ControlDatabase.
 *   - Real writes to the INVITING party's ControlDatabase, each asserted by
 *     reading that authority's control DB back through the real CadreControl
 *     CHECK constraints (waitForControlSync / queryStrands / countFormationUsage):
 *     Strand (createStrand), FormationInvite (createInvitation), and one
 *     FormationUsage per redemption (joinStrand).
 *   - Real intra-cadre libp2p connectivity (each authority <-> its own drones).
 *
 * What this deliberately does NOT do: a real CROSS-party strand join / data sync.
 * The FormationInvite/FormationUsage consent model is intra-cadre — the invite and
 * its redemptions live only in the INVITING party's control network — so a joiner
 * being "in the strand" is recorded as a consent row in the inviter's DB, not as
 * cross-network transport into the joiner's own network. Real cross-party strand
 * formation over libp2p (StrandSolicitationService + addStrand, with replication)
 * is covered end-to-end by `strand-formation-e2e.integration.ts`.
 *
 * Accordingly there are NO assertions on harness membership bookkeeping
 * (`strand.parties`, which the harness mutates locally) — only on real control-DB
 * state and real libp2p connectivity.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestCadreNetwork, waitForCount } from '../harness/index.js';
import { MINIMAL_SAPP_LOGIC } from '../fixtures/index.js';

describe('Multi-Party - Independent cadres & intra-cadre control records', () => {
  let network: TestCadreNetwork;

  beforeAll(() => {
    network = new TestCadreNetwork({
      verbose: true,
      defaultTimeoutMs: 15_000
    });
  });

  afterAll(async () => {
    await network.shutdown();
  });

  it('records a real intra-cadre strand, invite, and usage for a two-party invitation flow', async () => {
    // Two independent parties, each with its own control network.
    const alice = await network.createParty({
      name: 'alice-sync',
      droneCount: 1
    });
    const bob = await network.createParty({
      name: 'bob-sync',
      droneCount: 1
    });

    // Alice creates a strand — assert the row really landed in Alice's control DB.
    const strand = await network.createStrand(alice, {
      schema: MINIMAL_SAPP_LOGIC,
      type: 'o'
    });
    await network.waitForControlSync(alice, 'Strand', 1);
    const aliceStrands = await alice.controlDatabase.queryStrands();
    expect(aliceStrands.some(s => s.Id === strand.strandId)).toBe(true);

    // Alice creates an invitation — assert the FormationInvite really landed.
    const invitation = await network.createInvitation(alice, strand);
    await network.waitForControlSync(alice, 'FormationInvite', 1);

    // Bob redeems the invitation. In the harness this records a FormationUsage
    // against the strand in ALICE's control network (the intra-cadre consent
    // record), NOT cross-party transport into Bob's network. Assert that real
    // row instead of harness membership bookkeeping.
    await network.joinStrand(bob, invitation);
    await network.waitForControlSync(alice, 'FormationUsage', 1);
    expect(await alice.controlDatabase.countFormationUsage(invitation.token)).toBe(1);
  });

  it('brings up two independent cadres that each connect internally over real libp2p', async () => {
    const carol = await network.createParty({
      name: 'carol-sync',
      droneCount: 1
    });
    const dave = await network.createParty({
      name: 'dave-sync',
      droneCount: 1
    });

    // Each party runs its own control network; this asserts only real intra-cadre
    // connectivity (authority <-> its own drone). Cross-party strand transport is
    // out of scope here (see header → strand-formation-e2e.integration.ts).
    await waitForCount(
      () => carol.authorityNode.libp2p.getConnections().length,
      1,
      {
        timeoutMs: 5000,
        description: 'carol authority connected to its drone'
      }
    );

    await waitForCount(
      () => dave.authorityNode.libp2p.getConnections().length,
      1,
      {
        timeoutMs: 5000,
        description: 'dave authority connected to its drone'
      }
    );
  });

  it('records each redemption of one open invitation as a distinct FormationUsage row', async () => {
    const eve = await network.createParty({ name: 'eve-sync' });
    const frank = await network.createParty({ name: 'frank-sync' });
    const grace = await network.createParty({ name: 'grace-sync' });

    // Eve creates a strand and one open (unlimited-use) invitation.
    const strand = await network.createStrand(eve, {
      schema: MINIMAL_SAPP_LOGIC
    });
    await network.waitForControlSync(eve, 'Strand', 1);

    const invitation = await network.createInvitation(eve, strand);
    await network.waitForControlSync(eve, 'FormationInvite', 1);

    // Frank and Grace each redeem the same invitation. Both redemptions are
    // recorded as FormationUsage rows in EVE's control network (intra-cadre
    // consent), so the real signal is "two distinct usages of one invite",
    // not cross-party membership.
    await network.joinStrand(frank, invitation);
    await network.joinStrand(grace, invitation);
    await network.waitForControlSync(eve, 'FormationUsage', 2);
    expect(await eve.controlDatabase.countFormationUsage(invitation.token)).toBe(2);
  });

  it('persists multiple distinct strands and their redemptions in one cadre', async () => {
    const henry = await network.createParty({ name: 'henry-sync' });
    const ivy = await network.createParty({ name: 'ivy-sync' });

    // Henry creates two distinct strands (different sApps).
    const strand1 = await network.createStrand(henry, {
      schema: MINIMAL_SAPP_LOGIC,
      sAppId: 'app-1'
    });
    const strand2 = await network.createStrand(henry, {
      schema: MINIMAL_SAPP_LOGIC,
      sAppId: 'app-2'
    });

    // Both strands really land in Henry's control DB.
    await network.waitForControlSync(henry, 'Strand', 2);
    const henryStrands = await henry.controlDatabase.queryStrands();
    expect(henryStrands.some(s => s.Id === strand1.strandId)).toBe(true);
    expect(henryStrands.some(s => s.Id === strand2.strandId)).toBe(true);

    // Ivy redeems both invitations => two FormationUsage rows in Henry's control DB.
    const invite1 = await network.createInvitation(henry, strand1);
    const invite2 = await network.createInvitation(henry, strand2);
    await network.waitForControlSync(henry, 'FormationInvite', 2);

    await network.joinStrand(ivy, invite1);
    await network.joinStrand(ivy, invite2);
    await network.waitForControlSync(henry, 'FormationUsage', 2);

    // Strands are independent (real returned identifiers / inputs, not stub membership).
    expect(strand1.strandId).not.toBe(strand2.strandId);
    expect(strand1.sAppId).not.toBe(strand2.sAppId);
  });
});
