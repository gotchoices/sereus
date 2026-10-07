import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { NatError } from '../../nat/types.js';
import { UpdateErrorException } from '../../update/types.js';
import { HostedNodeError } from '../../hosted/types.js';
import { registerErrorHandler } from '../error-handler.js';

describe('error handler', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    registerErrorHandler(app);
    app.get('/nat/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new NatError(code as never, `nat err: ${code}`);
    });
    app.get('/update/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new UpdateErrorException(code as never, `update err: ${code}`);
    });
    app.get('/hosted/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new HostedNodeError(code as never, `hosted err: ${code}`);
    });
    app.get('/unknown', async () => {
      throw new Error('mystery');
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('NatError invalid_config → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/nat/invalid_config' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body).toEqual({
      ok: false,
      error: { code: 'invalid_config', message: 'nat err: invalid_config' },
    });
  });

  it('NatError secrets_unavailable → 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/nat/secrets_unavailable' });
    expect(res.statusCode).toBe(500);
  });

  it('UpdateErrorException apply_in_progress → 409', async () => {
    const res = await app.inject({ method: 'GET', url: '/update/apply_in_progress' });
    expect(res.statusCode).toBe(409);
  });

  it('UpdateErrorException no_update_available → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/update/no_update_available' });
    expect(res.statusCode).toBe(400);
  });

  it('HostedNodeError maps each code to its status', async () => {
    const statusOf = async (code: string): Promise<number> => (await app.inject({ method: 'GET', url: `/hosted/${code}` })).statusCode;
    expect(await statusOf('invalid_request')).toBe(400);
    expect(await statusOf('not_found')).toBe(404);
    expect(await statusOf('invalid_state')).toBe(409);
    expect(await statusOf('node_unavailable')).toBe(503);
    expect(await statusOf('orchestrator_error')).toBe(500);
    expect(await statusOf('storage_error')).toBe(500);
    const body = (await app.inject({ method: 'GET', url: '/hosted/invalid_state' })).json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_state');
  });

  it('unknown Error → 500 internal', async () => {
    const res = await app.inject({ method: 'GET', url: '/unknown' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('mystery');
  });
});
