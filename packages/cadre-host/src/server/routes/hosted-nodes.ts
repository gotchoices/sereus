/**
 * `/api/hosted-nodes` — the host's "Join a cadre" action and the nodes it made.
 * Loopback, no bearer: same-machine admin, matching the local-UI "no login"
 * posture. Clients: the `cadre-host join` / `cadre-host node` CLI and the local
 * UI.
 *
 *   GET    /api/hosted-nodes            every hosted node (secret and invitation stripped)
 *   POST   /api/hosted-nodes            { invitation? } start a node waiting to be claimed, or one
 *                                       that redeems the invitation → 201 { node }
 *   GET    /api/hosted-nodes/:id        one node
 *   GET    /api/hosted-nodes/:id/claim  the QR payload: 409 unless unclaimed, 503 until the child answers
 *   DELETE /api/hosted-nodes/:id        stop the node and delete its data → 204
 *   POST   /api/hosted-nodes/:id/reset  remove, then start a fresh node → 201 { node }
 *   POST   /api/hosted-nodes/:id/retry  start an invitation node again after no member
 *                                       could be reached → { node }; 409 unless so
 *
 * Responses use the `/api/*` envelope (`{ ok, data }`); errors come from
 * `HostedNodeError`, which `server/error-handler.ts` maps. The mutations publish
 * nothing themselves: the service reports every change through its listener,
 * which `server/index.ts` wires to the bus as `hosted-nodes-changed`, so a
 * change the watcher or the supervisor makes reaches the SPA the same way.
 */

import type { FastifyInstance } from 'fastify';

import type { HostedNodeService, JoinOptions } from '../../hosted/hosted-node-service.js';
import { HostedNodeError } from '../../hosted/types.js';

export interface HostedNodesRoutesOptions {
  hostedNodes: HostedNodeService;
}

export function registerHostedNodesRoutes(app: FastifyInstance, opts: HostedNodesRoutesOptions): void {
  const { hostedNodes } = opts;

  app.get('/api/hosted-nodes', async () => {
    return { ok: true, data: { nodes: hostedNodes.list() } };
  });

  app.post('/api/hosted-nodes', async (request, reply) => {
    const node = await hostedNodes.join(joinOptionsOf(request.body));
    return reply.status(201).send({ ok: true, data: { node } });
  });

  app.get<{ Params: { id: string } }>('/api/hosted-nodes/:id', async (request, reply) => {
    const node = hostedNodes.get(request.params.id);
    if (!node) {
      return reply.status(404).send({ ok: false, error: { code: 'not_found', message: `No such hosted node: ${request.params.id}` } });
    }
    return { ok: true, data: { node } };
  });

  app.get<{ Params: { id: string } }>('/api/hosted-nodes/:id/claim', async (request) => {
    return { ok: true, data: await hostedNodes.claimDetails(request.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/hosted-nodes/:id', async (request, reply) => {
    await hostedNodes.remove(request.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/hosted-nodes/:id/reset', async (request, reply) => {
    const node = await hostedNodes.reset(request.params.id);
    return reply.status(201).send({ ok: true, data: { node } });
  });

  app.post<{ Params: { id: string } }>('/api/hosted-nodes/:id/retry', async (request) => {
    return { ok: true, data: { node: await hostedNodes.retry(request.params.id) } };
  });
}

/** The join body: none (or `{}`) for a node waiting to be claimed, `{ invitation }` for one that redeems it. */
function joinOptionsOf(body: unknown): JoinOptions {
  const fields = (body ?? {}) as { invitation?: unknown };
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new HostedNodeError('invalid_request', 'The body must be a JSON object');
  }
  if (fields.invitation === undefined) return {};
  if (typeof fields.invitation !== 'string' || fields.invitation.trim() === '') {
    throw new HostedNodeError('invalid_request', '`invitation` must be the invitation text the owner\'s app copied');
  }
  return { invitation: fields.invitation };
}
