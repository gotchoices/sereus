import { describe, it, expect } from 'vitest';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import type { ControlDatabase } from '../src/control-database.js';

/**
 * Verifies the push-model invite-address resolver: `setInviteAddresses`
 * overrides the libp2p-observed multiaddrs that `createInvite` embeds, and
 * clearing it (null) reverts to `getMultiaddrs()`.
 *
 * Drives a real CadreNode with its libp2p node + control database stubbed so
 * `initializeSeedBootstrap` / `createInvite` run without a live network.
 */
describe('CadreNode invite-address push model', () => {
  function makeNode(libp2pMultiaddrs: string[]): CadreNode {
    const node = new CadreNode({
      controlNetwork: { partyId: 'push-test', bootstrapNodes: [] },
      profile: 'transaction',
    });

    const mockLibp2p = {
      peerId: { toString: () => '12D3KooWPushTestPeer' },
      getMultiaddrs: () => libp2pMultiaddrs.map((a) => ({ toString: () => a })),
      handle: async () => {},
      unhandle: async () => {},
    };

    // Stub the internals normally set during start(). createInvite reads the
    // AuthorityKey table to populate invite.authorityKeys, so expose that.
    (node as unknown as { controlNode: unknown }).controlNode = mockLibp2p;
    (node as unknown as { controlDatabase: ControlDatabase }).controlDatabase = {
      getAuthorityKeys: async () => new Set<string>(),
    } as unknown as ControlDatabase;

    return node;
  }

  it('embeds libp2p getMultiaddrs() when nothing has been pushed', async () => {
    const node = makeNode(['/ip4/192.168.1.10/tcp/4001']);
    const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(authorityPrivateKey);

    const { invite } = await node.createInvite();
    expect(invite.authorityAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
  });

  it('embeds pushed addresses after setInviteAddresses', async () => {
    const node = makeNode(['/ip4/192.168.1.10/tcp/4001']);
    const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(authorityPrivateKey);

    node.setInviteAddresses(['/dns4/home.duckdns.org/tcp/5000/p2p/12D3KooWHost']);

    const { invite } = await node.createInvite();
    expect(invite.authorityAddrs).toEqual(['/dns4/home.duckdns.org/tcp/5000/p2p/12D3KooWHost']);
  });

  it('reverts to libp2p getMultiaddrs() when pushed addresses are cleared', async () => {
    const node = makeNode(['/ip4/192.168.1.10/tcp/4001']);
    const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(authorityPrivateKey);

    node.setInviteAddresses(['/dns4/home.duckdns.org/tcp/5000']);
    node.setInviteAddresses(null);

    const { invite } = await node.createInvite();
    expect(invite.authorityAddrs).toEqual(['/ip4/192.168.1.10/tcp/4001']);
  });

  it('treats an empty pushed array as an explicit override (not a fallback)', async () => {
    const node = makeNode(['/ip4/192.168.1.10/tcp/4001']);
    const authorityPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    node.initializeSeedBootstrap(authorityPrivateKey);

    node.setInviteAddresses([]);

    const { invite } = await node.createInvite();
    expect(invite.authorityAddrs).toEqual([]);
  });
});
