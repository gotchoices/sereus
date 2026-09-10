/**
 * The provider's `bootstrapNodes` rule — the control-network addresses a created
 * container is started with — exercised directly, and through `POST /containers`.
 *
 * The first suite is one half of a **manual tripwire**: cadre-host carries a
 * byte-identical copy of this rule (`packages/cadre-host/src/server/routes/bootstrap-node-validation.ts`)
 * and the table below is the same table
 * `packages/cadre-host/src/server/__tests__/bootstrap-node-validation.test.ts`
 * pins that copy to. Neither suite can observe the other package — nothing here
 * imports cadre-host — so this does not detect a change made over there; what it
 * does is fail if *this* copy is changed, which is how an editor is landed on the
 * comment pointing at the other one.
 *
 * The second suite is the route contract the whole thing exists for: a bad address
 * is a 400 naming the offending entry, with nothing provisioned — rather than a
 * 201 followed by a container that dies at boot or comes up permanently alone.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import { validateBootstrapNodes } from '../bootstrap-node-validation.js';

/**
 * A real, decodable peer id. Placeholder strings like `12D3KooReq` look right and
 * are not: `peerIdFromString` throws `Incorrect length` on them, which is exactly
 * the typo this rule exists to catch.
 */
const PEER = '12D3KooWA9hbnKrRnPRSPTRkzXqTHzGE8YpJ3JHZmQ5tGwLRTMmp';
const GOOD = `/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`;
/** A second, distinct dialable address, for "which entry was bad" assertions. */
const GOOD_2 = `/dns4/bootstrap.example/tcp/443/wss/p2p/${PEER}`;

describe('validateBootstrapNodes (the provider copy of the address rule)', () => {
  function errorOf(value: unknown): string {
    const result = validateBootstrapNodes(value);
    if (!('error' in result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    return result.error;
  }

  it('accepts a dialable address and returns it trimmed', () => {
    expect(validateBootstrapNodes([`  ${GOOD}\n`])).toEqual({ nodes: [GOOD] });
  });

  it('accepts several dialable addresses across transports', () => {
    expect(validateBootstrapNodes([GOOD, GOOD_2])).toEqual({ nodes: [GOOD, GOOD_2] });
  });

  it('accepts a relayed address whose relay and target peer ids both decode', () => {
    const relayed = `/ip4/1.2.3.4/tcp/4001/p2p/${PEER}/p2p-circuit/p2p/${PEER}`;
    expect(validateBootstrapNodes([relayed])).toEqual({ nodes: [relayed] });
  });

  it('treats an absent field and an empty list alike: the field is required', () => {
    expect(errorOf(undefined)).toBe('bootstrapNodes is required');
    expect(errorOf([])).toBe('bootstrapNodes is required');
  });

  it('rejects a non-array, and an array with a non-string element', () => {
    expect(errorOf(GOOD)).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf(null)).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf([42])).toBe('bootstrapNodes must be an array of strings');
    expect(errorOf([GOOD, { addr: GOOD }])).toBe('bootstrapNodes must be an array of strings');
  });

  it('rejects an empty or whitespace-only entry with the blank-value message', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(errorOf([blank])).toMatch(/must not be empty or whitespace-only/);
    }
  });

  // Case 1: `@libp2p/bootstrap` maps `multiaddr()` over the list before filtering,
  // so this one throws during libp2p construction and the child never starts.
  it('rejects a string that is not a multiaddr, naming it', () => {
    for (const bad of ['not-an-address', '42', 'bootstrap.example:4001']) {
      const message = errorOf([bad]);
      expect(message).toMatch(/must be multiaddrs/);
      expect(message).toContain(bad);
    }
  });

  // Case 2: the quiet one — parses, then gets filtered out inside the child and
  // the node comes up healthy-looking with zero bootstrap peers.
  it('rejects a valid multiaddr with no /p2p/ component, naming it', () => {
    const message = errorOf(['/ip4/127.0.0.1/tcp/4001']);
    expect(message).toMatch(/must include a \/p2p\/<peerId> component/);
    expect(message).toContain('/ip4/127.0.0.1/tcp/4001');
  });

  // Case 3: `multiaddr()` does not validate the /p2p/ value; `peerIdFromString`
  // does, and throws inside the child's libp2p construction.
  it('rejects a /p2p/ component whose peer id does not decode, naming the entry and the id', () => {
    const bad = '/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq';
    const message = errorOf([bad]);
    expect(message).toMatch(/must carry a decodable peer id/);
    expect(message).toContain(bad);
    expect(message).toContain('12D3KooReq');
  });

  it('rejects a relayed address whose relay peer id does not decode', () => {
    expect(errorOf([`/ip4/1.2.3.4/tcp/4001/p2p/12D3KooReq/p2p-circuit/p2p/${PEER}`]))
      .toMatch(/must carry a decodable peer id/);
  });

  it('names the offending entry when only one address in a batch is bad', () => {
    const message = errorOf([GOOD, '/ip4/10.0.0.9/tcp/4001', GOOD_2]);
    expect(message).toContain('/ip4/10.0.0.9/tcp/4001');
  });

  // A caller must not be able to turn one junk string into a megabyte of log line.
  it('caps the echoed value for an over-long rejected address', () => {
    const message = errorOf([`/ip4/1.2.3.4/tcp/${'9'.repeat(5000)}`]);
    expect(message).toContain('chars)');
    expect(message.length).toBeLessThan(400);
  });
});

