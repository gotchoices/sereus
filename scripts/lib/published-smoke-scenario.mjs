/**
 * The scenario body run *inside* the scratch project that
 * `scripts/smoke-published-install.mjs` builds. Copied verbatim into that project
 * and executed by `node`, so it may only import what a registry consumer can:
 * `@serfab/cadre-core`, `@optimystic/db-p2p`, `@libp2p/websockets`, and node builtins.
 *
 * It is a port of `packages/cadre-core/test/control-database-solo.spec.ts` plus the
 * parts of `packages/cadre-core/test/control-db-node-helpers.ts` it needs. The
 * assertions are that spec's assertions — when the spec changes, change them here
 * too rather than inventing new ones.
 *
 * Two things could not be reused as-is and are re-derived below:
 *  - `withinOp` delegates to cadre-core's internal `withTimeout` (`src/control-stream.js`),
 *    which `src/index.ts` does not re-export, so the scratch project cannot reach it.
 *  - the helpers assert through vitest's `expect`, which the scratch project does not have.
 * The labelled deadline is kept deliberately: a hang must fail as
 * `HANG: <op> timed out after <n>ms`, not as a silent wall-clock stall.
 */

import assert from 'node:assert/strict';
import { inspect } from 'node:util';

/** Per-operation budget. Solo ops complete in milliseconds; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;
/** `start()`/`stop()` bring libp2p up and down — a looser budget, still bounded. */
const LIFECYCLE_TIMEOUT_MS = 30_000;

/** Distinguishes a deadline breach from an assertion failure in the per-case report. */
class HangError extends Error {
	constructor(message) {
		super(message);
		this.name = 'HangError';
	}
}

/**
 * Run `op` under a hard deadline that names the operation. Mirrors
 * `control-db-node-helpers.ts`'s `withinOp`, re-derived on `Promise.race` because
 * cadre-core's own `withTimeout` is not part of the published surface.
 */
