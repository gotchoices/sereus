import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Database, type SqlValue } from '@quereus/quereus';
import type { Libp2p } from '@libp2p/interface';
import { DEFAULT_SUPER_MAJORITY_THRESHOLD, type IRepo } from '@optimystic/db-core';
import { digest } from '@optimystic/quereus-plugin-crypto';
import { parseConfig } from '../src/plugin.js';
import { connectToStrand } from '../src/connect.js';
import {
	CONTROL_REPLICATION_BREADTH,
	DEFAULT_STRAND_CLUSTER_SIZE,
	MIN_CLUSTER_SIZE,
	resolveStrandClusterSize
} from '../src/cluster-size.js';

// Mock only createLibp2pNode while preserving all other exports from db-p2p
vi.mock('@optimystic/db-p2p', async (importOriginal) => {
	const mod = await importOriginal<typeof import('@optimystic/db-p2p')>();
	return {
		...mod,
		createLibp2pNode: vi.fn(async () => {
			const mockNode = {
				peerId: { toString: () => 'mock-peer-id' },
				stop: vi.fn(async () => {}),
				coordinatedRepo: createMockRepo(),
				getMultiaddrs: () => [],
				getConnections: () => [],
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			};
			return mockNode;
		}),
	};
});

function createMockRepo() {
	return {
		get: vi.fn(),
		pend: vi.fn(),
		commit: vi.fn(),
		cancel: vi.fn(),
	};
}

function createMockNode() {
	return {
		peerId: { toString: () => 'mock-peer-id' },
		stop: vi.fn(async () => {}),
		getMultiaddrs: () => [],
		getConnections: () => [],
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	} as unknown as Libp2p;
}

