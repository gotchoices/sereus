import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig, StrandMembershipInvite } from '../src/types.js';
import type { StartStrandConfig } from '../src/strand-instance-manager.js';

/**
 * Unit coverage for `launchStrand`'s membership-invitation seam: the
 * `pendingMembershipInvite` hooks passed to `StrandInstanceManager.startStrand`
 * must be LIVE views over `CadreNode`'s in-memory `pendingMembershipInvites`
 * cache — `get` reads the entry staged at formation (including one staged AFTER
 * launch, since the reconciler reads per pass), and `clear` is the invalidation
 * the cache itself deliberately does not own. Sibling of
 * `cadre-node-strand-launch-key.spec.ts`, same fake-manager harness; what the
 * reconciler does with the hooks is covered in its own spec.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'membership-hooks-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

/** Records every `startStrand` config without booting a real libp2p node. */
function injectFakeStrandManager(node: CadreNode): { configs: StartStrandConfig[] } {
  const configs: StartStrandConfig[] = [];
  (node as unknown as { strandManager: unknown }).strandManager = {
    getInstance: () => undefined,
    startStrand: async (config: StartStrandConfig) => {
      configs.push(config);
      return {
        strandId: config.strandRow.Id,
        status: 'active',
        connectedPeers: 0,
        lastActivity: new Date(0),
        latencyHint: config.defaultLatencyHint
      };
    }
  };
  return { configs };
}

/** Stage an invitation the way `adoptFormationMembershipInvite` does (map write only). */
function stageInvite(node: CadreNode, strandId: string, invite: StrandMembershipInvite): void {
  (node as unknown as { pendingMembershipInvites: Map<string, StrandMembershipInvite> })
    .pendingMembershipInvites.set(strandId, invite);
}

function launchStrand(node: CadreNode, strandId: string): Promise<unknown> {
  return (node as unknown as {
    launchStrand(strand: { Id: string; MemberPrivateKey: string | null; Type: 'o' | 'c' }, sAppConfig: unknown): Promise<unknown>;
  }).launchStrand(
    { Id: strandId, MemberPrivateKey: null, Type: 'c' },
    { id: 'sapp-author', version: '1.0.0', schema: '' }
  );
}

const invite: StrandMembershipInvite = { inviteKey: 'invite-pub', invitePrivateKey: 'invite-priv' };

describe('CadreNode.launchStrand membership-invitation hooks', () => {
  it('get() reads the entry staged for THIS strand, live — including one staged after launch', async () => {
    const node = new CadreNode(createConfig());
    const { configs } = injectFakeStrandManager(node);

    await launchStrand(node, 'strand-a');
    const hooks = configs[0]!.pendingMembershipInvite!;
    expect(hooks.get()).toBeUndefined();

    // A re-formation staging a fresh invitation AFTER launch is visible on the
    // next reconcile pass — the hook is a live view, not a captured snapshot.
    stageInvite(node, 'strand-a', invite);
    expect(hooks.get()).toEqual(invite);
    expect(node.getPendingMembershipInvite('strand-a')).toEqual(invite);
  });

  it('clear() deletes exactly this strand\'s entry from the shared cache', async () => {
    const node = new CadreNode(createConfig());
    const { configs } = injectFakeStrandManager(node);
    stageInvite(node, 'strand-a', invite);
    stageInvite(node, 'strand-b', { inviteKey: 'other-pub', invitePrivateKey: 'other-priv' });

    await launchStrand(node, 'strand-a');
    configs[0]!.pendingMembershipInvite!.clear();

    expect(node.getPendingMembershipInvite('strand-a')).toBeUndefined();
    expect(node.getPendingMembershipInvite('strand-b')).toBeDefined();
  });
});
