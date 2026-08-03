/**
 * `cadre-phone.ts` — the NativeScript app's `CadreNode` lifecycle: one SQLite
 * handle held open for the node's life, the two node-local records read out of
 * that same handle's `kv` table, and the start/stop rules around both.
 *
 * The module keeps two pieces of state private to itself (the `CadreNode`
 * singleton and the `OptimysticNSDBHandle`) with no injection seam, so this
 * suite drives it through its real exports and calls `loadModule()` in every
 * test: that helper does `vi.resetModules()` before a dynamic import, which is
 * what keeps one test's "running" node from leaking into the next and making
 * `startPhoneNode` early-return over the following test's assertions.
 *
 * `@serfab/cadre-core` is mocked only in its `CadreNode` export — everything
 * else, `PersistentTrustedOwnerStore` and `PersistentBootstrapPeerStore`
 * included, stays REAL and runs over the faked `SqliteKVStore` below. That is
 * the point of the suite: the empty KV prefix and the literal
 * `trusted-owners.<partyId>` / `bootstrap-peers.<partyId>` keys are proven end
 * to end, not merely as constructor arguments.
 *
 * The libp2p transport factories (`webSockets()`, `circuitRelayTransport()`) are
 * only constructed here, never started, and import cleanly under plain Node — so
 * they are left unmocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
// Static, and load-bearing: evaluating `@serfab/cadre-core`'s compiled graph (and
// the linked `@optimystic/*` / `@quereus/quereus` behind it) takes seconds. Done
// here it is charged to the file's import phase; done inside the first test that
// happened to touch it, it blows the default 5s test timeout instead. It also
// primes the namespace `H.state.core` caches for every later `vi.resetModules()`.
import { CadreNode, PersistentTrustedOwnerStore, PersistentBootstrapPeerStore } from '@serfab/cadre-core';
import type { CadreNodeConfig, ControlNetworkSeed, StrandConfig } from '@serfab/cadre-core';

/**
 * All doubles live in one `vi.hoisted` block: `vi.mock` factories are hoisted
 * above this file's own top-level bindings, so anything a factory reaches has to
 * be created here. Their identity also has to survive `vi.resetModules()`, which
 * evicts the mocked modules and re-runs the factories — the factories therefore
 * return closures over this single state object rather than fresh doubles.
 */
