import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Database } from '@quereus/quereus';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import { createLibp2pNode } from '@optimystic/db-p2p';
import type { Libp2p } from '@libp2p/interface';
import { connectToStrand } from '../../src/connect.js';
import { DEFAULT_STRAND_CLUSTER_SIZE } from '../../src/cluster-size.js';
import type { SereusPluginResult, Libp2pNodeWithRepo } from '../../src/types.js';

/**
 * End-to-end suite for networked mode: two in-process libp2p peers exchanging
 * strand data over a real `createLibp2pNode` mesh, each backed by its own
 * `FileRawStorage`. No `vi.mock` calls — Vitest scopes the unit spec's mocks
 * to that file, so this suite uses real libp2p + real optimystic.
 *
 * Each peer uses `fretProfile: 'edge'` (the plugin default and the production
 * default for non-storage participants) and `DEFAULT_STRAND_CLUSTER_SIZE` — the same
 * value `CadreNode` and `connectToStrand` resolve for a strand network. Every
 * peer on one network must declare the same size: a member whose configured
 * size exceeds the peer set the coordinator declares refuses to vote on the
 * write, and one refusal fails the commit.
 *
 * Replication is not event-driven on `IRepo`, so the assertions poll via
 * `waitUntil` (10s default) — matching the integration-tests harness pattern.
 */

const TEST_SCHEMA = 'table Msg (Id integer primary key, Body text not null)';

interface PeerHandle {
	db: Database;
	node: Libp2p;
	result: SereusPluginResult;
	storage: FileRawStorage;
	dir: string;
}

async function waitUntil(
	condition: () => Promise<boolean> | boolean,
	options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
	const { timeoutMs = 10_000, intervalMs = 100, description = 'condition' } = options;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			if (await condition()) return;
		} catch {
			// Keep waiting through transient errors (e.g. strand not yet
			// readable on a fresh peer).
		}
		await new Promise(r => setTimeout(r, intervalMs));
	}
	throw new Error(`Timeout waiting for ${description} after ${timeoutMs}ms`);
}

async function selectAll<T>(db: Database, sql: string): Promise<T[]> {
	const rows: T[] = [];
	for await (const row of db.eval(sql)) rows.push(row as T);
	return rows;
}

function pickLocalAddr(node: Libp2p): string {
	const addrs = node.getMultiaddrs().map(ma => ma.toString());
	const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/') && a.includes('/p2p/'))
		?? addrs.find(a => a.includes('/tcp/') && a.includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

async function makeDir(label: string): Promise<string> {
	const dir = path.join(os.tmpdir(), 'sereus-plugin-networked-e2e', `${label}-${randomUUID()}`);
	await fs.mkdir(dir, { recursive: true });
	return dir;
}

async function startPeer(
	strandId: string,
	schema: string | undefined,
	bootstrapNodes: string[],
	storageDir: string,
): Promise<PeerHandle> {
	const storage = new FileRawStorage(storageDir);
	const node = await createLibp2pNode({
		port: 0,
		bootstrapNodes,
		networkName: `strand-${strandId}`,
		fretProfile: 'edge',
		storage,
		clusterSize: DEFAULT_STRAND_CLUSTER_SIZE,
		clusterPolicy: { allowDownsize: true, sizeTolerance: 0.5 },
	}) as Libp2pNodeWithRepo;
	const coordinatedRepo = node.coordinatedRepo;
	if (!coordinatedRepo) {
		await node.stop();
		throw new Error('coordinatedRepo not present on libp2p node');
	}

	const db = new Database();
	const result = await connectToStrand(db, {
		strandId,
		libp2pNode: node,
		coordinatedRepo,
		schema,
		fretProfile: 'edge',
	});

	return { db, node, result, storage, dir: storageDir };
}

async function safeRm(dir: string): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fs.rm(dir, { recursive: true, force: true });
			return;
		} catch (err) {
			if (attempt === 0) {
				await new Promise(r => setTimeout(r, 50));
				continue;
			}
			console.error('cleanup failed for', dir, err);
		}
	}
}

async function tearDown(peer: PeerHandle | null): Promise<void> {
	if (!peer) return;
	try {
		await peer.result.shutdown();
	} catch (err) {
		console.error('result.shutdown error:', err);
	}
	try {
		peer.db.close();
	} catch (err) {
		console.error('db.close error:', err);
	}
	try {
		if (peer.node.status === 'started') await peer.node.stop();
	} catch (err) {
		console.error('node.stop error:', err);
	}
	await safeRm(peer.dir);
}