describe('parseConfig', () => {
	it('should parse minimal config with strand_id', () => {
		const result = parseConfig({ strand_id: 'abc-123' });
		expect(result.strandId).toBe('abc-123');
		expect(result.bootstrapNodes).toEqual([]);
		expect(result.schema).toBeUndefined();
		expect(result.sAppId).toBe('unknown');
		expect(result.sAppVersion).toBe('1.0.0');
		expect(result.port).toBe(0);
		expect(result.enableCache).toBe(true);
		expect(result.fretProfile).toBe('edge');
	});

	it('should throw when strand_id is missing', () => {
		expect(() => parseConfig({})).toThrow('strand_id is required');
	});

	it('should throw when strand_id is empty', () => {
		expect(() => parseConfig({ strand_id: '' })).toThrow('strand_id is required');
	});

	it('should parse bootstrap_nodes as comma-separated list', () => {
		const result = parseConfig({
			strand_id: 'abc',
			bootstrap_nodes: '/ip4/1.2.3.4/tcp/9100/p2p/A, /ip4/5.6.7.8/tcp/9100/p2p/B',
		});
		expect(result.bootstrapNodes).toEqual([
			'/ip4/1.2.3.4/tcp/9100/p2p/A',
			'/ip4/5.6.7.8/tcp/9100/p2p/B',
		]);
	});

	it('should handle empty bootstrap_nodes', () => {
		const result = parseConfig({ strand_id: 'abc', bootstrap_nodes: '' });
		expect(result.bootstrapNodes).toEqual([]);
	});

	it('should parse schema string', () => {
		const result = parseConfig({
			strand_id: 'abc',
			schema: 'table Msg (Id integer primary key, Body text)',
		});
		expect(result.schema).toBe('table Msg (Id integer primary key, Body text)');
	});

	it('should parse sapp_id and sapp_version', () => {
		const result = parseConfig({
			strand_id: 'abc',
			sapp_id: 'my-app-key',
			sapp_version: '2.0.0',
		});
		expect(result.sAppId).toBe('my-app-key');
		expect(result.sAppVersion).toBe('2.0.0');
	});

	it('should parse port as number', () => {
		const result = parseConfig({ strand_id: 'abc', port: 9100 });
		expect(result.port).toBe(9100);
	});

	it('should parse enable_cache as boolean', () => {
		expect(parseConfig({ strand_id: 'abc', enable_cache: false }).enableCache).toBe(false);
		expect(parseConfig({ strand_id: 'abc', enable_cache: 0 }).enableCache).toBe(false);
		expect(parseConfig({ strand_id: 'abc', enable_cache: true }).enableCache).toBe(true);
		expect(parseConfig({ strand_id: 'abc', enable_cache: 1 }).enableCache).toBe(true);
	});

	it('should parse fret_profile', () => {
		expect(parseConfig({ strand_id: 'abc', fret_profile: 'core' }).fretProfile).toBe('core');
		expect(parseConfig({ strand_id: 'abc', fret_profile: 'edge' }).fretProfile).toBe('edge');
		expect(parseConfig({ strand_id: 'abc', fret_profile: 'unknown' }).fretProfile).toBe('edge');
	});

	it('should parse every known transactor', () => {
		expect(parseConfig({ strand_id: 'abc', transactor: 'local' }).transactor).toBe('local');
		expect(parseConfig({ strand_id: 'abc', transactor: 'network' }).transactor).toBe('network');
		expect(parseConfig({ strand_id: 'abc', transactor: 'test' }).transactor).toBe('test');
	});

	it('should leave the transactor unset when absent or empty', () => {
		// Unset, so `composeStrand` applies the default — see its resolution.
		expect(parseConfig({ strand_id: 'abc' }).transactor).toBeUndefined();
		expect(parseConfig({ strand_id: 'abc', transactor: '' }).transactor).toBeUndefined();
	});

	it('should reject an unrecognised transactor rather than silently defaulting', () => {
		// A typo that fell back to 'network' would surface only as a mystifying
		// hang on a machine with no peers, so it throws at parse time.
		expect(() => parseConfig({ strand_id: 'abc', transactor: 'locl' }))
			.toThrow(/transactor must be one of/);
		expect(() => parseConfig({ strand_id: 'abc', transactor: 'bootstrap' }))
			.toThrow(/transactor must be one of/);
		expect(() => parseConfig({ strand_id: 'abc', transactor: 7 }))
			.toThrow(/transactor must be one of/);
	});

	it('should ignore a key it does not know, including the retired `mode`', () => {
		// `parseConfig` has no allowlist: the loader hands through whatever the
		// host's settings file holds, and unknown keys are dropped. Pinned so the
		// silent-drop contract is a decision on record rather than an accident.
		const result = parseConfig({ strand_id: 'abc', mode: 'bootstrap', nonsense: 'x' });
		expect(result.strandId).toBe('abc');
		expect(result.transactor).toBeUndefined();
		expect(result as unknown as Record<string, unknown>).not.toHaveProperty('mode');
	});
});

