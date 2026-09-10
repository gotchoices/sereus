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
 *  - closed strand whose runtime is not live → throw → retryable rejection,
 *  - closed strand whose founder launch was refused as pre-split → rethrow the
 *    `PreSplitStrandIdentityError` → non-retryable rejection, until the strand is stopped.
 *
 * The method is private (only the formation manager calls it), so the tests reach it the
 * way the sibling node specs reach private members: a narrowing cast.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { CadreNode } from '../src/cadre-node.js';
import type { SAppConfig, StrandMembershipInvite } from '../src/types.js';
import { generatePrivateKey, getPublicKey, sign } from '@optimystic/quereus-plugin-crypto';
import { generateStrandMemberKey, strandMemberKeyPair } from '../src/strand-member-key.js';
import { bootstrapFounderMembership, PreSplitStrandIdentityError } from '../src/strand-membership-writer.js';
import { signSchema } from '../src/schema-verification.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';
import type { Ed25519KeyPair } from '../src/ed25519-key.js';

const rand = (): string => Math.random().toString(36).slice(2);

function signedSApp(): SAppConfig {
  const schema = 'create table Note (Id text primary key);';
  const priv = generatePrivateKey('ed25519', 'base64url') as string;
  const pub = getPublicKey(priv, 'ed25519', 'base64url', 'base64url') as string;
  return { id: pub, version: '1.0.0', schema, signature: signSchema(schema, '1.0.0', priv) };
}

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
    // machine that has not converged on the row.
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

  it('closed strand whose founder launch was refused as pre-split → rethrows the refusal until stopped', async () => {
    const strandId = 'strand-pre-split-' + rand();
    const memberPrivateKey = await generateStrandMemberKey();
    await node.publishStrand(strandId, 'c', memberPrivateKey);
    const strandRow = (await node.getControlDatabase()!.queryStrand(strandId))!;
    const sAppConfig = signedSApp();
    // Attach as a joiner (writes nothing), then seat the pre-split founding by hand:
    // Header/Member/Manager under the key derived from the SHARED read secret.
    const instance = await node.addStrand({ strandRow, sAppConfig, founder: false });
    await bootstrapFounderMembership(instance.database!.getDatabase(), {
      strandId, type: 'c', sApp: sAppConfig, founderKeyPair: strandMemberKeyPair(memberPrivateKey),
    });

    // The founder request (derived — this node published the row) is refused and recorded.
    await expect(node.addStrand({ strandRow, sAppConfig })).rejects.toThrow(PreSplitStrandIdentityError);
    // The joiner runtime is still live, yet issuance reports the permanent refusal rather
    // than a retryable invite-gate failure.
    expect(node.getStrand(strandId)?.database).toBeDefined();
    await expect(issue(node, strandId)).rejects.toThrow(PreSplitStrandIdentityError);

    // Stopping the strand clears the refusal: the ordinary not-live branch answers again.
    await node.stopStrand(strandId);
    await expect(issue(node, strandId)).rejects.toThrow(/runtime is\s+not live/);
  }, 60_000);
});
