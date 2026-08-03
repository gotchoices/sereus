/**
 * HTTP routes for the Provider API.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import debug from 'debug';
import { fromString as uint8ArrayFromString } from 'uint8arrays';
import type { ContainerService } from '../service/container-service.js';
import type { BillingService } from '../service/billing-service.js';
import type { Container, CreateContainerRequest } from '../types.js';
import { Scope, hasPermission } from './permissions.js';

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

/**
 * Strip secrets from a Container before it crosses the API boundary. The
 * per-container `seedToken` gates the node's `POST /seed` route — the provider
 * presents it on the customer's behalf, so it must never appear in a response
 * (the customer never needs it, and it is a credential). All other fields,
 * including the loopback-only endpoint URLs, are unchanged.
 */
function redactContainer(container: Container): Omit<Container, 'seedToken'> {
  const { seedToken: _seedToken, ...rest } = container;
  return rest;
}

/**
 * Longest rejected key echoed back in an error message — a real key is 43
 * base64url characters. Mirrors `REJECTED_VALUE_ECHO_LIMIT` in
 * `packages/cadre-core/src/ed25519-key.ts`.
 */
const REJECTED_OWNER_KEY_ECHO_LIMIT = 64;

/**
 * Render a rejected key for an error message, capped: `pinnedOwnerKeys` arrives
 * from a tenant over the network, so an unbounded echo would let one junk string
 * become a megabyte of log line.
 */
function describeRejectedOwnerKey(value: string): string {
  return value.length <= REJECTED_OWNER_KEY_ECHO_LIMIT
    ? value
    : `${value.slice(0, REJECTED_OWNER_KEY_ECHO_LIMIT)}… (${value.length} chars)`;
}

/**
 * Reject one `pinnedOwnerKeys` entry that is not shaped like a base64url-encoded
 * 32-byte Ed25519 public key. Returns the trimmed value, so the create request
 * carries exactly what was validated.
 *
 * **This deliberately restates `requireEd25519PublicKeyB64`
 * (`packages/cadre-core/src/ed25519-key.ts`) rather than importing it.**
 * cadre-provider declares no `workspace:` dependencies: depending on
 * `@serfab/cadre-core` would pull libp2p + quereus + optimystic into a thin
 * Docker-host service's install closure, and would invalidate the note in
 * `vitest.config.ts` that this package needs no stale-build guard. `uint8arrays`
 * — the base64url codec cadre-core itself uses — is dependency-light and is not a
 * workspace package, so the rule is restated over it instead. Keep the two in
 * step: `__tests__/create-container-owner-keys.test.ts` asserts the same
 * accept/reject table as `packages/cadre-core/test/ed25519-key.spec.ts`, so a
 * divergence shows up as a test failure rather than as silence. The rule itself is
 * fixed by Ed25519 (a public key is 32 bytes, always), not by our code.
 *
 * Curve membership is deliberately NOT checked, matching cadre-core: a
 * well-formed-but-off-curve key fails signature verification later exactly like
 * any other wrong key.
 */
function validateOwnerKey(value: string): { key: string } | { error: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { error: 'pinnedOwnerKeys entries must not be empty or whitespace-only' };
  }

  let decoded: Uint8Array;
  try {
    decoded = uint8ArrayFromString(trimmed, 'base64url');
  } catch (error) {
    log('rejecting pinnedOwnerKeys entry: %s', error instanceof Error ? error.message : String(error));
    return {
      error: `pinnedOwnerKeys entries must be base64url-encoded Ed25519 public keys (could not decode "${describeRejectedOwnerKey(trimmed)}" as base64url)`,
    };
  }

  if (decoded.length !== 32) {
    return {
      error: `pinnedOwnerKeys entries must be base64url-encoded 32-byte Ed25519 public keys ("${describeRejectedOwnerKey(trimmed)}" decoded to ${decoded.length} bytes)`,
    };
  }

  return { key: trimmed };
}