describe('connectToStrand', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		vi.mocked(createLibp2pNode).mockClear();
	});

	afterEach(() => {
		db.close();
	});

	it('should register crypto functions', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-1',
			transactor: 'test',
		});

		// Verify crypto functions are registered by calling the variadic digest. The
		// SQL function fixes algorithm + output encoding at load (sha256 / base64url) and
		// is variadic over data fields, so digest('hello') is the framed single-TEXT-field
		// digest — i.e. the JS digest(['hello']) base64url string, NOT sha256('hello').
		const expected = digest(['hello']) as string;
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const row of db.eval("select digest('hello') as h")) {
			rows.push(row);
		}
		expect(rows).toHaveLength(1);
		expect(rows[0].h).toBe(expected);

		await result.shutdown();
	});

	it('should register StampId function', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-2',
			transactor: 'test',
		});

		// StampId() returns null outside a transaction context, but the function should exist
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const row of db.eval('select StampId() as sid')) {
			rows.push(row);
		}
		expect(rows).toHaveLength(1);

		await result.shutdown();
	});

	it('should apply schema when provided', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-3',
			transactor: 'test',
			schema: 'table Message (Id integer primary key, Content text not null)',
		});

		// The App.Message table should exist and be queryable
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const row of db.eval('select * from App.Message')) {
			rows.push(row);
		}
		expect(rows).toHaveLength(0);

		await result.shutdown();
	});

	it('should not create App schema when no schema provided', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-4',
			transactor: 'test',
		});

		// Selecting from App.* should fail since no schema was applied
		await expect(async () => {
			for await (const _row of db.eval('select * from App.Message')) {
				// should not reach
			}
		}).rejects.toThrow();

		await result.shutdown();
	});

	it('should use injected libp2p node when provided', async () => {
		const mockNode = createMockNode();
		const mockRepo = createMockRepo();

		const result = await connectToStrand(db, {
			strandId: 'test-strand-5',
			transactor: 'test',
			libp2pNode: mockNode,
			coordinatedRepo: mockRepo as unknown as IRepo,
		});

		// createLibp2pNode should NOT have been called
		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).not.toHaveBeenCalled();

		await result.shutdown();
	});

	it('should throw when libp2pNode is provided without coordinatedRepo', async () => {
		const mockNode = createMockNode();

		await expect(connectToStrand(db, {
			strandId: 'test-strand-6',
			libp2pNode: mockNode,
		})).rejects.toThrow('coordinatedRepo is required');
	});

	it('should return valid SereusPluginResult shape', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-7',
			transactor: 'test',
		});

		expect(result.vtables).toEqual([]);
		expect(result.functions).toEqual([]);
		expect(result.collations).toEqual([]);
		expect(result.transactor).toBe('test');
		expect(typeof result.shutdown).toBe('function');

		await result.shutdown();
	});

	it('should report the transactor it resolved to', async () => {
		// The result is the only thing a caller (or a spec whose point is the arm
		// it runs on) can read to know which engine it actually got. The default
		// ('network') is pinned where it can be exercised for real, in cadre-core's
		// `strand-transactor-handover.spec.ts` phase 2 — a mock node cannot satisfy
		// the coordinator lookup the network transactor's hydrate performs.
		const result = await connectToStrand(db, {
			strandId: 'test-strand-resolved',
			transactor: 'local',
		});
		expect(result.transactor).toBe('local');
		await result.shutdown();
	});

	it('should set default vtab to optimystic', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-8',
			transactor: 'test',
			schema: 'table TestTable (Id integer primary key, Name text)',
		});

		// If default vtab is set correctly, tables created via `declare schema`
		// (which omit USING) are backed by the optimystic module.
		const rows: Array<Record<string, SqlValue>> = [];
		for await (const row of db.eval('select * from App.TestTable')) {
			rows.push(row);
		}
		expect(rows).toHaveLength(0);

		await result.shutdown();
	});

	it('should skip node creation for test transactor', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-skip',
			transactor: 'test',
		});

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).not.toHaveBeenCalled();

		await result.shutdown();
	});

	it('should create a node for a real (non-test) transactor', async () => {
		// `local` exercises the same "non-test transactor ⇒ create a node" branch
		// but routes the shared composition's catalog hydrate through the in-memory
		// local transactor. The default `network` transactor would drive hydrate
		// into a real libp2p coordinator lookup the mock node cannot satisfy; that
		// path is covered with real nodes in networked.e2e.spec.ts.
		const result = await connectToStrand(db, {
			strandId: 'test-strand-net',
			transactor: 'local',
		});

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).toHaveBeenCalledOnce();

		await result.shutdown();
	});

	it('should create the node with the default cluster size', async () => {
		// Omitting clusterSize must NOT fall through to optimystic's own default
		// (10), which gates every write on a party smaller than ten nodes.
		const result = await connectToStrand(db, {
			strandId: 'test-strand-cluster-default',
			transactor: 'local',
		});

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).toHaveBeenCalledWith(
			expect.objectContaining({ clusterSize: DEFAULT_STRAND_CLUSTER_SIZE }),
		);

		await result.shutdown();
	});

	it('should forward an explicit cluster size to the node', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-cluster-override',
			transactor: 'local',
			clusterSize: 5,
		});

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).toHaveBeenCalledWith(
			expect.objectContaining({ clusterSize: 5 }),
		);

		await result.shutdown();
	});

	it('should reject a cluster size below the optimystic minimum before creating a node', async () => {
		await expect(connectToStrand(db, {
			strandId: 'test-strand-cluster-invalid',
			transactor: 'local',
			clusterSize: 1,
		})).rejects.toThrow(/clusterSize must be an integer >= 2/);

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		expect(createLibp2pNode).not.toHaveBeenCalled();
	});

	it('should stop created node on shutdown', async () => {
		const result = await connectToStrand(db, {
			strandId: 'test-strand-9',
			transactor: 'local',
		});

		await result.shutdown();

		const { createLibp2pNode } = await import('@optimystic/db-p2p');
		const mockNode = await vi.mocked(createLibp2pNode).mock.results[0].value;
		expect(mockNode.stop).toHaveBeenCalled();
	});
});

