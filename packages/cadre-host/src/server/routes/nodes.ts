/**
 * /api/nodes — list managed cadre nodes, look up one node's details, and tail
 * its log. Read-only: every node's lifecycle belongs to the donation surface,
 * whose supervisor would undo at once a stop issued anywhere else.
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
}

function notFound(reply: FastifyReply, id: string) {
  return reply.code(404).send({
    ok: false,
    error: { code: 'not_found', message: `Unknown node: ${id}` },
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

