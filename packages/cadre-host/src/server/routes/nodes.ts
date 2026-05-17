/**
 * /api/nodes — list managed cadre nodes, look up details, and control
 * lifecycle. Lifecycle ops publish `node-state-changed` to the bus.
 *
 * v1 limits: cadre-host doesn't yet auto-spawn nodes (the trust-circle →
 * node mapping ticket is separate). Until it lands, `listNodes()` is
 * usually empty and start/restart are stubs. Stop on a running node works.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';

import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import type { EventBus } from '../events/bus.js';
import { defaultLogPath } from '../../orchestrator/log-rotator.js';

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;

export interface NodesRoutesOptions {
  orchestrator: HostProcessOrchestrator;
  events: EventBus;
}

export function registerNodesRoutes(app: FastifyInstance, opts: NodesRoutesOptions): void {
  const { orchestrator, events } = opts;

  app.get('/api/nodes', async () => {
    return { ok: true, data: { nodes: orchestrator.listNodes() } };
  });

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (request, reply) => {
    const node = orchestrator.getNode(request.params.id);
    if (!node) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'not_found', message: `Unknown node: ${request.params.id}` },
      });
    }
    let stats = null;
    try {
      stats = await orchestrator.getStats(node.dockerId);
    } catch {
      // Stats unavailable (dead process etc.) — surface null.
    }
    return { ok: true, data: { node, stats } };
  });

  app.get<{ Params: { id: string }; Querystring: { lines?: string } }>(
    '/api/nodes/:id/logs',
    async (request, reply) => {
      const node = orchestrator.getNode(request.params.id);
      if (!node) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'not_found', message: `Unknown node: ${request.params.id}` },
        });
      }
      const requested = Number(request.query.lines ?? DEFAULT_LOG_LINES);
      const tail = Number.isFinite(requested)
        ? Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(requested)))
        : DEFAULT_LOG_LINES;
      const lines = tailLogFile(defaultLogPath(node.workdir), tail);
      return { ok: true, data: { lines } };
    },
  );

  app.post<{ Params: { id: string } }>('/api/nodes/:id/stop', async (request, reply) => {
    const dockerId = orchestrator.resolveDockerId(request.params.id);
    if (!dockerId) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'not_found', message: `Unknown node: ${request.params.id}` },
      });
    }
    await orchestrator.stopContainer(dockerId);
    const after = orchestrator.getNode(dockerId);
    if (after) {
      events.publish({ type: 'node-state-changed', nodeId: after.id, status: 'stopped' });
    }
    return { ok: true };
  });

  // start / restart: the orchestrator's createContainer requires a full
  // OrchestratorCreateRequest (partyId, bootstrapNodes, profile, ...).
  // cadre-host doesn't yet own a "spawn this node from saved config" path
  // — that lives in the trust-circle-driven node spawner planned for a
  // follow-up ticket. Until then these endpoints stub out cleanly so the
  // SPA gets a predictable error rather than a route-not-found 404.
  app.post<{ Params: { id: string } }>('/api/nodes/:id/start', async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: {
        code: 'not_implemented',
        message:
          `start ${request.params.id}: cadre-host v1 has no auto-spawn path. ` +
          `Restart the cadre-host service to bring up persisted nodes.`,
      },
    });
  });

  app.post<{ Params: { id: string } }>('/api/nodes/:id/restart', async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: {
        code: 'not_implemented',
        message:
          `restart ${request.params.id}: cadre-host v1 has no auto-spawn path. ` +
          `Restart the cadre-host service to bring up persisted nodes.`,
      },
    });
  });
}

/**
 * Read the last `n` lines from a log file by walking the tail in chunks.
 * Returns [] for a missing file.
 */
export function tailLogFile(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const chunkSize = 8192;
    let pos = size;
    const buffers: Buffer[] = [];
    let newlineCount = 0;
    while (pos > 0 && newlineCount <= n) {
      const readLen = Math.min(chunkSize, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      readSync(fd, buf, 0, readLen, pos);
      buffers.unshift(buf);
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) newlineCount++;
      }
    }
    const joined = Buffer.concat(buffers).toString('utf8');
    const lines = joined.split('\n');
    const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return trimmed.slice(-n);
  } finally {
    closeSync(fd);
  }
}

