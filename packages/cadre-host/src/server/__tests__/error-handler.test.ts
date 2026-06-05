import Fastify, { type FastifyRequest } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { TrustCircleError } from '../../auth/types.js';
import { NatError } from '../../nat/types.js';
import { UpdateErrorException } from '../../update/types.js';
import { registerErrorHandler } from '../error-handler.js';

describe('error handler', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    app = Fastify();
    registerErrorHandler(app);
    app.get('/trust/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new TrustCircleError(code as never, `trust err: ${code}`);
    });
    app.get('/nat/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new NatError(code as never, `nat err: ${code}`);
    });
    app.get('/update/:code', async (req: FastifyRequest) => {
      const { code } = req.params as { code: string };
      throw new UpdateErrorException(code as never, `update err: ${code}`);
    });
    app.get('/unknown', async () => {
      throw new Error('mystery');
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('TrustCircleError invalid_label → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/trust/invalid_label' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body).toEqual({
      ok: false,
      error: { code: 'invalid_label', message: 'trust err: invalid_label' },
    });
  });

  it('TrustCircleError not_found → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/trust/not_found' });
    expect(res.statusCode).toBe(404);
  });

  it('TrustCircleError already_redeemed → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/trust/already_redeemed' });
    expect(res.statusCode).toBe(404);
  });

  it('TrustCircleError expired → 410', async () => {
    const res = await app.inject({ method: 'GET', url: '/trust/expired' });
    expect(res.statusCode).toBe(410);
  });

  it('TrustCircleError storage_error → 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/trust/storage_error' });
    expect(res.statusCode).toBe(500);
  });

  it('NatError invalid_config → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/nat/invalid_config' });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_config');
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

  it('unknown Error → 500 internal', async () => {
    const res = await app.inject({ method: 'GET', url: '/unknown' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('mystery');
  });
});