async function makeServer(): Promise<ProviderServer> {
  const config: ProviderConfig = {
    ...DEFAULT_CONFIG,
    server: { ...DEFAULT_CONFIG.server, port: 0 },
    auth: { mode: 'none', allowInsecureNoAuth: true },
    docker: { ...DEFAULT_CONFIG.docker, socketPath: undefined as unknown as string },
    billing: { enabled: false },
    storage: { type: 'memory' },
  };
  const server = await createProviderServer({
    config,
    orchestrator: new MockOrchestrator(),
    store: new MemoryStore(),
    exitFn: () => {},
  });
  await server.app.ready();
  return server;
}

function post(server: ProviderServer, payload: Record<string, unknown>) {
  return server.app.inject({ method: 'POST', url: '/api/v1/containers', payload });
}

describe('POST /containers request validation', () => {
  it('accepts a dialable bootstrapNodes list', async () => {
    const server = await makeServer();
    const res = await post(server, { partyId: 'party-1', bootstrapNodes: [GOOD] });
    expect(res.statusCode).toBe(201);
    await server.stop();
  });

  it('rejects a bad bootstrapNodes entry with a 400 naming it', async () => {
    const server = await makeServer();
    const res = await post(server, { partyId: 'party-1', bootstrapNodes: [GOOD, 'not-an-address'] });

    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('not-an-address');
    await server.stop();
  });

  it('provisions nothing for any of the unusable-address shapes', async () => {
    const server = await makeServer();
    const bad: unknown[] = [
      [42],
      ['not-an-address'],
      ['/ip4/127.0.0.1/tcp/4001'],
      [`/ip4/127.0.0.1/tcp/4001/p2p/12D3KooReq`],
      [''],
      [],
    ];
    for (const bootstrapNodes of bad) {
      const res = await post(server, { partyId: 'party-1', bootstrapNodes });
      expect(res.statusCode, `expected 400 for ${JSON.stringify(bootstrapNodes)}`).toBe(400);
    }

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect((list.json() as { data: { containers: unknown[] } }).data.containers).toHaveLength(0);
    await server.stop();
  });

  // `if (!body.partyId)` was a truthiness test, so `partyId: 42` was answered 201
  // and became the characters `42` in CADRE_PARTY_ID (an object, `[object Object]`).
  it('rejects a non-string partyId, matching cadre-host’s check', async () => {
    const server = await makeServer();
    for (const partyId of [42, { id: 'party-1' }, ['party-1'], true, '   ']) {
      const res = await post(server, { partyId, bootstrapNodes: [GOOD] });
      expect(res.statusCode, `expected 400 for partyId ${JSON.stringify(partyId)}`).toBe(400);
      expect((res.json() as { error: { message: string } }).error.message).toBe('partyId is required');
    }
    await server.stop();
  });

  it('rejects an unknown profile rather than passing it to the child', async () => {
    const server = await makeServer();
    const res = await post(server, { partyId: 'party-1', bootstrapNodes: [GOOD], profile: 'archive' });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message)
      .toBe('profile must be "storage" or "transaction"');
    await server.stop();
  });

  it('rejects wrong-typed optional fields that would otherwise reach the container', async () => {
    const server = await makeServer();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ strandFilter: 42 }, 'strandFilter must be a string'],
      [{ resources: 'big' }, 'resources must be an object'],
      [{ resources: { memoryLimit: 512 } }, 'resources.memoryLimit must be a string'],
      [{ resources: { storageQuotaBytes: '1GB' } }, 'resources.storageQuotaBytes must be a finite number'],
      [{ tags: { env: 3 } }, 'tags must be an object of strings'],
    ];
    for (const [extra, message] of cases) {
      const res = await post(server, { partyId: 'party-1', bootstrapNodes: [GOOD], ...extra });
      expect(res.statusCode, `expected 400 for ${JSON.stringify(extra)}`).toBe(400);
      expect((res.json() as { error: { message: string } }).error.message).toBe(message);
    }

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect((list.json() as { data: { containers: unknown[] } }).data.containers).toHaveLength(0);
    await server.stop();
  });

  it('carries the validated optional fields through to the created container', async () => {
    const server = await makeServer();
    const res = await post(server, {
      partyId: '  party-1  ',
      bootstrapNodes: [` ${GOOD} `],
      profile: 'transaction',
      strandFilter: 'strand-a',
      resources: { memoryLimit: '512M', storageQuotaBytes: 1024 },
      tags: { env: 'test' },
    });

    expect(res.statusCode).toBe(201);
    const container = (res.json() as {
      data: { container: { partyId: string; profile: string; resources: unknown; tags: unknown } };
    }).data.container;
    expect(container.partyId).toBe('party-1');
    expect(container.profile).toBe('transaction');
    expect(container.resources).toEqual({ memoryLimit: '512M', storageQuotaBytes: 1024 });
    expect(container.tags).toEqual({ env: 'test' });
    await server.stop();
  });
});