const H = vi.hoisted(() => {
	class FakeDb {
		closeCalls = 0;
		closed = false;

		constructor(readonly name: string) {}

		async close(): Promise<void> {
			this.closeCalls += 1;
			if (state.closeError) throw state.closeError;
			this.closed = true;
		}
	}

	/**
	 * Stands in for `@optimystic/db-p2p-storage-ns`'s `SqliteKVStore`, including
	 * its prefixing behaviour — the fake applies `prefix + key` exactly as the
	 * real class does, so a test that pre-seeds a literal key really does prove
	 * the prefix `cadre-phone.ts` passes is empty.
	 */
	class FakeSqliteKVStore {
		constructor(readonly db: unknown, readonly prefix: string = 'optimystic:txn:') {
			state.kvConstructions.push({ db, prefix });
		}

		async get(key: string): Promise<string | undefined> {
			state.keysRead.push(this.prefix + key);
			return state.kvData.get(this.prefix + key);
		}

		async set(key: string, value: string): Promise<void> {
			state.keysWritten.push(this.prefix + key);
			state.kvData.set(this.prefix + key, value);
		}
	}

	/** The libp2p handle `getControlNode()` hands back — only `dial` is reached. */
	class FakeControlNode {
		/** Raw, unstringified, so a test can tell a parsed Multiaddr from a string. */
		readonly dialed: unknown[] = [];

		async dial(addr: unknown): Promise<void> {
			this.dialed.push(addr);
		}
	}

	class FakeCadreNode {
		isRunning = false;
		/** `null` models a node whose libp2p control network never came up. */
		controlNode: FakeControlNode | null = new FakeControlNode();
		readonly seedsApplied: unknown[] = [];
		readonly seedsDecoded: string[] = [];
		readonly settleWindows: (number | undefined)[] = [];
		readonly strandsAdded: unknown[] = [];

		constructor(readonly config: CadreNodeConfig) {
			state.nodes.push(this);
		}

		async start(): Promise<void> {
			if (state.startError) throw state.startError;
			this.isRunning = true;
		}

		async stop(): Promise<void> {
			if (state.stopError) throw state.stopError;
			this.isRunning = false;
		}

		getControlNode(): FakeControlNode | null {
			return this.controlNode;
		}

		async applySeed(seed: ControlNetworkSeed): Promise<unknown> {
			this.seedsApplied.push(seed);
			return sentinels.applySeedResult;
		}

		decodeSeed(encoded: string): unknown {
			this.seedsDecoded.push(encoded);
			return sentinels.decodedSeed;
		}

		getConnectionPaths(settleWindowMs?: number): unknown {
			this.settleWindows.push(settleWindowMs);
			return sentinels.connectionPaths;
		}

		async addStrand(config: StrandConfig): Promise<unknown> {
			this.strandsAdded.push(config);
			return sentinels.strandInstance;
		}
	}

	/**
	 * Opaque return values for the four pass-through helpers. Those wrappers add
	 * nothing but the "started?" guard, so identity is the whole assertion —
	 * shaping these as real cadre-core results would prove nothing extra.
	 */
	const sentinels = {
		applySeedResult: { tag: 'apply-seed-result' },
		decodedSeed: { tag: 'decoded-seed' },
		connectionPaths: { tag: 'connection-paths' },
		strandInstance: { tag: 'strand-instance' },
	};

	const state = {
		/** Database names passed to `openOptimysticNSDb`, in order. */
		opens: [] as string[],
		dbs: [] as FakeDb[],
		/** The one shared `kv` table behind every `FakeSqliteKVStore`, keys fully prefixed. */
		kvData: new Map<string, string>(),
		kvConstructions: [] as { db: unknown; prefix: string }[],
		keysRead: [] as string[],
		keysWritten: [] as string[],
		nodes: [] as FakeCadreNode[],
		closeError: null as Error | null,
		startError: null as Error | null,
		stopError: null as Error | null,
		/**
		 * The real `@serfab/cadre-core` namespace, imported once and reused across
		 * every `vi.resetModules()` — re-importing it per test would re-evaluate
		 * that package's whole compiled graph (and the linked `@optimystic/*` and
		 * `@quereus/quereus` behind it) for no gain.
		 *
		 * NOTE: the cache also means cadre-core is NOT re-evaluated between tests.
		 * Fine today — the only exports this suite uses from it are the two
		 * node-local store classes, which hold no module-level state. If cadre-core
		 * ever grows module-scoped mutable state a test needs cleared, drop the
		 * `??=` and pay the re-import (and raise `testTimeout` with it).
		 */
		core: undefined as typeof import('@serfab/cadre-core') | undefined,
	};

	function reset(): void {
		state.opens = [];
		state.dbs = [];
		state.kvData = new Map();
		state.kvConstructions = [];
		state.keysRead = [];
		state.keysWritten = [];
		state.nodes = [];
		state.closeError = null;
		state.startError = null;
		state.stopError = null;
	}

	async function openOptimysticNSDb(name: string): Promise<FakeDb> {
		state.opens.push(name);
		const db = new FakeDb(name);
		state.dbs.push(db);
		return db;
	}

	async function loadOrCreateNSPeerKey(): Promise<unknown> {
		return { type: 'Ed25519', raw: new Uint8Array([1, 2, 3]) };
	}

	return { state, reset, openOptimysticNSDb, loadOrCreateNSPeerKey, FakeSqliteKVStore, FakeCadreNode, sentinels };
});

vi.mock('@optimystic/db-p2p-storage-ns', () => ({
	openOptimysticNSDb: H.openOptimysticNSDb,
	loadOrCreateNSPeerKey: H.loadOrCreateNSPeerKey,
	SqliteKVStore: H.FakeSqliteKVStore,
}));

// The lazy per-strand storage proxy is never exercised by start/stop — the
// provider is only *stored* in the config — and importing it for real would drag
// in the NativeScript SQLite plugin.
vi.mock('../src/ns-storage', () => ({ makeLazyNsStorage: () => ({}) }));

vi.mock('@serfab/cadre-core', async (importOriginal) => {
	H.state.core ??= await importOriginal<typeof import('@serfab/cadre-core')>();
	return { ...H.state.core, CadreNode: H.FakeCadreNode };
});

