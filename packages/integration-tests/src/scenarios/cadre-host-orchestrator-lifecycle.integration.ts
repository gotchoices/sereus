/**
 * Orchestrator lifecycle integration scenarios.
 *
 * The orchestrator is fed a test-only spawn entrypoint (idle-child.mjs) that
 * writes the startup token and idles forever. The cadre-host `/api/nodes`
 * routes are then exercised over HTTP to validate the list/detail/logs/stop
 * surface and the 501 stub for `start`.
 *
 * createContainer is invoked directly through the orchestrator handle since
 * there is no HTTP route for it in v1 (the auto-spawn path is deliberately
 * deferred — `/api/nodes/:id/start` is the stub that documents this).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { OWNER_CONTAINER_ID } from '@serfab/cadre-host';

import { createTestCadreHost, type TestCadreHost } from '../harness/index.js';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

const HERE = dirname(fileURLToPath(import.meta.url));
const IDLE_CHILD = join(HERE, '..', 'harness', 'fixtures', 'idle-child.mjs');

describe('cadre-host orchestrator lifecycle', () => {
	let host: TestCadreHost;
	const ownerDirs: string[] = [];

	beforeEach(async () => {
		host = await createTestCadreHost({ spawnEntrypoint: IDLE_CHILD, sseHeartbeatMs: 200 });
	});

	afterEach(async () => {
		// Best-effort stop of any leftover children before the temp dir is removed.
		for (const node of host.orchestrator.listNodes()) {
			try { await host.orchestrator.stopContainer(node.dockerId); } catch { /* ignore */ }
			try { await host.orchestrator.removeContainer(node.dockerId); } catch { /* ignore */ }
		}
		await host.stop();
		for (const dir of ownerDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function spawnNode(id: string): Promise<{ dockerId: string }> {
		const created = await host.orchestrator.createContainer({
			containerId: id,
			partyId: `party-${id}`,
			bootstrapNodes: [],
			profile: 'storage',
		});
		return { dockerId: created.dockerId };
	}

	it('GET /api/nodes lists registered children', async () => {
		await spawnNode('node-a');
		const res = await host.request({ method: 'GET', path: '/api/nodes' });
		expect(res.status).toBe(200);
		const body = res.body as { ok: true; data: { nodes: Array<{ id: string; status: string }> } };
		expect(body.ok).toBe(true);
		expect(body.data.nodes).toHaveLength(1);
		expect(body.data.nodes[0]!.id).toBe('node-a');
		expect(body.data.nodes[0]!.status).toBe('running');
	});

	it('GET /api/nodes/:id returns node + stats (object or null)', async () => {
		await spawnNode('node-b');
		const res = await host.request({ method: 'GET', path: '/api/nodes/node-b' });
		expect(res.status).toBe(200);
		const body = res.body as { ok: true; data: { node: { id: string; partyId: string }; stats: unknown } };
		expect(body.data.node.id).toBe('node-b');
		expect(body.data.node.partyId).toBe('party-node-b');
		// stats may be {cpuPercent,memoryBytes,...} or null on slow Windows boxes
		expect(body.data.stats === null || typeof body.data.stats === 'object').toBe(true);
	});

	it('GET /api/nodes/:id/logs tails the workdir log file', async () => {
		await spawnNode('node-c');
		// Seed node.log with deterministic content — the idle child doesn't write anything.
		const info = host.orchestrator.getNode('node-c');
		expect(info).toBeDefined();
		const logPath = join(info!.workdir, 'node.log');
		mkdirSync(dirname(logPath), { recursive: true });
		writeFileSync(logPath, '', 'utf8');
		appendFileSync(logPath, 'first line\nsecond line\n', 'utf8');

		const res = await host.request({ method: 'GET', path: '/api/nodes/node-c/logs' });
		expect(res.status).toBe(200);
		const body = res.body as { ok: true; data: { lines: string[] } };
		expect(body.data.lines).toEqual(['first line', 'second line']);
	});

	// Only the owner node's lifecycle belongs to this route; any other node is a
	// donated one, which the donation surface owns (see routes/nodes.ts).
	async function spawnOwnerNode(): Promise<void> {
		const dir = mkdtempSync(join(tmpdir(), 'cadre-host-owner-'));
		ownerDirs.push(dir);
		const identityPath = join(dir, 'identity.key');
		writeFileSync(identityPath, '', 'utf8'); // the idle child never reads it
		await host.orchestrator.ensureOwnerNode({ identityPath, partyId: 'party-owner', libp2pPort: await freePort() });
	}

	it('POST /api/nodes/:id/stop transitions the owner node to stopped and emits node-state-changed', async () => {
		await spawnOwnerNode();
		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			// Wait until the SSE handler has subscribed so the upcoming stop event fans out to us.
			const deadline = Date.now() + 2_000;
			while (host.server.events.listenerCount() <= baseline && Date.now() < deadline) {
				await new Promise<void>((r) => setTimeout(r, 20));
			}

			const stop = await host.request({ method: 'POST', path: `/api/nodes/${OWNER_CONTAINER_ID}/stop` });
			expect(stop.status).toBe(200);
			const ev = await stream.next(
				(e) => e.type === 'node-state-changed' && e.nodeId === OWNER_CONTAINER_ID && e.status === 'stopped',
				{ timeoutMs: 10_000 },
			);
			expect(ev).toMatchObject({ type: 'node-state-changed', nodeId: OWNER_CONTAINER_ID, status: 'stopped' });

			const after = await host.request({ method: 'GET', path: `/api/nodes/${OWNER_CONTAINER_ID}` });
			expect(after.status).toBe(200);
			const body = after.body as { data: { node: { status: string } } };
			expect(body.data.node.status).toBe('stopped');
		} finally {
			stream.close();
		}
	});

	it('POST /api/nodes/:id/stop refuses a non-owner node with 501 and leaves it running', async () => {
		await spawnNode('node-d');
		const res = await host.request({ method: 'POST', path: '/api/nodes/node-d/stop' });
		expect(res.status).toBe(501);
		expect(res.body).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
		expect(host.orchestrator.getNode('node-d')?.status).toBe('running');
	});

	it('POST /api/nodes/:id/start returns 501 not_implemented', async () => {
		await spawnNode('node-e');
		const res = await host.request({ method: 'POST', path: '/api/nodes/node-e/start' });
		expect(res.status).toBe(501);
		expect(res.body).toMatchObject({ ok: false, error: { code: 'not_implemented' } });
	});

	it('GET /api/nodes/unknown returns 404 with not_found', async () => {
		const res = await host.request({ method: 'GET', path: '/api/nodes/does-not-exist' });
		expect(res.status).toBe(404);
		expect(res.body).toMatchObject({ ok: false, error: { code: 'not_found' } });
	});
});
