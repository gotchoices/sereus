/**
 * `CadreNode.formStrand`'s JOINER-side membership adoption
 * (`strand-formation-membership-invite`): when a closed-strand formation result
 * carries a membership invitation, the node (1) mints-or-reuses this party's own
 * `StrandPartyKey` identity for the strand and (2) stages the invitation in memory
 * for the strand bring-up flow (`strand-node-binds-member-peer`) to redeem.
 *
 * The solicitation service's `formStrand` is stubbed per test — the wire round-trip
 * (issuance, disclosure timing, validation) is pinned by
 * `strand-formation-membership-invite.spec.ts`; this file pins what the NODE does
 * with the result:
 *
 *  - invitation present → party key persisted + invitation exposed via
 *    `getPendingMembershipInvite`,
 *  - a re-formation of the same strand REUSES the stored party key and REPLACES the
 *    staged invitation with the fresh one,
 *  - no invitation (open strand / unbound) → no party key minted, nothing staged,
 *  - party-key persistence failure (unenrolled owner) → `formStrand` throws naming
 *    the spent token, and no invitation is staged (no silent half-member).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CadreNode } from '../src/cadre-node.js';
import type { StrandSolicitationService } from '../src/strand-solicitation.js';
import type { FormStrandResult, OpenInvitation, StrandMembershipInvite } from '../src/types.js';
import { strandMemberKeyPair } from '../src/strand-member-key.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';

const rand = (): string => Math.random().toString(36).slice(2);

function invitationFor(token: string): OpenInvitation {
  return {
    token,
    sAppId: 'sapp-membership-adopt',
    expiration: new Date(Date.now() + 3600_000),
    bootstrap: ['/ip4/127.0.0.1/tcp/1']
  };
}

function invitePair(tag: string): StrandMembershipInvite {
  return { inviteKey: `invite-key-${tag}`, invitePrivateKey: `invite-secret-${tag}` };
}

/**
 * Stub the service's dial with a canned result. Initializes solicitation only once per
 * node — a repeat `initializeStrandSolicitation` would re-register the formation
 * protocol handler on the same libp2p node and throw.
 */
function stubFormation(node: CadreNode, result: FormStrandResult): StrandSolicitationService {
  if (!node.getStrandSolicitationService()) {
    node.initializeStrandSolicitation();
  }
  const service = node.getStrandSolicitationService()!;
  service.formStrand = async () => result;
  return service;
}

function formedResult(strandId: string, membershipInvite?: StrandMembershipInvite): FormStrandResult {
  return {
    memberKey: 'joiner-member-key',
    invitePrivateKey: '',
    strandId,
    memberPrivateKey: 'shared-read-secret',
    ...(membershipInvite ? { membershipInvite } : {}),
    strandAddrs: []
  };
}

describe('CadreNode.formStrand: joiner membership adoption', () => {
  let node: CadreNode;

  beforeAll(async () => {
    ({ node } = await startSelfOwnerNode('formation-membership-', { enrollOwner: true }));
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('persists the party key and stages the invitation when the result carries one', async () => {
    const strandId = 'strand-adopt-' + rand();
    const invite = invitePair('first');
    stubFormation(node, formedResult(strandId, invite));

    const result = await node.formStrand(invitationFor('token-' + rand()));

    expect(result.membershipInvite).toEqual(invite);
    // (1) This party's own identity landed as a StrandPartyKey row — decodable to the
    // keypair the invitation will admit as Strand.Member.
    const partyKey = await node.getControlDatabase()!.queryStrandPartyKey(strandId);
    expect(partyKey).not.toBeNull();
    expect(strandMemberKeyPair(partyKey!).publicKeyB64).toBeTruthy();
    // (2) The invitation is staged for the bring-up seam.
    expect(node.getPendingMembershipInvite(strandId)).toEqual(invite);
  }, 30_000);

  it('re-formation reuses the stored party key and replaces the staged invitation', async () => {
    const strandId = 'strand-rejoin-' + rand();
    stubFormation(node, formedResult(strandId, invitePair('original')));
    await node.formStrand(invitationFor('token-' + rand()));
    const firstKey = await node.getControlDatabase()!.queryStrandPartyKey(strandId);
    expect(firstKey).not.toBeNull();

    const freshInvite = invitePair('fresh');
    stubFormation(node, formedResult(strandId, freshInvite));
    await node.formStrand(invitationFor('token-' + rand()));

    // Identity is stable across re-formations — a per-join key would never match the
    // Member row the first invitation seated.
    expect(await node.getControlDatabase()!.queryStrandPartyKey(strandId)).toBe(firstKey);
    // The fresh invitation supersedes the (possibly expired) original.
    expect(node.getPendingMembershipInvite(strandId)).toEqual(freshInvite);
  }, 30_000);

  it('no invitation on the result → no party key minted, nothing staged', async () => {
    const strandId = 'strand-open-' + rand();
    stubFormation(node, formedResult(strandId));

    const result = await node.formStrand(invitationFor('token-' + rand()));

    expect(result.membershipInvite).toBeUndefined();
    expect(await node.getControlDatabase()!.queryStrandPartyKey(strandId)).toBeNull();
    expect(node.getPendingMembershipInvite(strandId)).toBeUndefined();
  }, 30_000);

  it('party-key persistence failure fails formStrand loudly and stages nothing', async () => {
    // An UNENROLLED owner: the StrandPartyKey insert is rejected by the control
    // schema's AuthorizedInsert, standing in for any identity-persistence failure.
    const { node: unenrolled } = await startSelfOwnerNode('formation-membership-unenrolled-', { enrollOwner: false });
    try {
      const strandId = 'strand-fail-' + rand();
      stubFormation(unenrolled, formedResult(strandId, invitePair('doomed')));

      await expect(unenrolled.formStrand(invitationFor('token-' + rand())))
        .rejects.toThrow(/membership identity \(StrandPartyKey\) failed/);

      // A joiner that cannot persist its identity must not look half-joined.
      expect(unenrolled.getPendingMembershipInvite(strandId)).toBeUndefined();
      expect(await unenrolled.getControlDatabase()!.queryStrandPartyKey(strandId)).toBeNull();
    } finally {
      await unenrolled.stop();
    }
  }, 60_000);
});