const PARTY = 'party-x';

/** Fresh module instance, so the two module-level singletons never cross tests. */
async function loadModule(): Promise<typeof import('../src/cadre-phone')> {
	vi.resetModules();
	return import('../src/cadre-phone');
}

/** The config the (single) fake node was constructed with. */
function onlyNodeConfig(): CadreNodeConfig {
	expect(H.state.nodes).toHaveLength(1);
	return H.state.nodes[0]!.config;
}

beforeEach(() => {
	H.reset();
});

// ── The partial cadre-core mock ───────────────────────────────────────────────

describe('the @serfab/cadre-core mock', () => {
	it('replaces only CadreNode and leaves the node-local stores real', () => {
		// Guard, not ceremony: if the namespace spread ever stops carrying these
		// through they arrive as `undefined` and every store assertion below fails
		// somewhere unrecognisable instead of here.
		expect<unknown>(CadreNode).toBe(H.FakeCadreNode);
		expect(typeof PersistentTrustedOwnerStore.open).toBe('function');
		expect(typeof PersistentBootstrapPeerStore.open).toBe('function');
	});
});

// ── Identity database + node-local KV wiring ──────────────────────────────────

describe('startPhoneNode identity database', () => {
	it('opens the identity database exactly once and builds the node-local KV over that same handle, unprefixed', async () => {
		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(H.state.opens).toEqual(['sereus-peer-identity']);
		expect(H.state.kvConstructions).toHaveLength(1);
		// Same handle as the identity load, and the EMPTY prefix — the slot keys are
		// the literal strings, and a default prefix would orphan every existing record.
		expect(H.state.kvConstructions[0]!.db).toBe(H.state.dbs[0]);
		expect(H.state.kvConstructions[0]!.prefix).toBe('');
	});

	it('reads exactly the two node-local keys during start', async () => {
		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(H.state.keysRead).toEqual([`trusted-owners.${PARTY}`, `bootstrap-peers.${PARTY}`]);
		// Cold start reads; it does not write. A write here would mean an empty
		// snapshot overwriting a record some other code path had just put there.
		expect(H.state.keysWritten).toEqual([]);
	});

	it('surfaces a trusted-owner envelope pre-seeded under the literal key', async () => {
		// The end-to-end version of the two assertions above: empty prefix AND key
		// shape together, through the real PersistentTrustedOwnerStore.
		H.state.kvData.set(
			`trusted-owners.${PARTY}`,
			JSON.stringify({
				version: 1,
				partyId: PARTY,
				owners: { 'owner-key-b64': { source: 'invite', trustedAt: 1 } },
			}),
		);

		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(onlyNodeConfig().trustedOwners?.store?.has('owner-key-b64')).toBe(true);
	});

	it('surfaces a bootstrap-peer envelope pre-seeded under the literal key', async () => {
		const peerId = '12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3';
		H.state.kvData.set(
			`bootstrap-peers.${PARTY}`,
			JSON.stringify({
				version: 1,
				partyId: PARTY,
				peers: { [peerId]: { addrs: ['/ip4/1.2.3.4/tcp/4001/ws'], recordedAt: 1 } },
			}),
		);

		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect([...(onlyNodeConfig().bootstrapPeers?.store?.all().keys() ?? [])]).toEqual([peerId]);
	});
});

// ── The config handed to CadreNode ────────────────────────────────────────────

describe('the CadreNode config', () => {
	it('passes partyId and bootstrapAddrs through unchanged', async () => {
		const addrs = ['/ip4/10.0.0.1/tcp/4001/ws/p2p/12D3KooWQVo7JTYHgoj9rt9HScoxaM5axn3uB8P1WHiKrhhUqed3'];
		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: addrs });

		expect(onlyNodeConfig().controlNetwork.partyId).toBe(PARTY);
		expect(onlyNodeConfig().controlNetwork.bootstrapNodes).toEqual(addrs);
	});

	it('startSolo reaches CadreNode with an empty bootstrapNodes list', async () => {
		const { startSolo } = await loadModule();
		await startSolo(PARTY);

		expect(onlyNodeConfig().controlNetwork.partyId).toBe(PARTY);
		expect(onlyNodeConfig().controlNetwork.bootstrapNodes).toEqual([]);
	});

	it('listens on nothing', async () => {
		// NativeScript clients cannot accept inbound connections; a "helpful"
		// default listen address here would be a silent runtime failure on device.
		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(onlyNodeConfig().network?.listenAddrs).toEqual([]);
		expect(onlyNodeConfig().network?.transports).toHaveLength(2);
	});

	it('wires both node-local stores in, scoped to the started party', async () => {
		const { startPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		const config = onlyNodeConfig();
		expect(config.trustedOwners?.store?.partyId).toBe(PARTY);
		expect(config.bootstrapPeers?.store?.partyId).toBe(PARTY);
	});
});

