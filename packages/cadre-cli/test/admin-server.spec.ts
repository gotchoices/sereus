import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminServer } from '../src/server/admin-server.js';
import type { CadreNode, CadreInvite, StrandRow, StrandStatus } from '@serfab/cadre-core';

/**
 * The closed strand's membership key, as it sits in the control row. Tests assert this
 * exact string never appears in a response body — it is stored nowhere else, so a leak
 * over the admin channel is a leak of the party's only copy.
 */
const CLOSED_STRAND_KEY = 'MEMBER-PRIVATE-KEY-DO-NOT-LEAK';

/**
 * A scriptable mock of the CadreNode surface the admin channel delegates to.
 * Records calls so tests can assert decoded arguments.
 */
class MockNode {
  calls: Array<{ method: string; args: unknown[] }> = [];
  pushedAddresses: string[] | null = null;
  multiaddrs = ['/ip4/127.0.0.1/tcp/4001'];
  members: Array<{ peerId: string; multiaddr: string | null }> = [
    { peerId: '12D3KooWMemberA', multiaddr: '/ip4/10.0.0.1/tcp/4001' },
  ];
  /** When true, owner methods throw the "not initialized" error. */
  seedUninitialized = false;
  /** When true, read methods throw an unclassifiable error (-> internal/500). */
  genericFailure = false;

  /** The control-database rows — the source of truth for the strands routes. */
  strandRows: StrandRow[] = [
    { Id: 'strand-open', MemberPrivateKey: null, Type: 'o' },
    { Id: 'strand-closed', MemberPrivateKey: CLOSED_STRAND_KEY, Type: 'c' },
  ];
  /** Instances this node is running, overlaid onto the rows by the list route. */
  strandInstances = new Map<string, { status: StrandStatus }>();
  /** When true, `getControlDatabase()` returns null (node never started). */
  noControlDatabase = false;
  /** When set, `unpublishStrand` rejects with this message. */
  unpublishError: string | null = null;
  controlConnections = 2;

  readonly partyId = 'party-xyz';
  get peerId() { return { toString: () => '12D3KooWSelf' }; }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  getMultiaddrs(): string[] { this.record('getMultiaddrs'); return this.multiaddrs; }

  async listMembers() {
    this.record('listMembers');
    if (this.genericFailure) {
      throw new Error('control database read failed: disk gone');
    }
    return this.members;
  }

  async isMember(peerId: string) { this.record('isMember', peerId); return this.members.some((m) => m.peerId === peerId); }

  async createInvite(token?: string, expiresInMs?: number) {
    this.record('createInvite', token, expiresInMs);
    if (this.seedUninitialized) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    const addrs = this.pushedAddresses ?? this.multiaddrs;
    const invite: CadreInvite = { partyId: this.partyId, ownerAddrs: addrs, token, createdAt: 1700000000000 };
    return { invite, encodedInvite: 'encoded-' + addrs.join('|') };
  }

  async acceptPhone(options: { phonePeerId: string; token?: string }, issuedInvite?: CadreInvite) {
    this.record('acceptPhone', options, issuedInvite);
    if (this.seedUninitialized) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
  }

  async removePeer(peerId: string) {
    this.record('removePeer', peerId);
    if (this.seedUninitialized) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
  }

  async addDrone(options: { dronePeerId: string; droneMultiaddrs: string[] }) {
    this.record('addDrone', options);
    if (this.seedUninitialized) {
      throw new Error('Seed bootstrap service not initialized. Call initializeSeedBootstrap() first.');
    }
    return { seed: { partyId: this.partyId, peers: [] }, encodedSeed: 'seed-' + options.dronePeerId };
  }

  setInviteAddresses(addresses: string[] | null) {
    this.record('setInviteAddresses', addresses);
    this.pushedAddresses = addresses;
  }

  getStrands() { return this.strandInstances; }

  getControlConnectionCount() { this.record('getControlConnectionCount'); return this.controlConnections; }

  getControlDatabase() {
    if (this.noControlDatabase) return null;
    return {
      queryStrands: async () => { this.record('queryStrands'); return this.strandRows; },
      queryStrand: async (strandId: string) => {
        this.record('queryStrand', strandId);
        return this.strandRows.find((r) => r.Id === strandId) ?? null;
      },
    };
  }

  async unpublishStrand(strandId: string) {
    this.record('unpublishStrand', strandId);
    if (this.unpublishError) {
      throw new Error(this.unpublishError);
    }
    this.strandRows = this.strandRows.filter((r) => r.Id !== strandId);
  }
}

const TOKEN = 'super-secret-token';

