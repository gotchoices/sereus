import { describe, it, expect } from 'vitest';
import { generatePrivateKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { ed25519PublicKeyFromPrivate } from '../src/ed25519-key.js';
import type { ControlDatabase } from '../src/control-database.js';
import type { CadreInviteRow } from '../src/types.js';
import { anchorWith } from './membership-gate-helpers.js';

/**
 * Verifies the push-model invite-address resolver: `setInviteAddresses`
 * overrides the libp2p-observed multiaddrs that `createCadreInvitation` names
 * as this machine's own, and clearing it (null) reverts to `getMultiaddrs()`.
 *
 * Drives a real CadreNode with its libp2p node + control database stubbed so
 * `initializeSeedBootstrap` / `createCadreInvitation` run without a live
 * network. The party has no other machine, so the bundle's `members` list is
 * exactly what the resolver answered.
 */
describe('CadreNode invite-address push model', () => {
  const PARTY_ID = 'push-test';

  async function makeNode(libp2pMultiaddrs: string[]): Promise<CadreNode> {
    const node = new CadreNode({
      controlNetwork: { partyId: PARTY_ID, bootstrapNodes: [] },
      profile: 'transaction',
    });

    const mockLibp2p = {
      peerId: { toString: () => '12D3KooWPushTestPeer' },
      getMultiaddrs: () => libp2pMultiaddrs.map((a) => ({ toString: () => a })),
      getConnections: () => [],
      handle: async () => {},
      unhandle: async () => {},
    };

    // Stub the internals normally set during start(). The mint signs a row
    // through the control database and reads the node-local anchor for the
    // bundle's owner keys; neither needs a live network.
    (node as unknown as { controlNode: unknown }).controlNode = mockLibp2p;
    (node as unknown as { controlDatabase: ControlDatabase }).controlDatabase = {
      insertCadreInvite: async (invite: Record<string, unknown>): Promise<Partial<CadreInviteRow>> => ({
        ...invite, issuerKey: 'owner', issuerSig: 'sig', stampId: 'stamp', expiresAt: '2030-01-01T00:00:00',
      }),
    } as unknown as ControlDatabase;
    // Alone in its party: no sibling addresses join the resolver's answer.
    (node as unknown as { listAuthorizedMembers: () => Promise<unknown[]> }).listAuthorizedMembers = async () => [];

    const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
    (node as unknown as { trustedOwnerStore: unknown }).trustedOwnerStore =
      await anchorWith(PARTY_ID, ed25519PublicKeyFromPrivate(ownerPrivateKey));
    await node.initializeSeedBootstrap(ownerPrivateKey);
    return node;
  }

  async function mintedMembers(node: CadreNode): Promise<string[]> {
    return (await node.createCadreInvitation({ grantsOwner: false })).invitation.members;
  }

  it('names libp2p getMultiaddrs() when nothing has been pushed', async () => {
    const node = await makeNode(['/ip4/192.168.1.10/tcp/4001']);

    expect(await mintedMembers(node)).toEqual(['/ip4/192.168.1.10/tcp/4001']);
  });

  it('names pushed addresses after setInviteAddresses', async () => {
    const node = await makeNode(['/ip4/192.168.1.10/tcp/4001']);

    node.setInviteAddresses(['/dns4/home.duckdns.org/tcp/5000/p2p/12D3KooWHost']);

    expect(await mintedMembers(node)).toEqual(['/dns4/home.duckdns.org/tcp/5000/p2p/12D3KooWHost']);
  });

  it('reverts to libp2p getMultiaddrs() when pushed addresses are cleared', async () => {
    const node = await makeNode(['/ip4/192.168.1.10/tcp/4001']);

    node.setInviteAddresses(['/dns4/home.duckdns.org/tcp/5000']);
    node.setInviteAddresses(null);

    expect(await mintedMembers(node)).toEqual(['/ip4/192.168.1.10/tcp/4001']);
  });

  it('appends the node own-peer suffix, and passes an unparsable entry through', async () => {
    // Both app-supplied hooks take arbitrary strings, and whatever they return
    // lands in this node's published CadrePeer row — one unsuffixed entry there
    // gives every sibling a list `libp2p.dial` refuses. Normalizing on the way in
    // means neither hook has to know the rule. An entry that does not parse is a
    // pass-through, not a drop: publication does not police validity, and
    // `resolvePeerAddrs` drops it on the read side.
    const node = await makeNode(['/ip4/192.168.1.10/tcp/4001']);

    node.setInviteAddresses(['/dns4/home.duckdns.org/tcp/5000', 'not-a-multiaddr']);

    expect(await mintedMembers(node)).toEqual([
      '/dns4/home.duckdns.org/tcp/5000/p2p/12D3KooWPushTestPeer',
      'not-a-multiaddr',
    ]);
  });

  it('treats an empty pushed array as an explicit override (not a fallback)', async () => {
    const node = await makeNode(['/ip4/192.168.1.10/tcp/4001']);

    node.setInviteAddresses([]);

    // Nothing to name: the mint refuses rather than falling back to libp2p's addresses.
    await expect(node.createCadreInvitation({ grantsOwner: false })).rejects.toThrow(/no.*address/i);
  });
});
