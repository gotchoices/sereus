import { describe, it, expect } from 'vitest';
import type { DroneInitResult, SeedPeer } from '@serfab/cadre-core';
import type { AdminConnection, AdminFetch } from '../src/commands/admin-client.js';
import { buildEnrollAddReport, describeAdminFailure, mintSeed } from '../src/commands/enroll-add.js';
import { decodeSeedFor } from '../src/commands/start.js';

const NEW_PEER = '12D3KooWNewMachine';
const OWNER_ADDR = '/ip4/192.168.1.10/tcp/4001/p2p/12D3KooWOwner';

function minted(peers: SeedPeer[]): DroneInitResult {
  return {
    seed: { partyId: 'party-a', peers, signature: 'sig', signerKey: 'owner-key' },
    encodedSeed: 'encoded-seed',
  };
}

describe('buildEnrollAddReport', () => {
  const newPeer: SeedPeer = { peerId: NEW_PEER, multiaddrs: ['/ip4/10.0.0.9/tcp/4001'], isOwner: false };
  const unaddressedOwner: SeedPeer = { peerId: '12D3KooWOwner', multiaddrs: [], isOwner: true };

  // The one real branch in the report: a seed whose owners carry no address, with no --addr
  // for the owner to dial out on, leaves neither machine able to reach the other. The new
  // machine's own address must not count as an owner address.
  it('lists owner addresses, and warns only when neither side has anything to dial', () => {
    const reachable = buildEnrollAddReport(
      minted([{ ...unaddressedOwner, multiaddrs: [OWNER_ADDR] }, newPeer]), NEW_PEER, false
    );
    expect(reachable).toMatchObject({ partyId: 'party-a', signerKey: 'owner-key', ownerAddrs: [OWNER_ADDR], warnings: [] });

    const stranded = buildEnrollAddReport(minted([unaddressedOwner, newPeer]), NEW_PEER, false);
    expect(stranded.ownerAddrs).toEqual([]);
    expect(stranded.warnings).toHaveLength(1);
    expect(stranded.warnings[0]).toMatch(/appendAnnounceAddrs/);
    expect(stranded.warnings[0]).toMatch(/--addr/);

    expect(buildEnrollAddReport(minted([unaddressedOwner, newPeer]), NEW_PEER, true).warnings).toEqual([]);
  });
});

describe('describeAdminFailure', () => {
  function connection(fetch: AdminFetch): AdminConnection {
    return { baseUrl: 'http://127.0.0.1:7070', token: 'token', fetch, timeoutMs: 1000 };
  }

  function answering(status: number, code: string, message: string): AdminFetch {
    return async () => ({ ok: false, status, json: async () => ({ ok: false, error: { code, message } }) });
  }

  const refused: AdminFetch = () =>
    Promise.reject(new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:7070') }));

  // Each failure an operator can cause names its fix; a code this command has no advice for
  // still reaches them verbatim.
  it.each([
    ['nothing listening', refused, /ECONNREFUSED[\s\S]*--admin-port 7070/],
    ['a wrong token', answering(401, 'not_authorized', 'Missing or invalid bearer token'), /CADRE_STARTUP_TOKEN/],
    ['a node not run as owner', answering(503, 'not_ready', 'Seed bootstrap service not initialized'), /--owner/],
    ['an unrecognised refusal', answering(500, 'internal', 'disk full'), /\[internal\]: disk full/],
  ])('%s', async (_case, fetch, expected) => {
    const failure: unknown = await mintSeed(connection(fetch), NEW_PEER, []).catch((err: unknown) => err);
    expect(describeAdminFailure(failure, 7070)).toMatch(expected);
  });
});

describe('decodeSeedFor', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

  // The joining side's only party check: `applySeed` never compares the seed's party with the
  // config's, so a seed minted by another party's owner must stop start-up here.
  it.each([
    ['a seed for this party', encode(minted([]).seed), undefined],
    ['a seed for another party', encode({ ...minted([]).seed, partyId: 'party-b' }), /minted for party party-b.*names party party-a/],
    ['a seed naming no party', encode({ peers: [] }), /names no party/],
    ['text that is not a seed', 'not-a-seed', /does not decode/],
  ])('%s', (_case, encoded, refusal) => {
    const decode = (): unknown => decodeSeedFor(encoded, 'party-a');
    if (refusal === undefined) {
      expect(decode()).toMatchObject({ partyId: 'party-a' });
    } else {
      expect(decode).toThrow(refusal);
    }
  });
});
