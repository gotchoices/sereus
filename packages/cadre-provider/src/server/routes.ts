/**
 * HTTP routes for the Provider API.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import debug from 'debug';
import type { ContainerService } from '../service/container-service.js';
import type { BillingService } from '../service/billing-service.js';
import type { CreateContainerRequest } from '../types.js';

const log = debug('cadre:provider:routes');

/** Route context with services */
export interface RouteContext {
  containerService: ContainerService;
  billingService: BillingService;
  basePath: string;
  /**
   * Trigger a graceful shutdown of the provider process.
   * Routes call this after a successful response when the caller passes
   * `shutdownAfter: true`. Idempotent and asynchronous (fire-and-forget).
   */
  requestShutdown: (reason: string) => void;
}

/** Coerce an arbitrary value to a strict boolean for the shutdownAfter flag */
function parseShutdownFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return false;
}

/** Customer identity from authentication */
export interface CustomerIdentity {
  customerId: string;
  permissions: string[];
}

/** Helper for error responses */
function errorResponse(reply: FastifyReply, code: string, message: string, status = 400) {
  return reply.status(status).send({
    ok: false,
    error: { code, message },
  });
}

/** Register all routes */
export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { basePath, containerService, billingService, requestShutdown } = ctx;

  // GET /status - Health check
  app.get(`${basePath}/status`, async (_request, reply) => {
    log('GET %s/status', basePath);
    return reply.send({ ok: true, service: 'cadre-provider', version: '0.0.1' });
  });

  // POST /containers - Create a new container
  app.post(`${basePath}/containers`, async (request, reply) => {
    log('POST %s/containers', basePath);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const body = request.body as Partial<CreateContainerRequest> & { shutdownAfter?: unknown };

    // Validate required fields
    if (!body.partyId) {
      return errorResponse(reply, 'INVALID_REQUEST', 'partyId is required');
    }
    if (!body.bootstrapNodes?.length) {
      return errorResponse(reply, 'INVALID_REQUEST', 'bootstrapNodes is required');
    }

    // Check quota
    const canCreate = await billingService.canCreateContainer(customer.customerId);
    if (!canCreate.allowed) {
      return errorResponse(reply, 'QUOTA_EXCEEDED', canCreate.reason ?? 'Cannot create more containers', 403);
    }

    const createRequest: CreateContainerRequest = {
      customerId: customer.customerId,
      partyId: body.partyId,
      bootstrapNodes: body.bootstrapNodes,
      profile: body.profile ?? 'storage',
      resources: body.resources,
      strandFilter: body.strandFilter,
      tags: body.tags,
    };

    const container = await containerService.createContainer(createRequest);

    const shutdownAfter = parseShutdownFlag(body.shutdownAfter);
    const payload: { ok: true; data: { container: typeof container }; shutdownInitiated?: true } = {
      ok: true,
      data: { container },
    };
    if (shutdownAfter) {
      payload.shutdownInitiated = true;
    }

    await reply.status(201).send(payload);
    if (shutdownAfter) {
      requestShutdown('shutdownAfter: POST /containers');
    }
    return reply;
  });

  // GET /containers - List containers
  app.get(`${basePath}/containers`, async (request, reply) => {
    log('GET %s/containers', basePath);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const containers = await containerService.listContainers(customer.customerId);

    return reply.send({
      ok: true,
      data: { containers },
    });
  });

  // GET /containers/:id - Get container status
  app.get(`${basePath}/containers/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('GET %s/containers/%s', basePath, id);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const status = await containerService.getContainerStatus(id);
    if (!status) {
      return errorResponse(reply, 'NOT_FOUND', 'Container not found', 404);
    }

    // Verify ownership
    if (status.container.customerId !== customer.customerId) {
      return errorResponse(reply, 'FORBIDDEN', 'Access denied', 403);
    }

    return reply.send({
      ok: true,
      data: status,
    });
  });

  // DELETE /containers/:id - Terminate container
  app.delete(`${basePath}/containers/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('DELETE %s/containers/%s', basePath, id);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const container = await containerService.getContainer(id);
    if (!container) {
      return errorResponse(reply, 'NOT_FOUND', 'Container not found', 404);
    }

    // Verify ownership
    if (container.customerId !== customer.customerId) {
      return errorResponse(reply, 'FORBIDDEN', 'Access denied', 403);
    }

    // Body wins over query when both present
    const body = (request.body ?? {}) as { shutdownAfter?: unknown };
    const query = (request.query ?? {}) as { shutdownAfter?: unknown };
    const shutdownAfter = body.shutdownAfter !== undefined
      ? parseShutdownFlag(body.shutdownAfter)
      : parseShutdownFlag(query.shutdownAfter);

    const success = await containerService.terminateContainer(id);
    const triggerShutdown = success && shutdownAfter;

    const payload: { ok: boolean; message: string; shutdownInitiated?: true } = {
      ok: success,
      message: success ? 'Container terminated' : 'Termination failed',
    };
    if (triggerShutdown) {
      payload.shutdownInitiated = true;
    }

    await reply.send(payload);
    if (triggerShutdown) {
      requestShutdown('shutdownAfter: DELETE /containers/' + id);
    }
    return reply;
  });

  // GET /containers/:id/peer - Get container peer info
  app.get(`${basePath}/containers/:id/peer`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('GET %s/containers/%s/peer', basePath, id);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const container = await containerService.getContainer(id);
    if (!container) {
      return errorResponse(reply, 'NOT_FOUND', 'Container not found', 404);
    }

    // Verify ownership
    if (container.customerId !== customer.customerId) {
      return errorResponse(reply, 'FORBIDDEN', 'Access denied', 403);
    }

    const peerInfo = await containerService.getPeerInfo(id);
    if (!peerInfo) {
      return errorResponse(reply, 'NOT_AVAILABLE', 'Peer info not yet available', 503);
    }

    return reply.send({
      ok: true,
      data: peerInfo,
    });
  });

  // PUT /containers/:id/seed - Apply a seed to a container
  app.put(`${basePath}/containers/:id/seed`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('PUT %s/containers/%s/seed', basePath, id);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const container = await containerService.getContainer(id);
    if (!container) {
      return errorResponse(reply, 'NOT_FOUND', 'Container not found', 404);
    }

    // Verify ownership
    if (container.customerId !== customer.customerId) {
      return errorResponse(reply, 'FORBIDDEN', 'Access denied', 403);
    }

    const body = request.body as { seed?: string };
    if (!body.seed) {
      return errorResponse(reply, 'INVALID_REQUEST', 'seed is required');
    }

    const result = await containerService.applySeed(id, body.seed);

    if (result.success) {
      return reply.send({
        ok: true,
        data: { peersAdded: result.peersAdded },
      });
    } else {
      return errorResponse(reply, 'SEED_FAILED', result.error ?? 'Failed to apply seed');
    }
  });

  // GET /billing/plans - List available plans
  app.get(`${basePath}/billing/plans`, async (_request, reply) => {
    log('GET %s/billing/plans', basePath);
    const plans = billingService.listPlans();
    return reply.send({ ok: true, data: { plans } });
  });

  // GET /billing/status - Get customer billing status
  app.get(`${basePath}/billing/status`, async (request, reply) => {
    log('GET %s/billing/status', basePath);

    const customer = (request as any).customer as CustomerIdentity | undefined;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }

    const billing = await billingService.getCustomerBilling(customer.customerId);
    return reply.send({ ok: true, data: { billing } });
  });

  log('Routes registered at %s', basePath);
}