async function within(label, ms, op) {
	let timer;
	const deadline = new Promise((_resolve, reject) => {
		timer = setTimeout(() => reject(new HangError(`HANG: solo control op ${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([op(), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Report a failure to load the published packages at all. This is the shape the
 * `@optimystic/db-p2p` testing-barrel defect takes (`Cannot find package 'chai'`),
 * so the module specifier and the importing file are echoed verbatim — that pair is
 * the whole diagnosis.
 */
function reportImportFailure(err) {
	console.error('');
	console.error('IMPORT FAILURE — the published packages could not be loaded.');
	console.error(`  code: ${err?.code ?? err?.name ?? 'unknown'}`);
	const match = /Cannot find (?:package|module) '([^']+)' imported from (.+)/.exec(err?.message ?? '');
	if (match) {
		console.error(`  missing specifier: ${match[1]}`);
		console.error(`  imported from:     ${match[2]}`);
	}
	console.error('  message:');
	for (const line of String(err?.message ?? err).split('\n')) {
		console.error(`    ${line}`);
	}
}

let CadreNode;
let InMemoryKeyStore;
let MemoryRawStorage;
let webSockets;
try {
	// Dynamic rather than static so an ERR_MODULE_NOT_FOUND is catchable and reportable
	// here; a static import would abort the process before any of this file ran.
	({ CadreNode, InMemoryKeyStore } = await import('@serfab/cadre-core'));
	({ MemoryRawStorage } = await import('@optimystic/db-p2p'));
	({ webSockets } = await import('@libp2p/websockets'));
} catch (err) {
	reportImportFailure(err);
	process.exit(1);
}

/** A collision-proof partyId; pass the full tag (e.g. `solo-transaction-write`). */
function freshPartyId(tag) {
	return `${tag}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The mobile/browser control-node config: WebSockets-only, no listen address, no
 * bootstrap peers. `keyStore` + `storage` are passed in so a restart reuses the same
 * identity and the same block storage (a warm start).
 */
function controlNodeConfig({ partyId, profile, keyStore, storage }) {
	return {
		keyStore,
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile,
		storage: { provider: () => storage },
		network: { transports: [webSockets()], listenAddrs: [] }
	};
}

/** Assert the node really came up non-listening (see the helper of the same name). */
function assertNotListening(node) {
	assert.deepEqual(node.getMultiaddrs(), [], 'node should not be listening');
}

/** Collect a column from the control DB's inner Quereus database. */
async function readColumn(node, sql, column) {
	const db = node.getControlDatabase();
	assert.notEqual(db, null, 'control database is null');
	const values = [];
	for await (const row of db.getDatabase().eval(sql)) {
		values.push(row[column]);
	}
	return values;
}

async function soloWriteAndReadBack(profile) {
	const partyId = freshPartyId(`solo-${profile}-write`);
	const keyStore = new InMemoryKeyStore();
	const storage = new MemoryRawStorage();
	const node = new CadreNode(controlNodeConfig({ partyId, profile, keyStore, storage }));

	try {
		await within('node.start()', LIFECYCLE_TIMEOUT_MS, () => node.start());
		assertNotListening(node);

		// Mirrors the reference apps' `runOwnerGenesis`: the node's own libp2p identity,
		// bridged to a base64url owner pair, is the founding owner.
		const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
		const db = node.getControlDatabase();
		assert.notEqual(db, null, 'control database is null');

		assert.equal(await within('hasOwnerKey() (pre-genesis)', OP_TIMEOUT_MS, () => db.hasOwnerKey()), false);

		// --- Genesis (the bootstrap branch) ---------------------------------
		assert.equal(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64)), true);

		// --- Read back, both through the typed API and through raw SQL ------
		assert.deepEqual(
			await within('getOwnerKeys()', OP_TIMEOUT_MS, () => db.getOwnerKeys()),
			new Set([publicKeyB64])
		);
		assert.deepEqual(
			await within('select from CadreControl.OwnerKey', OP_TIMEOUT_MS,
				() => readColumn(node, 'select Key from CadreControl.OwnerKey', 'Key')),
			[publicKeyB64]
		);

		// Idempotent re-run must also not consult the network.
		assert.equal(await within('ensureOwnerKey() (re-run)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64)), false);

		// --- A normal solo write (not the genesis branch) --------------------
		node.initializeSeedBootstrap(privateKeyB64);
		assert.deepEqual(await within('queryCadrePeers() (pre-write)', OP_TIMEOUT_MS, () => db.queryCadrePeers()), []);
		assert.equal(await within('registerSelf()', OP_TIMEOUT_MS, () => node.registerSelf()), 'inserted');

		// --- Read back the solo write ---------------------------------------
		const selfPeerId = node.peerId.toString();
		const peers = await within('queryCadrePeers() (post-write)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
		assert.equal(peers.length, 1);
		assert.equal(peers[0].peerId, selfPeerId);

		const record = await within('queryPeerRecord()', OP_TIMEOUT_MS, () => db.queryPeerRecord(selfPeerId));
		assert.notEqual(record, null, 'peer record is null');
		assert.equal(record.publicKey, publicKeyB64);
	} finally {
		await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
	}
}

async function restartAndReRead() {
	const partyId = freshPartyId('solo-restart');
	// Shared across both runs: same identity slot, same block storage — a warm restart,
	// which enters ControlDatabase.initialize's catalog-hydrate path rather than the
	// fresh-schema path.
	const keyStore = new InMemoryKeyStore();
	const storage = new MemoryRawStorage();
	const config = () => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage });

	const first = new CadreNode(config());
	let ownerPublicKey;
	let ownerPrivateKey;
	let peerId;
	try {
		await within('first.start()', LIFECYCLE_TIMEOUT_MS, () => first.start());
		assertNotListening(first);
		const owner = first.getIdentityOwnerKey();
		ownerPublicKey = owner.publicKeyB64;
		ownerPrivateKey = owner.privateKeyB64;
		peerId = first.peerId.toString();

		const db = first.getControlDatabase();
		assert.notEqual(db, null, 'control database is null');
		assert.equal(await within('first ensureOwnerKey()', OP_TIMEOUT_MS, () => db.ensureOwnerKey(ownerPublicKey)), true);
		first.initializeSeedBootstrap(ownerPrivateKey);
		assert.equal(await within('first registerSelf()', OP_TIMEOUT_MS, () => first.registerSelf()), 'inserted');
	} finally {
		await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
	}

	const second = new CadreNode(config());
	try {
		await within('second.start()', LIFECYCLE_TIMEOUT_MS, () => second.start());
		assertNotListening(second);
		// Same key store ⇒ same libp2p identity ⇒ same PeerId across the restart.
		assert.equal(second.peerId.toString(), peerId);

		const db = second.getControlDatabase();
		assert.notEqual(db, null, 'control database is null');

		// The warm-restart reads: these must complete locally, no network.
		assert.equal(await within('second hasOwnerKey()', OP_TIMEOUT_MS, () => db.hasOwnerKey()), true);
		assert.deepEqual(
			await within('second getOwnerKeys()', OP_TIMEOUT_MS, () => db.getOwnerKeys()),
			new Set([ownerPublicKey])
		);
		assert.deepEqual(
			await within('second select from CadreControl.OwnerKey', OP_TIMEOUT_MS,
				() => readColumn(second, 'select Key from CadreControl.OwnerKey', 'Key')),
			[ownerPublicKey]
		);

		const peers = await within('second queryCadrePeers()', OP_TIMEOUT_MS, () => db.queryCadrePeers());
		assert.deepEqual(peers.map((p) => p.peerId), [peerId]);

		// And a write still works after the warm start (refresh, not insert).
		second.initializeSeedBootstrap(ownerPrivateKey);
		assert.equal(await within('second registerSelf()', OP_TIMEOUT_MS, () => second.registerSelf()), 'refreshed');
	} finally {
		await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
	}
}

const cases = [
	{ name: 'solo, transaction profile — genesis, read-back, solo write, read-back', run: () => soloWriteAndReadBack('transaction') },
	{ name: 'solo, storage profile — genesis, read-back, solo write, read-back', run: () => soloWriteAndReadBack('storage') },
	{ name: 'solo, restart — re-reads control rows on the same identity and storage', run: () => restartAndReRead() }
];

/** An import failure, a hang and an assertion failure are different diagnoses. */
function reportCaseFailure(err) {
	if (err instanceof HangError) {
		console.error('    hang: the operation never settled within its deadline');
		console.error(`    ${err.message}`);
		return;
	}
	if (err?.code === 'ERR_ASSERTION') {
		console.error('    assertion failed');
		// `inspect`, not `JSON.stringify` — several assertions compare `Set`s, which
		// stringify to an indistinguishable `{}`.
		console.error(`    expected: ${inspect(err.expected, { depth: 4 })}`);
		console.error(`    actual:   ${inspect(err.actual, { depth: 4 })}`);
		console.error(`    ${err.message.split('\n')[0]}`);
		return;
	}
	if (err?.code === 'ERR_MODULE_NOT_FOUND') {
		reportImportFailure(err);
		return;
	}
	console.error(`    error: ${err?.stack ?? String(err)}`);
}

let failed = 0;
for (const testCase of cases) {
	const started = Date.now();
	try {
		await testCase.run();
		console.log(`PASS  ${testCase.name} (${Date.now() - started}ms)`);
	} catch (err) {
		failed += 1;
		console.error(`FAIL  ${testCase.name} (${Date.now() - started}ms)`);
		reportCaseFailure(err);
	}
}

console.log('');
console.log(`${cases.length - failed}/${cases.length} case(s) passed.`);
// libp2p keeps handles alive after stop() in some transports; exit explicitly so a
// pass never reads as a hang.
process.exit(failed === 0 ? 0 : 1);
