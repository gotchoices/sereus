/**
 * sidecar.mjs — HTTP sidecar for drone test fixture.
 *
 * Provides REST endpoints for Maestro test orchestration,
 * using Node's built-in http module (no extra dependencies).
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Create the HTTP sidecar server.
 *
 * @param {import('@serfab/cadre-core').CadreNode} node
 * @param {import('@serfab/cadre-core').SAppConfig} sAppConfig
 * @returns {import('node:http').Server}
 */
export function createSidecar(node, sAppConfig) {
	return createServer(async (req, res) => {
		try {
			const url = new URL(req.url, `http://${req.headers.host}`);
			const { method } = req;

			if (method === 'GET' && url.pathname === '/health') {
				return send(res, 200, { ok: true });
			}

			if (method === 'GET' && url.pathname === '/status') {
				return send(res, 200, getStatus(node));
			}

			if (method === 'POST' && url.pathname === '/seed/create') {
				const seed = await node.createSeed();
				const encoded = node.encodeSeed(seed);
				return send(res, 200, { encoded });
			}

			if (method === 'POST' && url.pathname === '/strand/create') {
				const body = await readBody(req);
				const strandId = body.strandId || randomUUID();
				const strand = await node.addStrand({
					strandRow: { Id: strandId, MemberPrivateKey: null, Type: 'o' },
					sAppConfig,
				});
				return send(res, 200, { strandId, status: strand.status });
			}

			if (method === 'POST' && url.pathname === '/message/insert') {
				const body = await readBody(req);
				if (!body.strandId || !body.memberId || !body.content) {
					return send(res, 400, {
						error: 'strandId, memberId, and content are required',
					});
				}
				const message = await insertMessage(
					node, body.strandId, body.memberId, body.content,
				);
				return send(res, 200, { message });
			}

			const messagesMatch = url.pathname.match(/^\/messages\/(.+)$/);
			if (method === 'GET' && messagesMatch) {
				const strandId = decodeURIComponent(messagesMatch[1]);
				const messages = await queryMessages(node, strandId);
				return send(res, 200, { messages });
			}

			const membersMatch = url.pathname.match(/^\/members\/(.+)$/);
			if (method === 'GET' && membersMatch) {
				const strandId = decodeURIComponent(membersMatch[1]);
				const members = await queryMembers(node, strandId);
				return send(res, 200, { members });
			}

			send(res, 404, { error: 'Not found' });
		} catch (err) {
			console.error('Sidecar error:', err);
			send(res, 500, { error: err.message });
		}
	});
}

// ── Route helpers ──────────────────────────────────────────────────────────

function getStatus(node) {
	const strands = [];
	for (const [id, instance] of node.getStrands()) {
		strands.push({
			strandId: id,
			status: instance.status,
			connectedPeers: instance.connectedPeers,
		});
	}
	return {
		peerId: node.peerId?.toString() ?? null,
		strands,
		connected: node.isRunning,
	};
}

function getStrandDb(node, strandId) {
	const strand = node.getStrand(strandId);
	if (!strand) throw new Error(`Strand ${strandId} not found`);
	if (!strand.database) {
		throw new Error(`Strand ${strandId} database not available (status: ${strand.status})`);
	}
	return strand.database.getDatabase();
}

async function insertMessage(node, strandId, memberId, content) {
	const db = getStrandDb(node, strandId);

	// Auto-register member if absent
	await db.exec(
		'insert or ignore into App.Member (Id, Name) values (?, ?)',
		[memberId, memberId],
	);

	// Quereus datetime columns coerce any valid input to T-separated ISO form on read.
	const now = new Date().toISOString();

	// Collision-free text UUID key (matches the phone app's chat-operations.ts) —
	// a max(Id)+1 read would collide when this drone and the phone post concurrently.
	const id = randomUUID();

	await db.exec(
		'insert into App.Message (Id, MemberId, Content, Timestamp) values (?, ?, ?, ?)',
		[id, memberId, content, now],
	);

	return { Id: id, MemberId: memberId, Content: content, Timestamp: now };
}

async function queryMessages(node, strandId) {
	const db = getStrandDb(node, strandId);
	const messages = [];
	for await (const row of db.eval(
		`select M.Id, M.MemberId, M.Content, M.Timestamp, Mem.Name as MemberName
		 from App.Message M
		 left join App.Member Mem on Mem.Id = M.MemberId
		 order by M.Timestamp asc, M.Id asc
		 limit 1000`,
	)) {
		messages.push({
			Id: row.Id,
			MemberId: row.MemberId,
			Content: row.Content,
			Timestamp: row.Timestamp,
			MemberName: row.MemberName ?? undefined,
		});
	}
	return messages;
}

async function queryMembers(node, strandId) {
	const db = getStrandDb(node, strandId);
	const members = [];
	for await (const row of db.eval('select Id, Name from App.Member')) {
		members.push({ Id: row.Id, Name: row.Name });
	}
	return members;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function send(res, status, body) {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(json),
	});
	res.end(json);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', (chunk) => chunks.push(chunk));
		req.on('end', () => {
			try {
				const raw = Buffer.concat(chunks).toString();
				resolve(raw ? JSON.parse(raw) : {});
			} catch (_err) {
				reject(new Error('Invalid JSON body'));
			}
		});
		req.on('error', reject);
	});
}
