import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';

import { AuthorityNodeClient, AuthorityNodeUnavailableError } from '../authority-node-client.js';
import type { AuthorityAdminEndpoint } from '../../orchestrator/index.js';

/**
 * Stub HTTP server matching the 6.6 admin contract. Records the last request
 * so tests can assert method/path/headers/body, and lets each test choose the
 * response.
 */
interface Recorded {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

const TOKEN = 'secret-bearer-token';

let server: http.Server;
let baseUrl: string;
let last: Recorded | null;
let responder: (req: Recorded) => { status: number; payload: unknown };

beforeEach(async () => {
  last = null;
  responder = () => ({ status: 200, payload: { ok: true, data: { ok: true } } });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const rec: Recorded = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        auth: req.headers['authorization'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      last = rec;
      const { status, payload } = responder(rec);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeClient(): AuthorityNodeClient {
  const endpoint: AuthorityAdminEndpoint = { baseUrl, token: TOKEN };
  return new AuthorityNodeClient(endpoint);
}

describe('AuthorityNodeClient', () => {
  it('createInvite POSTs /admin/invites with bearer + body and unwraps data', async () => {
    responder = () => ({
      status: 200,
      payload: { ok: true, data: { invite: { partyId: 'p', authorityAddrs: [], token: 't', createdAt: 1 }, encodedInvite: 'enc' } },
    });
    const client = makeClient();
    const result = await client.createInvite('t', 60_000);

    expect(result.encodedInvite).toBe('enc');
    expect(last?.method).toBe('POST');
    expect(last?.path).toBe('/admin/invites');
    expect(last?.auth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(last!.body)).toEqual({ token: 't', expiresInMs: 60_000 });
  });

  it('acceptPhone POSTs /admin/accept-phone', async () => {
    const client = makeClient();
    await client.acceptPhone({ phonePeerId: '12D3KooWX', token: 't' }, { partyId: 'p', authorityAddrs: [], token: 't', createdAt: 1 });
    expect(last?.method).toBe('POST');
    expect(last?.path).toBe('/admin/accept-phone');
    const body = JSON.parse(last!.body);
    expect(body.phonePeerId).toBe('12D3KooWX');
    expect(body.issuedInvite.token).toBe('t');
  });

  it('removePeer DELETEs /admin/members/:peerId (url-encoded)', async () => {
    const client = makeClient();
    await client.removePeer('12D3KooWMember');
    expect(last?.method).toBe('DELETE');
    expect(last?.path).toBe('/admin/members/12D3KooWMember');
  });

  it('listMembers GETs /admin/members and returns the array', async () => {
    responder = () => ({ status: 200, payload: { ok: true, data: { members: [{ peerId: 'a', multiaddr: '/ip4/1.2.3.4/tcp/1' }] } } });
    const client = makeClient();
    const members = await client.listMembers();
    expect(last?.method).toBe('GET');
    expect(last?.path).toBe('/admin/members');
    expect(members).toEqual([{ peerId: 'a', multiaddr: '/ip4/1.2.3.4/tcp/1' }]);
  });

  it('isMember GETs /admin/members/:peerId and returns the boolean', async () => {
    responder = () => ({ status: 200, payload: { ok: true, data: { member: true } } });
    const client = makeClient();
    expect(await client.isMember('peer-1')).toBe(true);
    expect(last?.path).toBe('/admin/members/peer-1');
  });

  it('getPeerId GETs /admin/identity', async () => {
    responder = () => ({ status: 200, payload: { ok: true, data: { peerId: '12D3KooWHost', partyId: 'party' } } });
    const client = makeClient();
    expect(await client.getPeerId()).toBe('12D3KooWHost');
    expect(last?.path).toBe('/admin/identity');
  });

  it('getMultiaddrs GETs /admin/multiaddrs', async () => {
    responder = () => ({ status: 200, payload: { ok: true, data: { multiaddrs: ['/ip4/0.0.0.0/tcp/4001'] } } });
    const client = makeClient();
    expect(await client.getMultiaddrs()).toEqual(['/ip4/0.0.0.0/tcp/4001']);
    expect(last?.path).toBe('/admin/multiaddrs');
  });

  it('pushInviteAddresses PUTs /admin/invite-addresses', async () => {
    const client = makeClient();
    await client.pushInviteAddresses(['/dns4/h/tcp/1/p2p/x']);
    expect(last?.method).toBe('PUT');
    expect(last?.path).toBe('/admin/invite-addresses');
    expect(JSON.parse(last!.body)).toEqual({ addresses: ['/dns4/h/tcp/1/p2p/x'] });
  });

  it('encodeInvite mirrors cadre-core base64url(JSON)', () => {
    const client = makeClient();
    const invite = { partyId: 'p', authorityAddrs: [], token: 't', createdAt: 1 };
    const encoded = client.encodeInvite(invite);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    expect(decoded).toEqual(invite);
  });

  it('maps a non-2xx response to AuthorityNodeUnavailableError carrying the code', async () => {
    responder = () => ({ status: 503, payload: { ok: false, error: { code: 'not_ready', message: 'node booting' } } });
    const client = makeClient();
    await expect(client.getPeerId()).rejects.toBeInstanceOf(AuthorityNodeUnavailableError);
    await expect(client.getPeerId()).rejects.toMatchObject({ nodeCode: 'not_ready' });
  });

  it('maps a refused connection to AuthorityNodeUnavailableError', async () => {
    // Bind a throwaway server to claim a port, then close it so the address
    // is guaranteed refused.
    const tmp = http.createServer();
    const closedPort = await new Promise<number>((resolve) => {
      tmp.listen(0, '127.0.0.1', () => {
        const a = tmp.address();
        resolve(typeof a === 'object' && a ? a.port : 0);
      });
    });
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const client = new AuthorityNodeClient({ baseUrl: `http://127.0.0.1:${closedPort}`, token: TOKEN });
    await expect(client.getPeerId()).rejects.toBeInstanceOf(AuthorityNodeUnavailableError);
  });

  it('throws AuthorityNodeUnavailableError when the endpoint is undefined', async () => {
    const client = new AuthorityNodeClient(() => undefined);
    await expect(client.getPeerId()).rejects.toBeInstanceOf(AuthorityNodeUnavailableError);
  });
});