// ── Start / stop lifecycle ────────────────────────────────────────────────────

describe('startPhoneNode / stopPhoneNode lifecycle', () => {
	it('is idempotent while running: same node, no second database handle', async () => {
		const { startPhoneNode, getPhoneNode } = await loadModule();

		const first = await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		const second = await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(second).toBe(first);
		expect(getPhoneNode()).toBe(first);
		// Exactly one open, as in the first test of this file — the pair together is
		// what proves `vi.resetModules()` is really isolating the module singletons.
		expect(H.state.opens).toHaveLength(1);
		expect(H.state.nodes).toHaveLength(1);
	});

	it('stop closes the handle and clears the node', async () => {
		const { startPhoneNode, stopPhoneNode, getPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		await stopPhoneNode();

		expect(H.state.dbs[0]!.closed).toBe(true);
		expect(getPhoneNode()).toBeNull();
	});

	it('closes the handle even when node.stop() rejects, and propagates the rejection', async () => {
		// The `finally` in `stopPhoneNode`. A leaked native SQLite handle blocks the
		// next open of the same file, so the close must not be conditional on a
		// clean stop.
		const { startPhoneNode, stopPhoneNode, getPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		H.state.stopError = new Error('libp2p stop failed');

		await expect(stopPhoneNode()).rejects.toThrow('libp2p stop failed');
		expect(H.state.dbs[0]!.closed).toBe(true);
		expect(getPhoneNode()).toBeNull();
	});

	it('closes the handle after a start that failed inside CadreNode.start()', async () => {
		const { startPhoneNode, stopPhoneNode, getPhoneNode } = await loadModule();
		H.state.startError = new Error('control network unreachable');

		await expect(startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] })).rejects.toThrow(
			'control network unreachable',
		);
		await stopPhoneNode();

		expect(H.state.dbs[0]!.closed).toBe(true);
		expect(getPhoneNode()).toBeNull();
	});

	it('is a no-op when nothing was ever started', async () => {
		const { stopPhoneNode, getPhoneNode } = await loadModule();

		await expect(stopPhoneNode()).resolves.toBeUndefined();
		expect(H.state.opens).toEqual([]);
		expect(H.state.dbs).toEqual([]);
		expect(getPhoneNode()).toBeNull();
	});

	it('opens a new handle on the start after a stop, never the closed one', async () => {
		const { startPhoneNode, stopPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		await stopPhoneNode();

		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(H.state.opens).toEqual(['sereus-peer-identity', 'sereus-peer-identity']);
		expect(H.state.dbs).toHaveLength(2);
		expect(H.state.dbs[0]!.closed).toBe(true);
		expect(H.state.dbs[1]!.closed).toBe(false);
		expect(H.state.kvConstructions[1]!.db).toBe(H.state.dbs[1]);
	});

	it('retries a failed start over the handle that start already opened', async () => {
		// The `??=`. A failed start leaves `identityDb` open (nothing closes it until
		// `stopPhoneNode`), and the node it left behind is not running — so the retry
		// falls straight through the `node?.isRunning` early-return to the open call.
		// A plain open there would strand the first native handle, which then blocks
		// every later open of the same file.
		const { startPhoneNode, getPhoneNode } = await loadModule();
		H.state.startError = new Error('control network unreachable');
		await expect(startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] })).rejects.toThrow(
			'control network unreachable',
		);

		H.state.startError = null;
		const node = await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		expect(H.state.opens).toEqual(['sereus-peer-identity']);
		expect(H.state.dbs).toHaveLength(1);
		expect(H.state.dbs[0]!.closed).toBe(false);
		expect(H.state.nodes).toHaveLength(2);
		expect(getPhoneNode()).toBe(node);
		expect(node.isRunning).toBe(true);
	});

	it('clears the handle even when db.close() rejects, so the next start opens a fresh one', async () => {
		const { startPhoneNode, stopPhoneNode } = await loadModule();
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		H.state.closeError = new Error('SQLite close failed');

		await expect(stopPhoneNode()).rejects.toThrow('SQLite close failed');
		expect(H.state.dbs[0]!.closeCalls).toBe(1);

		H.state.closeError = null;
		await startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		// A dangling handle handed back here would fail every later node-local write.
		expect(H.state.dbs).toHaveLength(2);
		expect(H.state.kvConstructions[1]!.db).toBe(H.state.dbs[1]);
	});
});

