/**
 * `CadreNode.issueStrandMembershipInvite` — the RESPONDER-side implementation behind the
 * formation manager's `issueMembershipInvite` seam
 * (`strand-formation-membership-invite`).
 *
 * The happy path (a live closed strand issuing a redeemable `Strand.Invite`) needs a real
 * strand runtime and is pinned by the `strand-formation-cross-party-seed` integration
 * scenario. What is pinned HERE are the branches that decide whether a bound redemption is
 * approved at all, each of which the manager maps to a user-visible protocol outcome:
 *
 *  - open host strand → `null` (approve with no invitation),
 *  - `Strand` row gone (concurrent unpublish) → throw → retryable rejection,
 *  - no `StrandPartyKey` identity → throw → retryable rejection,
 *  - closed strand whose runtime is not live → throw → retryable rejection.
 *
 * The method is private (only the formation manager calls it), so the tests reach it the
 * way the sibling node specs reach private members: a narrowing cast.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CadreNode } from '../src/cadre-node.js';
import type { StrandMembershipInvite } from '../src/types.js';
import { sign } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey } from '../src/strand-member-key.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';

const rand = (): string => Math.random().toString(36).slice(2);

/** The private responder-side issuer, as the formation manager's wired hook calls it. */
function issue(node: CadreNode, strandId: string): Promise<StrandMembershipInvite | null> {
  return (node as unknown as {
    issueStrandMembershipInvite(id: string): Promise<StrandMembershipInvite | null>;
  }).issueStrandMembershipInvite(strandId);
}

describe('CadreNode.issueStrandMembershipInvite (responder side)', () => {
  let node: CadreNode;
  let ownerKey: Ed25519KeyPair;

  beforeAll(async () => {
    // `strandFilter: none` keeps the strand watcher from auto-launching the rows these
    // tests publish — "runtime not live" has to stay deterministically not-live.
    ({ node, ownerKey } = await startSelfOwnerNode('issue-membership-invite-', {
      strandFilter: { mode: 'none' }
    }));
  }, 60_000);

  afterAll(async () => {
    await node?.stop();
  });

  it('open host strand → null (nothing to invite into)', async () => {
    const strandId = 'strand-open-' + rand();
    await node.publishStrand(strandId, 'o');

    expect(await issue(node, strandId)).toBeNull();
  }, 30_000);

  it('Strand row gone (concurrent unpublish) → throws', async () => {
    await expect(issue(node, 'strand-never-published-' + rand()))
      .rejects.toThrow(/Strand row is gone/);
  }, 30_000);

  it('closed strand whose party identity is missing → throws naming StrandPartyKey', async () => {
    const strandId = 'strand-no-identity-' + rand();
    await node.publishStrand(strandId, 'c', await generateStrandMemberKey());
    // Publishing a closed strand mints the identity; remove it to stand in for a sibling
    // machine that has not converged on the row (or a pre-split strand not yet healed).
    const removed = await node.getControlDatabase()!.deleteStrandPartyKey(
      strandId,
      ownerKey.publicKeyB64,
      (message) => sign(message, ownerKey.privateKeyB64, 'ed25519', 'bytes', 'base64url', 'base64url') as string);
    expect(removed).toBe(true);

    await expect(issue(node, strandId)).rejects.toThrow(/no StrandPartyKey row/);
  }, 30_000);

  it('closed strand whose runtime is not live → throws', async () => {
    const strandId = 'strand-not-live-' + rand();
    await node.publishStrand(strandId, 'c', await generateStrandMemberKey());
    // Identity present (publish minted it), instance never launched.
    expect(await node.getControlDatabase()!.queryStrandPartyKey(strandId)).not.toBeNull();

    await expect(issue(node, strandId)).rejects.toThrow(/runtime is\s+not live/);
  }, 30_000);
});