/**
 * Validate the optional `pinnedOwnerKeys` field of a create request: absent, or an
 * array of base64url-encoded 32-byte Ed25519 public keys (see
 * {@link validateOwnerKey}).
 *
 * Create is the last point at which the caller can still fix a typo, so the shape
 * is checked here: `cadre-cli start` rejects a malformed `CADRE_OWNER_KEYS` entry
 * outright, so without this check a typo'd pin is answered 201 and then produces a
 * container that dies at boot — the caller learning about it, if ever, from
 * container status rather than from a 400 naming the bad key.
 *
 * Every rejection names the offending entry: with several keys in one request the
 * message is the only thing that says WHICH one.
 *
 * Exported for the accept/reject table test that keeps this rule in step with
 * cadre-core's.
 *
 * @returns the trimmed keys, so the create request carries exactly what was validated.
 */
export function validatePinnedOwnerKeys(value: unknown): { keys?: string[] } | { error: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((key): key is string => typeof key === 'string')) {
    return { error: 'pinnedOwnerKeys must be an array of strings' };
  }

  const keys: string[] = [];
  for (const entry of value) {
    const checked = validateOwnerKey(entry);
    if ('error' in checked) return checked;
    keys.push(checked.key);
  }
  return { keys };
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

// The auth preHandler (see auth.ts) attaches the authenticated identity to the
// request; declare it on Fastify's request type so handlers read it type-safely.
declare module 'fastify' {
  interface FastifyRequest {
    customer?: CustomerIdentity;
  }
}

/** Helper for error responses */
function errorResponse(reply: FastifyReply, code: string, message: string, status = 400) {
  return reply.status(status).send({
    ok: false,
    error: { code, message },
  });
}

/**
 * Enforce a permission scope on an authenticated identity. Sends a
 * `403 INSUFFICIENT_SCOPE` response and returns false when the scope is
 * missing; returns true (no response sent) when granted.
 */
function requireScope(reply: FastifyReply, customer: CustomerIdentity, scope: string): boolean {
  if (hasPermission(customer.permissions, scope)) return true;
  errorResponse(reply, 'INSUFFICIENT_SCOPE', `Missing required scope: ${scope}`, 403);
  return false;
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

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersCreate)) return reply;

    const body = request.body as Omit<Partial<CreateContainerRequest>, 'pinnedOwnerKeys'> & {
      shutdownAfter?: unknown;
      pinnedOwnerKeys?: unknown;
    };

    // Validate required fields
    if (!body.partyId) {
      return errorResponse(reply, 'INVALID_REQUEST', 'partyId is required');
    }
    if (!body.bootstrapNodes?.length) {
      return errorResponse(reply, 'INVALID_REQUEST', 'bootstrapNodes is required');
    }
    // Optional, but the create call is the last point where the caller can still
    // supply it — a container created without it refuses every seed.
    const pinned = validatePinnedOwnerKeys(body.pinnedOwnerKeys);
    if ('error' in pinned) {
      return errorResponse(reply, 'INVALID_REQUEST', pinned.error);
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
      ...(pinned.keys ? { pinnedOwnerKeys: pinned.keys } : {}),
    };

    const container = await containerService.createContainer(createRequest);

    const shutdownAfter = parseShutdownFlag(body.shutdownAfter);
    const payload: { ok: true; data: { container: Omit<Container, 'seedToken'> }; shutdownInitiated?: true } = {
      ok: true,
      data: { container: redactContainer(container) },
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

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersRead)) return reply;

    const containers = await containerService.listContainers(customer.customerId);

    return reply.send({
      ok: true,
      data: { containers: containers.map(redactContainer) },
    });
  });

  // GET /containers/:id - Get container status
  app.get(`${basePath}/containers/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('GET %s/containers/%s', basePath, id);

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersRead)) return reply;

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
      data: { ...status, container: redactContainer(status.container) },
    });
  });

  // DELETE /containers/:id - Terminate container
  app.delete(`${basePath}/containers/:id`, async (request, reply) => {
    const { id } = request.params as { id: string };
    log('DELETE %s/containers/%s', basePath, id);

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersDelete)) return reply;

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

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersRead)) return reply;

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

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.ContainersSeed)) return reply;

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

    const customer = request.customer;
    if (!customer) {
      return errorResponse(reply, 'UNAUTHORIZED', 'Authentication required', 401);
    }
    if (!requireScope(reply, customer, Scope.BillingRead)) return reply;

    const billing = await billingService.getCustomerBilling(customer.customerId);
    return reply.send({ ok: true, data: { billing } });
  });

  log('Routes registered at %s', basePath);
}

