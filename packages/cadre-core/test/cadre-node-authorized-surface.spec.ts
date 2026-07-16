import { describe, it, expect } from 'vitest';
import { CadreNode } from '../src/cadre-node.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Unit coverage for the addressable-vs-authorized membership surface split
 * (`membership-authorized-surface-split`). `listMembers`/`isMember` are the
 * ADDRESSABLE surface (self-published row included); `listAuthorizedMembers`/
 * `isAuthorizedMember` are the trust-facing surface (self excluded). The control-
 * network wake and strand-address gates consult the authorized surface.
 */

function createConfig(): CadreNodeConfig {
  return {
    controlNetwork: {
      partyId: 'authorized-surface-test-' + Math.random().toString(36).slice(2),
      bootstrapNodes: []
    },
    profile: 'transaction'
  };
}

type MemberRow = { peerId: string; multiaddr: string | null };

/** Wire the minimal control-node + DB fakes the membership reads touch. */
function inject(node: CadreNode, opts: { selfPeerId: string; members: MemberRow[] }): void {
  (node as unknown as { controlNode: unknown }).controlNode = {
    peerId: { toString: () => opts.selfPeerId }
  };
  (node as unknown as { controlDatabase: unknown }).controlDatabase = {
    queryCadrePeers: async () => opts.members
  };
}

describe('CadreNode addressable-vs-authorized surface', () => {
  const SELF = 'self-peer';
  const A = 'peer-A';
  const B = 'peer-B';

  it('listAuthorizedMembers excludes self while listMembers includes it', async () => {
    const node = new CadreNode(createConfig());
    inject(node, {
      selfPeerId: SELF,
      members: [
        { peerId: SELF, multiaddr: '/ip4/1.1.1.1/tcp/1' },
        { peerId: A, multiaddr: '/ip4/2.2.2.2/tcp/2' },
        { peerId: B, multiaddr: null }
      ]
    });

    expect((await node.listMembers()).map(m => m.peerId)).toEqual([SELF, A, B]);
    expect((await node.listAuthorizedMembers()).map(m => m.peerId)).toEqual([A, B]);
  });

  it('isMember(self) is true but isAuthorizedMember(self) is false', async () => {
    const node = new CadreNode(createConfig());
    inject(node, { selfPeerId: SELF, members: [{ peerId: SELF, multiaddr: null }, { peerId: A, multiaddr: null }] });

    expect(await node.isMember(SELF)).toBe(true);
    expect(await node.isAuthorizedMember(SELF)).toBe(false);
    expect(await node.isMember(A)).toBe(true);
    expect(await node.isAuthorizedMember(A)).toBe(true);
  });

  it('authorized set is empty when only the self row exists (fresh-party shape)', async () => {
    const node = new CadreNode(createConfig());
    inject(node, { selfPeerId: SELF, members: [{ peerId: SELF, multiaddr: '/ip4/1.1.1.1/tcp/1' }] });

    expect(await node.listAuthorizedMembers()).toEqual([]);
    expect(await node.isAuthorizedMember('any-stranger')).toBe(false);
  });
});
