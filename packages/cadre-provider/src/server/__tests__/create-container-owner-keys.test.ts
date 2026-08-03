/**
 * `POST /containers` acceptance + validation of `pinnedOwnerKeys` — the tenant
 * owner key(s) the created node is started with as cold-start seed-trust
 * anchors. Create time is the last point where a caller can supply them, so a
 * malformed field is refused here rather than surfacing later as a container that
 * dies at boot.
 *
 * The second suite pins the provider's local restatement of
 * `requireEd25519PublicKeyB64` (the deliberate duplication described on
 * `validateOwnerKey` in `../owner-key-validation.ts`) to the same accept/reject table
 * `packages/cadre-core/test/ed25519-key.spec.ts` pins cadre-core's copy to. It
 * cannot observe cadre-core — nothing here imports it — so it does not detect a
 * change made over there; what it does is fail if this copy is changed, which is
 * how an editor is landed on the pointer to the other one.
 */

import { describe, it, expect } from 'vitest';
import { toString as uint8ArrayToString } from 'uint8arrays';
import type { ProviderConfig } from '../../config/types.js';
import { DEFAULT_CONFIG } from '../../config/types.js';
import { MemoryStore } from '../../service/store.js';
import { MockOrchestrator } from '../../service/orchestrator.js';
import { createProviderServer, type ProviderServer } from '../server.js';
import { validatePinnedOwnerKeys } from '../owner-key-validation.js';

/**
 * A well-formed, distinct 32-byte base64url owner key. Real bytes rather than a
 * placeholder string: the route now decodes what it is given, so `'owner-key-1'`
 * is a 400.
 */
function ownerKey(fill: number): string {
  return uint8ArrayToString(new Uint8Array(32).fill(fill), 'base64url');
}

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

function createPayload(pinnedOwnerKeys?: unknown): Record<string, unknown> {
  return {
    partyId: 'party-1',
    bootstrapNodes: ['/ip4/127.0.0.1/tcp/4001'],
    ...(pinnedOwnerKeys === undefined ? {} : { pinnedOwnerKeys }),
  };
}

describe('POST /containers pinnedOwnerKeys', () => {
  it('accepts a list of keys and records them on the container', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload([ownerKey(1), ownerKey(2)]),
    });

    expect(res.statusCode).toBe(201);
    const container = (res.json() as { data: { container: { pinnedOwnerKeys?: string[] } } }).data.container;
    expect(container.pinnedOwnerKeys).toEqual([ownerKey(1), ownerKey(2)]);
    await server.stop();
  });

  it('accepts a request with no pinnedOwnerKeys (container simply trusts no seed signer)', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(),
    });

    expect(res.statusCode).toBe(201);
    const container = (res.json() as { data: { container: { pinnedOwnerKeys?: string[] } } }).data.container;
    expect(container.pinnedOwnerKeys).toBeUndefined();
    await server.stop();
  });

  it('rejects a non-array pinnedOwnerKeys with INVALID_REQUEST', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(ownerKey(1)),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    await server.stop();
  });

  it('rejects an array with a non-string element with INVALID_REQUEST', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload([ownerKey(1), 42]),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    await server.stop();
  });

  // The bug this validation exists for: 'this-is-not-a-key' is 17 characters of
  // valid base64url alphabet, so it used to sail through as a 201 and only fail
  // when the spawned node tried to decode it at boot.
  it('rejects a malformed key with INVALID_REQUEST, naming the bad value', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload([ownerKey(1), 'this-is-not-a-key']),
    });

    expect(res.statusCode).toBe(400);
    const error = (res.json() as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('this-is-not-a-key');
    await server.stop();
  });

  // A caller who genuinely wants to trust nobody omits the field (asserted above);
  // one who sends [""] made a mistake and is told so.
  it('rejects a blank-string entry with INVALID_REQUEST', async () => {
    const server = await makeServer();
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload(['']),
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST');
    await server.stop();
  });

  it('does not provision a container when the field is invalid', async () => {
    const server = await makeServer();
    await server.app.inject({
      method: 'POST',
      url: '/api/v1/containers',
      payload: createPayload({ not: 'an array' }),
    });

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect((list.json() as { data: { containers: unknown[] } }).data.containers).toHaveLength(0);
    await server.stop();
  });

  it('does not provision a container when a key is malformed or blank', async () => {
    const server = await makeServer();
    for (const bad of [['this-is-not-a-key'], [''], [ownerKey(1), 'k'.repeat(44)]]) {
      await server.app.inject({
        method: 'POST',
        url: '/api/v1/containers',
        payload: createPayload(bad),
      });
    }

    const list = await server.app.inject({ method: 'GET', url: '/api/v1/containers' });
    expect((list.json() as { data: { containers: unknown[] } }).data.containers).toHaveLength(0);
    await server.stop();
  });
});

