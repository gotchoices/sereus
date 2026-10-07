/**
 * `/api/hosted-nodes` — the host's "Join a cadre" action and the nodes it made.
 * Loopback, no bearer: same-machine admin, matching the local-UI "no login"
 * posture. Clients: the `cadre-host join` / `cadre-host node` CLI and the local
 * UI.
 *
 *   GET    /api/hosted-nodes            every hosted node (secret stripped)
 *   POST   /api/hosted-nodes            start a node waiting to be claimed → 201 { node }
 *   GET    /api/hosted-nodes/:id        one node
 *   GET    /api/hosted-nodes/:id/claim  the QR payload: 409 unless unclaimed, 503 until the child answers
 *   DELETE /api/hosted-nodes/:id        stop the node and delete its data → 204
 *   POST   /api/hosted-nodes/:id/reset  remove, then start a fresh node → 201 { node }
 *
 * Responses use the `/api/*` envelope (`{ ok, data }`); errors come from
 * `HostedNodeError`, which `server/error-handler.ts` maps. The mutations publish
 * nothing themselves: the service reports every change through its listener,
 * which `server/index.ts` wires to the bus as `hosted-nodes-changed`, so a
 * change the watcher or the supervisor makes reaches the SPA the same way.
 */

import type { FastifyInstance } from 'fastify';

import type { HostedNodeService } from '../../hosted/hosted-node-service.js';

export interface HostedNodesRoutesOptions {
  hostedNodes: HostedNodeService;
}

export function registerHostedNodesRoutes(app: FastifyInstance, opts: HostedNodesRoutesOptions): void {
  const { hostedNodes } = opts;

  app.get('/api/hosted-nodes', async () => {
    return { ok: true, data: { nodes: hostedNodes.list() } };
  });

  // The body is ignored today; `cadre-host-join-by-invitation` adds one.
  app.post('/api/hosted-nodes', async (_request, reply) => {
    const node = await hostedNodes.join();
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
}
