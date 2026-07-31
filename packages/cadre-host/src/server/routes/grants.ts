/**
 * Grantee-facing donation routes — the HTTP surface an external cadre authority
 * (a friend's phone) drives to have this host donate a node into *its* cadre.
 *
 * Mount path: `/grants`. Distinct from the loopback-only `/grants-admin` surface
 * (issue/list/revoke, no bearer): this one is **bearer-gated** — every request
 * carries `Authorization: Bearer <grant-token>`, and a grantee sees only the
 * donations its own grant authorized (the single cross-grantee boundary,
 * analogous to cadre-provider's per-customer ownership check).
 *
 * Reachability is out of scope here: in v1 this mounts on the loopback
 * management server, same as the trust-circle / NAT surfaces. Physically exposing
 * it to a remote phone is `backlog/feat-cadre-host-wan-grant-reachability`.
 *
 * Errors: handlers either send a `{ ok:false, error:{code,message} }` envelope
 * inline (auth / body validation) or let the `DonationService` throw a
 * `DonationError`, which `server/error-handler.ts` maps to the matching HTTP
 * status and the same envelope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DonationService, DonationProvisionRequest } from '../../donation/donation-service.js';
import type { DonationView, GrantValidator } from '../../donation/types.js';

export interface GrantsRoutesOptions {
  donations: DonationService;
  /** Validates the presented bearer for non-provisioning ops (provision revalidates internally). */
  grants: GrantValidator;
}

/** Uniform error envelope (matches `error-handler.ts` and the provider API). */
function errorResponse(reply: FastifyReply, code: string, message: string, status: number) {
  return reply.status(status).send({ ok: false, error: { code, message } });
}

/** Pull the `Bearer <token>` value out of the Authorization header, or undefined. */
function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : undefined;
}

/** Map a grant denial reason to an HTTP status for the bearer gate. */
function denyStatus(reason: string | undefined): number {
  if (reason === 'expired' || reason === 'revoked') return 403;
  return 401; // unknown_token / missing
}

/**
 * Authenticate the grant bearer for a non-provisioning op (identity + not
 * expired/revoked; no quota). Returns the token, or null after sending the
 * failure response. Provision does its own quota-aware validation inside
 * `DonationService.provision`.
 */
function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  grants: GrantValidator,
): string | null {
  const token = parseBearer(request.headers.authorization);
  if (!token) {
    errorResponse(reply, 'unauthorized', 'Missing bearer grant token', 401);
    return null;
  }
  const validation = grants.validate(token);
  if (!validation.ok) {
    const status = denyStatus(validation.reason);
    // Keep the envelope code aligned with the status (and with the POST path,
    // which surfaces an unknown token as `unauthorized`): 401 → unauthorized,
    // 403 → forbidden. A 401 labelled `forbidden` is self-contradictory.
    const code = status === 403 ? 'forbidden' : 'unauthorized';
    errorResponse(reply, code, `Grant is ${validation.reason ?? 'invalid'}`, status);
    return null;
  }
  return token;
}

/**
 * Resolve a donation the presented grant owns. Returns the redacted view, or
 * null after sending a 404 — an unknown id and one owned by a *different* grant
 * are deliberately indistinguishable (a grantee never learns another grantee's
 * donations exist).
 */
function requireOwned(
  donations: DonationService,
  id: string,
  token: string,
  reply: FastifyReply,
): DonationView | null {
  const donation = donations.get(id);
  if (!donation || donation.grantToken !== token) {
    errorResponse(reply, 'not_found', `No such donation: ${id}`, 404);
    return null;
  }
  return donation;
}