describe('connectToStrand (networked e2e)', () => {
	let peerA: PeerHandle | null = null;
	let peerB: PeerHandle | null = null;

	beforeEach(() => {
		peerA = null;
		peerB = null;
	});

	afterEach(async () => {
		// Tear down B first to release its socket before A is stopped.
		await tearDown(peerB);
		peerB = null;
		await tearDown(peerA);
		peerA = null;
	});

	it('replicates a single insert from peer A to peer B', async () => {
		const strandId = randomUUID();
		const dirA = await makeDir('peerA');
		peerA = await startPeer(strandId, TEST_SCHEMA, [], dirA);

		const bootstrapAddr = pickLocalAddr(peerA.node);
		const dirB = await makeDir('peerB');
		peerB = await startPeer(strandId, TEST_SCHEMA, [bootstrapAddr], dirB);

		await waitUntil(
			() => peerB!.node.getConnections().length >= 1,
			{ description: 'peer B to connect to peer A' },
		);

		await peerA.db.exec(`insert into App.Msg(Id, Body) values (1, 'hello')`);

		await waitUntil(
			async () => {
				const rows = await selectAll<{ c: number }>(peerB!.db, 'select count(*) as c from App.Msg');
				return rows[0]?.c >= 1;
			},
			{ description: 'peer B to see the row inserted on peer A' },
		);

		const rowsB = await selectAll<{ Id: number; Body: string }>(peerB.db, 'select Id, Body from App.Msg order by Id');
		expect(rowsB).toEqual([{ Id: 1, Body: 'hello' }]);
	});

	it('bidirectional writes converge on both peers', async () => {
		const strandId = randomUUID();
		const dirA = await makeDir('peerA');
		peerA = await startPeer(strandId, TEST_SCHEMA, [], dirA);

		const bootstrapAddr = pickLocalAddr(peerA.node);
		const dirB = await makeDir('peerB');
		peerB = await startPeer(strandId, TEST_SCHEMA, [bootstrapAddr], dirB);

		await waitUntil(
			() => peerB!.node.getConnections().length >= 1,
			{ description: 'peer B to connect to peer A' },
		);

		await peerA.db.exec(`insert into App.Msg(Id, Body) values (1, 'a')`);
		await peerB.db.exec(`insert into App.Msg(Id, Body) values (2, 'b')`);

		const expected = [
			{ Id: 1, Body: 'a' },
			{ Id: 2, Body: 'b' },
		];

		await waitUntil(
			async () => {
				const a = await selectAll<{ c: number }>(peerA!.db, 'select count(*) as c from App.Msg');
				const b = await selectAll<{ c: number }>(peerB!.db, 'select count(*) as c from App.Msg');
				return a[0]?.c === 2 && b[0]?.c === 2;
			},
			{ description: 'both peers to converge on count=2' },
		);

		const rowsA = await selectAll<{ Id: number; Body: string }>(peerA.db, 'select Id, Body from App.Msg order by Id');
		const rowsB = await selectAll<{ Id: number; Body: string }>(peerB.db, 'select Id, Body from App.Msg order by Id');
		expect(rowsA).toEqual(expected);
		expect(rowsB).toEqual(expected);
	});

	it('late-joining peer catches up to existing strand state', async () => {
		const strandId = randomUUID();
		const dirA = await makeDir('peerA');
		peerA = await startPeer(strandId, TEST_SCHEMA, [], dirA);

		await peerA.db.exec(`insert into App.Msg(Id, Body) values (1, 'one'), (2, 'two'), (3, 'three')`);
		await waitUntil(
			async () => {
				const rows = await selectAll<{ c: number }>(peerA!.db, 'select count(*) as c from App.Msg');
				return rows[0]?.c === 3;
			},
			{ description: 'peer A to see its own 3 inserts' },
		);

		const bootstrapAddr = pickLocalAddr(peerA.node);
		const dirB = await makeDir('peerB');
		peerB = await startPeer(strandId, TEST_SCHEMA, [bootstrapAddr], dirB);

		await waitUntil(
			() => peerB!.node.getConnections().length >= 1,
			{ description: 'peer B to connect to peer A' },
		);

		await waitUntil(
			async () => {
				const rows = await selectAll<{ c: number }>(peerB!.db, 'select count(*) as c from App.Msg');
				return rows[0]?.c === 3;
			},
			{ description: 'late-joining peer B to catch up to 3 rows' },
		);

		const rowsB = await selectAll<{ Id: number; Body: string }>(peerB.db, 'select Id, Body from App.Msg order by Id');
		expect(rowsB).toEqual([
			{ Id: 1, Body: 'one' },
			{ Id: 2, Body: 'two' },
			{ Id: 3, Body: 'three' },
		]);
	});

	it('peer A keeps serving reads after peer B shuts down', async () => {
		const strandId = randomUUID();
		const dirA = await makeDir('peerA');
		peerA = await startPeer(strandId, TEST_SCHEMA, [], dirA);

		const bootstrapAddr = pickLocalAddr(peerA.node);
		const dirB = await makeDir('peerB');
		peerB = await startPeer(strandId, TEST_SCHEMA, [bootstrapAddr], dirB);

		await waitUntil(
			() => peerB!.node.getConnections().length >= 1,
			{ description: 'peer B to connect to peer A' },
		);

		await peerA.db.exec(`insert into App.Msg(Id, Body) values (10, 'pre-shutdown')`);
		await waitUntil(
			async () => {
				const rows = await selectAll<{ c: number }>(peerB!.db, 'select count(*) as c from App.Msg');
				return rows[0]?.c >= 1;
			},
			{ description: 'peer B to observe peer A insert before shutdown' },
		);

		await tearDown(peerB);
		peerB = null;

		// Peer A serves reads from its local repo; no quorum needed.
		const rows = await selectAll<{ Id: number; Body: string }>(peerA.db, 'select Id, Body from App.Msg order by Id');
		expect(rows).toEqual([{ Id: 10, Body: 'pre-shutdown' }]);
	});

	// Post-shutdown writes on the surviving peer are not asserted here. The
	// cluster floors at `minAbsoluteClusterSize: 2` (hardcoded in
	// `db-p2p/libp2p-node-base.ts`'s `consensusConfig`), so once peer B vanishes,
	// peer A's commit path returns "Failed to get super-majority: 1/2 approvals".
	// Recovery would require partition detection + cluster downsize (60s window
	// per `partitionDetectionWindow`) or a fundamentally different topology.
	// Tracked in scope for `4-scale-testing`.
	it.todo('peer A continues accepting writes after peer B shuts down (needs cluster downsize support)');
});