/**
 * The provider's copy of the owner-key rule, exercised directly. Mirrors
 * `requireEd25519PublicKeyB64`'s suite in
 * `packages/cadre-core/test/ed25519-key.spec.ts` — if the two rules ever diverge,
 * this is where it surfaces.
 */
describe('validatePinnedOwnerKeys (the provider copy of the cadre-core rule)', () => {
  function errorOf(value: unknown): string {
    const result = validatePinnedOwnerKeys(value);
    if (!('error' in result)) throw new Error(`expected a rejection, got ${JSON.stringify(result)}`);
    return result.error;
  }

  it('treats an absent field as "no keys supplied"', () => {
    expect(validatePinnedOwnerKeys(undefined)).toEqual({});
  });

  it('accepts an empty array (a caller that pins nothing)', () => {
    expect(validatePinnedOwnerKeys([])).toEqual({ keys: [] });
  });

  it('accepts a 43-char base64url key, with or without padding, and returns it trimmed', () => {
    const unpadded = 'A'.repeat(43);
    expect(validatePinnedOwnerKeys([`  ${unpadded}\n`])).toEqual({ keys: [unpadded] });
    expect(validatePinnedOwnerKeys([`${unpadded}==`])).toEqual({ keys: [`${unpadded}==`] });
  });

  it('accepts a well-formed but off-curve 32-byte value (curve validation is out of scope)', () => {
    const offCurve = ownerKey(0);
    expect(validatePinnedOwnerKeys([offCurve])).toEqual({ keys: [offCurve] });
  });

  it('rejects an empty or whitespace-only entry with the blank-value message', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(errorOf([blank])).toMatch(/must not be empty or whitespace-only/);
    }
  });

  it('rejects entries with invalid base64url characters', () => {
    for (const bad of ['not base64!!', 'abc$def', 'has+slash/and=pad']) {
      expect(errorOf([bad])).toMatch(/could not decode/);
    }
  });

  it('rejects a truncated value that cannot be decoded at all', () => {
    for (const bad of ['owner-key-1', 'key-1', 'this-is-not-a-key']) {
      expect(errorOf([bad])).toMatch(/could not decode/);
    }
  });

  it('rejects a value that decodes to the wrong byte length, naming the offending value', () => {
    const tooLong = 'k'.repeat(44); // 33 bytes
    expect(errorOf([tooLong])).toBe(
      `pinnedOwnerKeys entries must be base64url-encoded 32-byte Ed25519 public keys ("${tooLong}" decoded to 33 bytes)`,
    );
    const tooShort = uint8ArrayToString(new Uint8Array(16), 'base64url');
    expect(errorOf([tooShort])).toContain('decoded to 16 bytes');
  });

  it('names the offending entry when only one key in a batch is bad', () => {
    expect(errorOf([ownerKey(1), 'this-is-not-a-key', ownerKey(2)])).toContain('this-is-not-a-key');
  });

  // A tenant must not be able to turn one junk string into a megabyte of log line.
  it('caps the echoed value for an over-long rejected key', () => {
    const message = errorOf(['A'.repeat(5000)]);
    expect(message).toContain('(5000 chars)');
    expect(message.length).toBeLessThan(200);
  });

  it('still rejects a non-array or non-string element before looking at key shape', () => {
    expect(errorOf('a-string')).toBe('pinnedOwnerKeys must be an array of strings');
    expect(errorOf([ownerKey(1), 42])).toBe('pinnedOwnerKeys must be an array of strings');
  });
});