describe('AdminServer', () => {
  let server: AdminServer;
  let node: MockNode;
  let base: string;

  beforeEach(async () => {
    node = new MockNode();
    server = new AdminServer({ port: 0, token: TOKEN });
    server.attach(node as unknown as CadreNode);
    await server.start();
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.stop();
  });

  function auth(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${TOKEN}`, ...extra };
  }

  describe('authentication', () => {
    it('rejects requests with no bearer token (401 not_authorized)', async () => {
      const res = await fetch(`${base}/admin/identity`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toEqual({ ok: false, error: { code: 'not_authorized', message: expect.any(String) } });
    });

    it('rejects requests with a wrong bearer token', async () => {
      const res = await fetch(`${base}/admin/identity`, { headers: { authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('not_authorized');
    });

    it('accepts the correct bearer token', async () => {
      const res = await fetch(`${base}/admin/identity`, { headers: auth() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ ok: true, data: { peerId: '12D3KooWSelf', partyId: 'party-xyz' } });
    });

    it('returns 400 bad_request on malformed JSON bodies', async () => {
      const res = await fetch(`${base}/admin/invites`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: '{not json',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('bad_request');
    });
  });

  describe('read routes', () => {
    it('GET /admin/multiaddrs returns the node multiaddrs', async () => {
      const res = await fetch(`${base}/admin/multiaddrs`, { headers: auth() });
      const body = await res.json();
      expect(body.data).toEqual({ multiaddrs: ['/ip4/127.0.0.1/tcp/4001'] });
      expect(node.calls.some((c) => c.method === 'getMultiaddrs')).toBe(true);
    });

    it('GET /admin/members enumerates membership', async () => {
      const res = await fetch(`${base}/admin/members`, { headers: auth() });
      const body = await res.json();
      expect(body.data.members).toEqual(node.members);
    });

    it('GET /admin/members/:peerId probes membership (true/false)', async () => {
      const hit = await (await fetch(`${base}/admin/members/12D3KooWMemberA`, { headers: auth() })).json();
      expect(hit.data).toEqual({ member: true });
      const miss = await (await fetch(`${base}/admin/members/12D3KooWUnknown`, { headers: auth() })).json();
      expect(miss.data).toEqual({ member: false });
      expect(node.calls.filter((c) => c.method === 'isMember').map((c) => c.args[0]))
        .toEqual(['12D3KooWMemberA', '12D3KooWUnknown']);
    });
  });

  describe('owner routes', () => {
    it('POST /admin/invites mints an invite with decoded args', async () => {
      const res = await fetch(`${base}/admin/invites`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ token: 'inv-tok', expiresInMs: 60000 }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.invite.token).toBe('inv-tok');
      expect(body.data.encodedInvite).toMatch(/^encoded-/);
      const call = node.calls.find((c) => c.method === 'createInvite');
      expect(call?.args).toEqual(['inv-tok', 60000]);
    });

    it('POST /admin/invites accepts an empty body', async () => {
      const res = await fetch(`${base}/admin/invites`, { method: 'POST', headers: auth() });
      const body = await res.json();
      expect(body.ok).toBe(true);
      const call = node.calls.find((c) => c.method === 'createInvite');
      expect(call?.args).toEqual([undefined, undefined]);
    });

    it('POST /admin/accept-phone forwards peer id, token and invite', async () => {
      const issuedInvite: CadreInvite = { partyId: 'party-xyz', ownerAddrs: [], token: 't', createdAt: 1 };
      const res = await fetch(`${base}/admin/accept-phone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ phonePeerId: '12D3KooWPhone', token: 't', issuedInvite }),
      });
      const body = await res.json();
      expect(body).toEqual({ ok: true, data: { ok: true } });
      const call = node.calls.find((c) => c.method === 'acceptPhone');
      expect(call?.args[0]).toEqual({ phonePeerId: '12D3KooWPhone', token: 't' });
      expect(call?.args[1]).toEqual(issuedInvite);
    });

    it('POST /admin/accept-phone rejects a missing phonePeerId (400)', async () => {
      const res = await fetch(`${base}/admin/accept-phone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ token: 't' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });

    it('DELETE /admin/members/:peerId removes a peer', async () => {
      const res = await fetch(`${base}/admin/members/12D3KooWMemberA`, { method: 'DELETE', headers: auth() });
      const body = await res.json();
      expect(body).toEqual({ ok: true, data: { ok: true } });
      const call = node.calls.find((c) => c.method === 'removePeer');
      expect(call?.args).toEqual(['12D3KooWMemberA']);
    });

    it('maps "seed bootstrap not initialized" errors to 503 not_ready', async () => {
      node.seedUninitialized = true;
      const res = await fetch(`${base}/admin/invites`, { method: 'POST', headers: auth() });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe('not_ready');
    });
  });

  describe('add-drone route', () => {
    const drone = { dronePeerId: '12D3KooWDrone', droneMultiaddrs: ['/ip4/10.0.0.9/tcp/4001'] };

    it('POST /admin/add-drone forwards decoded args and returns the minted seed', async () => {
      const res = await fetch(`${base}/admin/add-drone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify(drone),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.encodedSeed).toBe('seed-12D3KooWDrone');
      expect(body.data.seed).toBeDefined();
      const call = node.calls.find((c) => c.method === 'addDrone');
      expect(call?.args[0]).toEqual(drone);
    });

    it('rejects a missing dronePeerId (400)', async () => {
      const res = await fetch(`${base}/admin/add-drone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ droneMultiaddrs: [] }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });

    it('rejects a non-array droneMultiaddrs (400)', async () => {
      const res = await fetch(`${base}/admin/add-drone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ dronePeerId: '12D3KooWDrone', droneMultiaddrs: 'nope' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });

    it('maps seed-bootstrap-not-initialized to 503 not_ready', async () => {
      node.seedUninitialized = true;
      const res = await fetch(`${base}/admin/add-drone`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify(drone),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe('not_ready');
    });
  });

  describe('invite-address push', () => {
    it('PUT /admin/invite-addresses pushes addresses embedded by the next invite', async () => {
      const pushed = ['/dns4/host.example/tcp/5000/p2p/12D3KooWHost'];
      const putRes = await fetch(`${base}/admin/invite-addresses`, {
        method: 'PUT',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ addresses: pushed }),
      });
      expect((await putRes.json())).toEqual({ ok: true, data: { ok: true } });
      expect(node.pushedAddresses).toEqual(pushed);

      const inviteRes = await fetch(`${base}/admin/invites`, { method: 'POST', headers: auth() });
      const inviteBody = await inviteRes.json();
      expect(inviteBody.data.invite.ownerAddrs).toEqual(pushed);
    });

    it('with no addresses pushed, the invite embeds getMultiaddrs()', async () => {
      const inviteRes = await fetch(`${base}/admin/invites`, { method: 'POST', headers: auth() });
      const inviteBody = await inviteRes.json();
      expect(inviteBody.data.invite.ownerAddrs).toEqual(node.multiaddrs);
    });

    it('rejects a non-array addresses payload (400)', async () => {
      const res = await fetch(`${base}/admin/invite-addresses`, {
        method: 'PUT',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify({ addresses: 'not-an-array' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });
  });

  it('rejects unknown routes with 400 bad_request', async () => {
    const res = await fetch(`${base}/admin/bogus`, { headers: auth() });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
  });

  describe('error classification & body handling', () => {
    it('maps an unclassifiable error to 500 internal', async () => {
      node.genericFailure = true;
      const res = await fetch(`${base}/admin/members`, { headers: auth() });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('internal');
      expect(body.error.message).toMatch(/disk gone/);
    });

    it('rejects a non-object JSON body (array) with 400 bad_request', async () => {
      const res = await fetch(`${base}/admin/invites`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: JSON.stringify(['not', 'an', 'object']),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });

    it('rejects an over-large request body with 400 bad_request', async () => {
      const huge = JSON.stringify({ token: 'x'.repeat(300 * 1024) });
      const res = await fetch(`${base}/admin/invites`, {
        method: 'POST',
        headers: auth({ 'content-type': 'application/json' }),
        body: huge,
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    });
  });

  describe('strands routes', () => {
    const url = (suffix = '') => `${base}/admin/strands${suffix}`;
    const unpublished = () => node.calls.filter((c) => c.method === 'unpublishStrand').map((c) => c.args[0]);
    const del = (suffix: string) => fetch(url(suffix), { method: 'DELETE', headers: auth() });

    describe('GET /admin/strands', () => {
      it('lists control rows, overlaying the running instances', async () => {
        node.strandInstances.set('strand-open', { status: 'active' });
        const res = await fetch(url(), { headers: auth() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data.strands).toEqual([
          { id: 'strand-open', type: 'o', running: true, status: 'active' },
          { id: 'strand-closed', type: 'c', running: false, status: null },
        ]);
      });

      it('never exposes MemberPrivateKey (field name or value)', async () => {
        node.strandInstances.set('strand-closed', { status: 'idle' });
        const raw = await (await fetch(url(), { headers: auth() })).text();
        expect(raw).not.toContain('MemberPrivateKey');
        expect(raw).not.toContain(CLOSED_STRAND_KEY);
      });

      it('reports the control connection count from the node accessor', async () => {
        node.controlConnections = 3;
        const body = await (await fetch(url(), { headers: auth() })).json();
        expect(body.data.controlConnections).toBe(3);
      });

      it('does not force a strand poll (side-effect free)', async () => {
        await fetch(url(), { headers: auth() });
        expect(node.calls.some((c) => c.method === 'forceStrandPoll')).toBe(false);
      });

      it('answers 503 not_ready when the node has no control database', async () => {
        node.noControlDatabase = true;
        const res = await fetch(url(), { headers: auth() });
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('not_ready');
      });

      it('with an id is not a route (400 bad_request)', async () => {
        const res = await fetch(url('/strand-open'), { headers: auth() });
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('bad_request');
      });

      it('requires a bearer token (401)', async () => {
        const res = await fetch(url());
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('not_authorized');
      });
    });

    describe('DELETE /admin/strands/:id', () => {
      it('removes an open strand without confirmation', async () => {
        const res = await del('/strand-open');
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual({
          strandId: 'strand-open', published: true, type: 'o', removed: true, alone: false,
        });
        expect(unpublished()).toEqual(['strand-open']);
      });

      it('accepts and ignores confirm on an open strand', async () => {
        const res = await del('/strand-open?confirm=1');
        expect(res.status).toBe(200);
        expect((await res.json()).data.removed).toBe(true);
        expect(unpublished()).toEqual(['strand-open']);
      });

      it('refuses a closed strand without confirm (428) and writes NOTHING', async () => {
        const res = await del('/strand-closed');
        expect(res.status).toBe(428);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error.code).toBe('confirmation_required');
        expect(unpublished()).toEqual([]);
      });

      it.each(['1', 'true'])('removes a closed strand with confirm=%s', async (value) => {
        const res = await del(`/strand-closed?confirm=${value}`);
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({
          strandId: 'strand-closed', published: true, type: 'c', removed: true, alone: false,
        });
        expect(unpublished()).toEqual(['strand-closed']);
      });

      it.each(['yes', '', '0', 'on', 'TRUE'])(
        'treats confirm=%s as unconfirmed (428, no write)',
        async (value) => {
          const res = await del(`/strand-closed?confirm=${value}`);
          expect(res.status).toBe(428);
          expect((await res.json()).error.code).toBe('confirmation_required');
          expect(unpublished()).toEqual([]);
        }
      );

      it('answers 200 published:false for an absent id, without writing', async () => {
        const res = await del('/never-published');
        expect(res.status).toBe(200);
        expect((await res.json()).data).toEqual({
          strandId: 'never-published', published: false, type: null, removed: false, alone: false,
        });
        expect(unpublished()).toEqual([]);
      });

      it('rejects a blank id before any read (400 bad_request)', async () => {
        const res = await del('/%20%20');
        expect(res.status).toBe(400);
        expect((await res.json()).error.code).toBe('bad_request');
        expect(node.calls.some((c) => c.method === 'queryStrand')).toBe(false);
      });

      it('rejects an id containing a slash, naming the limitation (400)', async () => {
        const res = await del('/a/b');
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.code).toBe('bad_request');
        expect(body.error.message).toMatch(/cadre strand remove/);
        expect(unpublished()).toEqual([]);
      });

      it('reports alone:true when the node has no control connections', async () => {
        node.controlConnections = 0;
        const body = await (await del('/strand-open')).json();
        expect(body.data.alone).toBe(true);
      });

      it('answers 503 not_ready when the node has no control database', async () => {
        node.noControlDatabase = true;
        const res = await del('/strand-open');
        expect(res.status).toBe(503);
        expect((await res.json()).error.code).toBe('not_ready');
      });

      it('surfaces an unpublish rejection message intact (500 internal)', async () => {
        node.unpublishError = 'Strand.AuthorizedDelete rejected the write: signer is not an enrolled owner';
        const res = await del('/strand-open');
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.error.code).toBe('internal');
        expect(body.error.message).toMatch(/not an enrolled owner/);
      });

      it('never exposes MemberPrivateKey in the removal body', async () => {
        const raw = await (await del('/strand-closed?confirm=1')).text();
        expect(raw).not.toContain('MemberPrivateKey');
        expect(raw).not.toContain(CLOSED_STRAND_KEY);
      });

      it('requires a bearer token (401)', async () => {
        const res = await fetch(url('/strand-open'), { method: 'DELETE' });
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('not_authorized');
        expect(unpublished()).toEqual([]);
      });
    });
  });

  it('requires a non-empty token at construction', () => {
    expect(() => new AdminServer({ port: 0, token: '' })).toThrow(/token/);
  });
});
