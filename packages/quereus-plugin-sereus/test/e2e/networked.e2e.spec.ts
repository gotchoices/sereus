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
import { DEFAULT_STRAND_CLUSTER_SIZE, STRAND_CLUSTER_POLICY } from '../../src/cluster-size.js';
import type { SereusPluginResult, Libp2pNodeWithRepo } from '../../src/types.js';

/**
 * End-to-end suite for networked mode: two in-process libp2p peers exchanging
 * strand data over a real `createLibp2pNode` mesh, each backed by its own
 * `FileRawStorage`. No `vi.mock` calls — Vitest scopes the unit spec's mocks
 * to that file, so this suite uses real libp2p + real optimystic.
 *
 * Each peer uses `fretProfile: 'edge'` (the plugin default and the production
 * default for non-storage participants), `DEFAULT_STRAND_CLUSTER_SIZE` and
 * `STRAND_CLUSTER_POLICY` — the same breadth and policy `CadreNode` and
 * `connectToStrand` resolve for a strand network, shared rather than hand-copied so
 * this mesh cannot drift from the production one it stands in for. Every
 * peer on one network must declare the same size: a member whose configured
 * size exceeds the peer set the coordinator declares refuses to vote on the
 * write, and one refusal fails the commit.
 *
 * The second suite below covers what that default number does at strand sizes
 * either side of it — see its header.
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

/**
 * The loopback TCP multiaddr a peer can be dialled on, preferred over any other interface
 * the node happens to be listening on (a dev box with a LAN or VPN adapter advertises
 * several, and `getMultiaddrs()[0]` is not guaranteed to be the loopback one).
 */
// Taken off `getMultiaddrs` rather than imported from `@multiformats/multiaddr`, so the type
// is always the one this libp2p's `dial` accepts even if two copies of that package resolve.
type NodeMultiaddr = ReturnType<Libp2p['getMultiaddrs']>[number];

function pickLocalMultiaddr(node: Libp2p): NodeMultiaddr {
	const addrs = node.getMultiaddrs();
	const local = addrs.find(ma => ma.toString().startsWith('/ip4/127.0.0.1/tcp/') && ma.toString().includes('/p2p/'))
		?? addrs.find(ma => ma.toString().includes('/tcp/') && ma.toString().includes('/p2p/'));
	if (!local) throw new Error(`No usable TCP multiaddr on node; have: ${addrs.join(', ')}`);
	return local;
}

/** {@link pickLocalMultiaddr} as the string form `bootstrapNodes` expects. */
function pickLocalAddr(node: Libp2p): string {
	return pickLocalMultiaddr(node).toString();
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
		clusterPolicy: STRAND_CLUSTER_POLICY,
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
	// Tracked in scope for `4-scale-testing`. A *four*-node strand is the case that
	// does survive losing a holder — see 'strand sizes under the default breadth'.
	it.todo('peer A continues accepting writes after peer B shuts down (needs cluster downsize support)');
});

/**
 * What `DEFAULT_STRAND_CLUSTER_SIZE` (4) does at strand sizes either side of it.
 *
 * The constant is a replication *target*, not a precondition. Optimystic caps a cohort
 * at the peers that actually serve the network and shrinks one it cannot fill
 * (`allowDownsize: true`, which every strand path passes), and the commit bar is
 * `ceil(actualCohortSize x 0.75)` computed from the cohort that formed — not from the
 * configured target. Two consequences, both asserted rather than assumed, because
 * raising the target from 2 to 4 is exactly the change that would break them if either
 * stopped holding:
 *
 *  - a strand smaller than the target still commits (1, 2 and 3 nodes below), and
 *  - a strand *at* the target commits with one holder gone — `ceil(4 x 0.75) = 3` of 4,
 *    which is the entire reason the default is 4 and not 2 or 3.
 *
 * These build real meshes, so they are slower than the suite above; each carries its own
 * timeout.
 */