describe('resolveStrandClusterSize', () => {
	it('defaults when unset', () => {
		expect(resolveStrandClusterSize(undefined)).toBe(DEFAULT_STRAND_CLUSTER_SIZE);
	});

	it('passes a legal value through', () => {
		expect(resolveStrandClusterSize(2)).toBe(2);
		expect(resolveStrandClusterSize(7)).toBe(7);
	});

	it('rejects values optimystic cannot honour', () => {
		// Below `minAbsoluteClusterSize`, or not a whole number of nodes.
		for (const bad of [0, 1, -3, 2.5, Number.NaN]) {
			expect(() => resolveStrandClusterSize(bad)).toThrow(/clusterSize must be an integer >= 2/);
		}
	});
});

describe('DEFAULT_STRAND_CLUSTER_SIZE', () => {
	// Imported, not the literal 0.75: Cadre selects this threshold by naming no
	// `superMajorityThreshold` at all, so the number that decides whether 4 is the right
	// breadth lives upstream. Reading it here makes an upstream change to it fail these
	// assertions instead of silently invalidating the reasoning behind the default.
	const approvalsNeeded = (cohort: number) => Math.ceil(cohort * DEFAULT_SUPER_MAJORITY_THRESHOLD);

	it('is the smallest breadth whose super-majority still commits with one holder offline', () => {
		// The whole justification for the number: at 2 and 3 every holder must be awake
		// for every write, which for a workspace of phones and laptops is the ordinary
		// case. This is what would break if someone lowered the default back.
		expect(approvalsNeeded(DEFAULT_STRAND_CLUSTER_SIZE)).toBeLessThan(DEFAULT_STRAND_CLUSTER_SIZE);
		for (let smaller = MIN_CLUSTER_SIZE; smaller < DEFAULT_STRAND_CLUSTER_SIZE; smaller++) {
			expect(approvalsNeeded(smaller)).toBe(smaller);
		}
	});

	it('is above the breadth at which read repair cannot converge', () => {
		// At a cohort of 2 the reader has exactly one corroborator, and Optimystic
		// accepts that single stale answer as the cluster's truth
		// (`backlog/debt-read-repair-single-voter-corroboration`, still open upstream).
		expect(DEFAULT_STRAND_CLUSTER_SIZE).toBeGreaterThan(2);
	});
});

describe('CONTROL_REPLICATION_BREADTH', () => {
	// The control database is read in full by every party member, so its cohort must
	// cover the whole party. The number is deliberately NOT the strand default: a
	// two-member cohort leaves a member dependent on read repair, which cannot
	// converge because a lone corroborator's stale answer is accepted as the truth.
	it('is above the largest party the product documents, and above the strand default', () => {
		// `docs/architecture.md` -> "Enterprise (Multi-Node Mixed)" is 7 nodes.
		expect(CONTROL_REPLICATION_BREADTH).toBeGreaterThan(7);
		expect(CONTROL_REPLICATION_BREADTH).toBeGreaterThan(DEFAULT_STRAND_CLUSTER_SIZE);
	});

	it('is at or above optimystic\'s minimum cluster size', () => {
		expect(CONTROL_REPLICATION_BREADTH).toBeGreaterThanOrEqual(MIN_CLUSTER_SIZE);
	});
});
