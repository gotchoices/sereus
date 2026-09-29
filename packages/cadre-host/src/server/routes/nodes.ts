/**
 * /api/nodes — list managed cadre nodes, look up details, and control
 * lifecycle.
 *
 * Bus events for lifecycle transitions are emitted by the orchestrator's
 * `onStateChange` (forwarded by `createLocalUiServer.start`) — the route
 * handlers don't re-publish.
 *
 * start/stop/restart are real for the admin's owner node only (start/restart
 * re-spawn it from the persisted `OwnerSpawnConfig`). Every other node this
 * route can see is a donated node, whose lifecycle belongs to the donation
 * surface — this route no longer spawns generic nodes, and a stop here would
 * be undone at once by the donation supervisor's respawn. So all three verbs
 * answer a known non-owner node with 501, pointing at the donation teardown.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { HostProcessOrchestrator } from '../../orchestrator/index.js';
import { defaultLogPath } from '../../orchestrator/log-rotator.js';

const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 2000;

export interface NodesRoutesOptions {
  orchestrator: HostProcessOrchestrator;
}

export function registerNodesRoutes(app: FastifyInstance, opts: NodesRoutesOptions): void {
  const { orchestrator } = opts;

  app.get('/api/nodes', async () => {
    return { ok: true, data: { nodes: orchestrator.listNodes() } };
  });

  app.get<{ Params: { id: string } }>('/api/nodes/:id', async (request, reply) => {
    const node = orchestrator.getNode(request.params.id);
    if (!node) return notFound(reply, request.params.id);
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
      if (!node) return notFound(reply, request.params.id);
      const requested = Number(request.query.lines ?? DEFAULT_LOG_LINES);
      const tail = Number.isFinite(requested)
        ? Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(requested)))
        : DEFAULT_LOG_LINES;
      const lines = tailLogFile(defaultLogPath(node.workdir), tail);
      return { ok: true, data: { lines } };
    },
  );

  // start / stop / restart: real for the admin's owner node (started from the
  // persisted OwnerSpawnConfig). Donated-node lifecycle belongs to the donation
  // surface — those ids return a clear not_implemented that points there;
  // unknown ids 404.
  app.post<{ Params: { id: string } }>('/api/nodes/:id/stop', async (request, reply) => {
    const { id } = request.params;
    if (!orchestrator.isOwnerNode(id)) {
      return ownerOnlyFallback(reply, orchestrator, id, 'stop');
    }
    const dockerId = orchestrator.resolveDockerId(id);
    if (!dockerId) return notFound(reply, id);
    await orchestrator.stopContainer(dockerId);
    // The orchestrator emits its own onStateChange — createLocalUiServer
    // forwards that to the bus. Don't double-publish here.
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/nodes/:id/start', async (request, reply) => {
    const { id } = request.params;
    if (orchestrator.isOwnerNode(id)) {
      if (!orchestrator.hasOwnerConfig()) {
        return notImplemented(reply, `start ${id}: owner node has no saved spawn config.`);
      }
      const node = await orchestrator.ensureOwnerNode();
      return { ok: true, data: { node } };
    }
    return ownerOnlyFallback(reply, orchestrator, id, 'start');
  });

  app.post<{ Params: { id: string } }>('/api/nodes/:id/restart', async (request, reply) => {
    const { id } = request.params;
    if (orchestrator.isOwnerNode(id)) {
      if (!orchestrator.hasOwnerConfig()) {
        return notImplemented(reply, `restart ${id}: owner node has no saved spawn config.`);
      }
      const node = await orchestrator.restartOwnerNode();
      return { ok: true, data: { node } };
    }
    return ownerOnlyFallback(reply, orchestrator, id, 'restart');
  });
}

/**
 * 404 for unknown ids; 501 not_implemented for known non-owner nodes — all of
 * them donated. A donated node's containerId is its donation id, so the
 * message names `node.id` rather than the route param, which may be the
 * opaque dockerId — only the donation id is what the terminate command takes.
 */
function ownerOnlyFallback(
  reply: FastifyReply,
  orchestrator: HostProcessOrchestrator,
  id: string,
  verb: 'start' | 'stop' | 'restart',
) {
  const node = orchestrator.getNode(id);
  if (!node) return notFound(reply, id);
  return notImplemented(
    reply,
    `${verb} ${id}: only the owner node can be started, stopped or restarted here; a donated node's lifecycle is owned by the donation surface — end it with 'cadre-host grant terminate ${node.id}' (DELETE /grants-admin/donations/${node.id}).`,
  );
}

function notFound(reply: FastifyReply, id: string) {
  return reply.code(404).send({
    ok: false,
    error: { code: 'not_found', message: `Unknown node: ${id}` },
  });
}

function notImplemented(reply: FastifyReply, message: string) {
  return reply.code(501).send({ ok: false, error: { code: 'not_implemented', message } });
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