export function registerGrantsRoutes(app: FastifyInstance, opts: GrantsRoutesOptions): void {
  const { donations, grants } = opts;

  // POST /grants — provision a donated node. The bearer's identity/expiry/
  // revocation AND quota are validated inside provision(), which throws a
  // DonationError (unauthorized / forbidden / quota_exceeded) the error handler
  // maps. We only parse the bearer and validate the request body here.
  app.post('/grants', async (request, reply) => {
    const token = parseBearer(request.headers.authorization);
    if (!token) {
      return errorResponse(reply, 'unauthorized', 'Missing bearer grant token', 401);
    }

    const body = (request.body ?? {}) as Partial<DonationProvisionRequest>;
    if (typeof body.partyId !== 'string' || body.partyId.length === 0) {
      return errorResponse(reply, 'invalid_request', 'partyId is required', 400);
    }
    if (!Array.isArray(body.bootstrapNodes) || body.bootstrapNodes.length === 0) {
      return errorResponse(reply, 'invalid_request', 'bootstrapNodes is required', 400);
    }
    if (!Array.isArray(body.ownerKeys) || body.ownerKeys.length === 0) {
      return errorResponse(reply, 'invalid_request', 'ownerKeys is required', 400);
    }
    if (body.profile !== undefined && body.profile !== 'storage' && body.profile !== 'transaction') {
      return errorResponse(reply, 'invalid_request', 'profile must be "storage" or "transaction"', 400);
    }

    const donation = await donations.provision({
      grantToken: token,
      partyId: body.partyId,
      bootstrapNodes: body.bootstrapNodes,
      ownerKeys: body.ownerKeys,
      ...(body.profile ? { profile: body.profile } : {}),
    });
    return reply.status(201).send({ ok: true, data: { donation } });
  });

  // GET /grants — list only the donations this grant authorized.
  app.get('/grants', async (request, reply) => {
    const token = authenticate(request, reply, grants);
    if (!token) return reply;
    return reply.send({ ok: true, data: { donations: donations.list(token) } });
  });

  // GET /grants/:id — one donation (redacted), owned by this grant.
  app.get<{ Params: { id: string } }>('/grants/:id', async (request, reply) => {
    const token = authenticate(request, reply, grants);
    if (!token) return reply;
    const donation = requireOwned(donations, request.params.id, token, reply);
    if (!donation) return reply;
    return reply.send({ ok: true, data: { donation } });
  });

  // GET /grants/:id/peer — live { peerId, multiaddrs } for the requester's addDrone.
  app.get<{ Params: { id: string } }>('/grants/:id/peer', async (request, reply) => {
    const token = authenticate(request, reply, grants);
    if (!token) return reply;
    if (!requireOwned(donations, request.params.id, token, reply)) return reply;
    const peer = await donations.getPeer(request.params.id);
    return reply.send({ ok: true, data: peer });
  });

  // PUT /grants/:id/seed — apply the requester's phone-signed seed.
  app.put<{ Params: { id: string } }>('/grants/:id/seed', async (request, reply) => {
    const token = authenticate(request, reply, grants);
    if (!token) return reply;
    if (!requireOwned(donations, request.params.id, token, reply)) return reply;

    const body = (request.body ?? {}) as { seed?: unknown };
    if (typeof body.seed !== 'string' || body.seed.length === 0) {
      return errorResponse(reply, 'invalid_request', 'seed is required', 400);
    }
    const result = await donations.applySeed(request.params.id, body.seed);
    // NOTE: exhaustive over today's three outcomes, and nothing forces it to stay
    // that way — an unhandled fourth would fall out of the handler as `undefined`
    // and hang the request rather than fail to compile. If `DonationSeedResult`
    // ever grows a variant, add a `default:` that 500s here.
    switch (result.outcome) {
      case 'rejected':
        return errorResponse(reply, 'seed_failed', result.error ?? 'Node rejected the seed', 502);
      // The loan ended while the seed was in flight. The ending won, so the
      // caller is told the record it seeded is no longer seedable (409) — or is
      // gone entirely (404) — rather than a 200 that implies a live node.
      case 'abandoned':
        return result.status
          ? errorResponse(
              reply,
              'invalid_state',
              `Donation ${request.params.id} ended (${result.status}) while the seed was in flight`,
              409,
            )
          : errorResponse(reply, 'not_found', `No such donation: ${request.params.id}`, 404);
      case 'seeded':
        return reply.send({ ok: true, data: { peersAdded: result.peersAdded } });
    }
  });

  // DELETE /grants/:id — terminate the donated node.
  app.delete<{ Params: { id: string } }>('/grants/:id', async (request, reply) => {
    const token = authenticate(request, reply, grants);
    if (!token) return reply;
    if (!requireOwned(donations, request.params.id, token, reply)) return reply;
    await donations.terminate(request.params.id);
    return reply.send({ ok: true });
  });
}