// ── The helpers that delegate to the running node ─────────────────────────────
// Everything past `stopPhoneNode` in `cadre-phone.ts` is the same two lines: a
// "started?" guard, then a forward to the node. Cheap to get wrong (a guard that
// checks the wrong thing, an argument dropped or reordered) and silent when it is.

const SEED: ControlNetworkSeed = {
	partyId: PARTY,
	peers: [],
	signature: 'seed-signature',
	signerKey: 'owner-key-b64',
};

const STRAND: StrandConfig = {
	strandRow: { Id: 'strand-1', MemberPrivateKey: null, Type: 'o' },
	sAppConfig: { id: 'chat', version: '1', schema: 'create table Message (Id text primary key)' },
};

describe('the helpers that require a started node', () => {
	it('all refuse before any start', async () => {
		const phone = await loadModule();

		await expect(phone.applySeed(SEED)).rejects.toThrow('Phone node not started');
		await expect(phone.dialPeer('/ip4/1.2.3.4/tcp/4001/ws')).rejects.toThrow('Phone node not started');
		await expect(phone.addStrand(STRAND)).rejects.toThrow('Phone node not started');
		expect(() => phone.decodeSeed('encoded-seed')).toThrow('Phone node not started');
		expect(() => phone.getConnectionPaths()).toThrow('Phone node not started');
	});

	it('forward their argument to the node and hand back what it returned', async () => {
		const phone = await loadModule();
		await phone.startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		const node = H.state.nodes[0]!;

		expect<unknown>(await phone.applySeed(SEED)).toBe(H.sentinels.applySeedResult);
		expect<unknown>(phone.decodeSeed('encoded-seed')).toBe(H.sentinels.decodedSeed);
		expect<unknown>(phone.getConnectionPaths(1234)).toBe(H.sentinels.connectionPaths);
		expect<unknown>(await phone.addStrand(STRAND)).toBe(H.sentinels.strandInstance);

		expect(node.seedsApplied).toEqual([SEED]);
		expect(node.seedsDecoded).toEqual(['encoded-seed']);
		expect(node.strandsAdded).toEqual([STRAND]);
		// Optional, and passed through as-is — a defaulted window would silently
		// change how `stuckOnRelay` reads on the diagnostics screen.
		expect(node.settleWindows).toEqual([1234]);
		expect(phone.getConnectionPaths()).toBeDefined();
		expect(node.settleWindows).toEqual([1234, undefined]);
	});

	it('dialPeer dials a parsed multiaddr on the control node', async () => {
		const phone = await loadModule();
		await phone.startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });

		await phone.dialPeer('/ip4/1.2.3.4/tcp/4001/ws');

		const [dialed] = H.state.nodes[0]!.controlNode!.dialed;
		// A Multiaddr, not the raw string libp2p's `dial` would reject.
		expect(typeof dialed).not.toBe('string');
		expect(String(dialed)).toBe('/ip4/1.2.3.4/tcp/4001/ws');
	});

	it('dialPeer refuses when the node has no control network', async () => {
		const phone = await loadModule();
		await phone.startPhoneNode({ partyId: PARTY, bootstrapAddrs: [] });
		H.state.nodes[0]!.controlNode = null;

		await expect(phone.dialPeer('/ip4/1.2.3.4/tcp/4001/ws')).rejects.toThrow('Control network not available');
	});
});