describe('strand sizes under the default breadth', () => {
	let peers: PeerHandle[] = [];

	beforeEach(() => {
		peers = [];
	});

	afterEach(async () => {
		// Reverse order: later peers dialled earlier ones, so release their sockets first.
		for (const peer of [...peers].reverse()) await tearDown(peer);
		peers = [];
	});

	/**
	 * Start `count` peers on a fresh strand and dial them into a full mesh. Peer 0 is the
	 * schema author and bootstrap; the rest bootstrap off it and then dial each other, so
	 * cluster consensus can reach every member rather than routing through peer 0.
	 */
	async function startMesh(count: number): Promise<PeerHandle[]> {
		const strandId = randomUUID();
		const first = await startPeer(strandId, TEST_SCHEMA, [], await makeDir('mesh0'));
		peers.push(first);

		const bootstrapAddr = pickLocalAddr(first.node);
		for (let i = 1; i < count; i++) {
			peers.push(await startPeer(strandId, TEST_SCHEMA, [bootstrapAddr], await makeDir(`mesh${i}`)));
		}

		// j starts at 1: every peer already reaches peer 0 through the bootstrap above.
		for (let i = 1; i < count; i++) {
			for (let j = 1; j < i; j++) {
				await peers[i]!.node.dial(pickLocalMultiaddr(peers[j]!.node));
			}
		}

		// NOTE: this gate proves the TCP mesh formed, not that FRET has classified every
		// peer as serving the strand — the cohort could still be narrower than the mesh
		// for a moment after it passes. Sufficient on loopback at 1-4 peers; if these
		// tests turn flaky on slower hardware or at larger sizes, replace it with a wait
		// on the node's own cohort (`keyNetwork.findCluster`, as the integration-tests
		// harness does in `readCohort`) rather than lengthening the timeout.
		await waitUntil(
			() => peers.every(p => p.node.getConnections().length >= count - 1),
			{ timeoutMs: 20_000, description: `all ${count} peers to see ${count - 1} connections each` },
		);
		return [...peers];
	}

	async function countRows(peer: PeerHandle): Promise<number> {
		const rows = await selectAll<{ c: number }>(peer.db, 'select count(*) as c from App.Msg');
		return rows[0]?.c ?? 0;
	}

	for (const size of [1, 2, 3]) {
		it(`commits a write on a ${size}-node strand, below the breadth-4 target`, async () => {
			// The regression `bug-cluster-size-exceeds-cadre-size` was filed for: a target
			// wider than the strand must downsize, not deadlock. At 3 the cohort is all
			// three and the 0.75 bar is unanimity (`ceil(3 x 0.75) = 3`) — narrower than
			// the same strand ran at breadth 2, where only two of the three voted.
			const mesh = await startMesh(size);
			const author = mesh[0]!;

			// The commit assertion is the `exec` itself — a cohort that failed to reach its
			// super-majority rejects here rather than returning.
			await author.db.exec(`insert into App.Msg(Id, Body) values (1, 'small-strand')`);

			// Every peer, not only the author: a strand at or below the breadth-4 target puts
			// all of its peers in every cohort, so the row must be visible from each. This is
			// the "more parties means more copies" half of raising the default, and it is what
			// would fail if the cohort silently narrowed. It reads rather than inspecting local
			// storage, so a peer that fetched the block on demand also passes — the assertion
			// is availability from every member, not proof of a local copy.
			await waitUntil(
				async () => (await Promise.all(mesh.map(countRows))).every(c => c === 1),
				{ timeoutMs: 20_000, description: `all ${size} peer(s) to observe the committed write` },
			);
			for (const peer of mesh) {
				const rows = await selectAll<{ Id: number; Body: string }>(peer.db, 'select Id, Body from App.Msg');
				expect(rows).toEqual([{ Id: 1, Body: 'small-strand' }]);
			}
		}, 60_000);
	}

	it('commits a write on a 4-node strand after one holder stops', async () => {
		// The justification for the number, exercised rather than restated: at a breadth
		// of 4 every peer is in every cohort, so stopping one removes a genuine holder.
		// `ceil(4 x 0.75) = 3` still approves. At 2 or 3 this write would fail, because
		// every holder must be awake for every write at those breadths.
		const mesh = await startMesh(4);
		const author = mesh[0]!;
		const doomed = mesh[3]!;

		await author.db.exec(`insert into App.Msg(Id, Body) values (1, 'all-four-up')`);
		await waitUntil(
			async () => await countRows(doomed) === 1,
			{ timeoutMs: 20_000, description: 'the fourth peer to observe the first write' },
		);

		await tearDown(doomed);
		peers = peers.filter(p => p !== doomed);
		await waitUntil(
			() => author.node.getConnections().length <= 2,
			{ timeoutMs: 20_000, description: 'the author to notice the stopped peer is gone' },
		);

		// The stopped peer may still be selected into the cohort (its advertised protocols
		// linger in the peerStore), in which case the coordinator waits out its dial before
		// counting 3 of 4. That wait is why this test's budget is generous.
		//
		// NOTE: measured 43-48 s wall-clock across three runs on a win32 dev box, so the
		// 120 s budget carries roughly 2.5x headroom and the second insert is the bulk of
		// it. If a slower machine starts tripping the budget, raise it — the claim is that
		// the write COMMITS with a holder gone, not that it commits quickly.
		await author.db.exec(`insert into App.Msg(Id, Body) values (2, 'one-holder-down')`);

		const rows = await selectAll<{ Id: number; Body: string }>(author.db, 'select Id, Body from App.Msg order by Id');
		expect(rows).toEqual([
			{ Id: 1, Body: 'all-four-up' },
			{ Id: 2, Body: 'one-holder-down' },
		]);
	}, 120_000);
});
