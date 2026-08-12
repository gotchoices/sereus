/**
 * The scenario body run *inside* the scratch project that
 * `scripts/smoke-published-install.mjs` builds. Copied verbatim into that project
 * and executed by `node`, so it may only import what a registry consumer can — every
 * name in `SCENARIO_DIRECT_DEPS` (see that script), the packed `@serfab/*` tarballs,
 * and node builtins.
 *
 * It is a port of two specs plus the parts of
 * `packages/cadre-core/test/control-db-node-helpers.ts` they need:
 *
 *  - `packages/cadre-core/test/control-database-solo.spec.ts` — the cadre of one
 *    (genesis, read-back, solo write, warm restart).
 *  - `packages/cadre-core/test/control-database-solo-warm-start.spec.ts` — a device
 *    that WAS in a cadre and is now the only one left, restarting on `CadrePeer` rows
 *    a previous session wrote to disk. That is the shape an embedding React Native
 *    team actually reported, which is why it is worth running against a REGISTRY
 *    install and not only against the linked workspace. Two of its six cases are
 *    ported (vanished prior cohort, cold boot in the embedder order); the smoke is a
 *    release step, not a suite, so the other four stay spec-only.
 *
 * The assertions are those specs' assertions — when a spec changes, change them here
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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

/** Per-operation budget. Solo ops complete in milliseconds; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;
/** `start()`/`stop()` bring libp2p up and down — a looser budget, still bounded. */
const LIFECYCLE_TIMEOUT_MS = 30_000;
/**
 * `addStrand` resolves the cohort seed and then brings a SECOND libp2p node (the
 * strand's) up, so it needs more room than a control op. Same 60 s the warm-start
 * spec uses: wide enough for an honest launch, narrow enough that the freeze an
 * embedding app reported could not hide inside it.
 */
const ADD_STRAND_TIMEOUT_MS = 60_000;

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
let ed25519KeyPairFromLibp2p;
let signPeerRecord;
let signSchema;
let MemoryRawStorage;
let FileRawStorage;
let webSockets;
let generateKeyPair;
let peerIdFromPrivateKey;
try {
	// Dynamic rather than static so an ERR_MODULE_NOT_FOUND is catchable and reportable
	// here; a static import would abort the process before any of this file ran.
	({ CadreNode, InMemoryKeyStore, ed25519KeyPairFromLibp2p, signPeerRecord, signSchema } = await import('@serfab/cadre-core'));
	({ MemoryRawStorage } = await import('@optimystic/db-p2p'));
	// The warm-start cases restart across real files rather than a shared heap object.
	({ FileRawStorage } = await import('@optimystic/db-p2p-storage-fs'));
	({ webSockets } = await import('@libp2p/websockets'));
	// Minting a throwaway sibling identity, exactly as `control-db-node-helpers.ts` does.
	({ generateKeyPair } = await import('@libp2p/crypto/keys'));
	({ peerIdFromPrivateKey } = await import('@libp2p/peer-id'));
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
 *
 * `storage` is a `RawStorageProvider` — either one `IRawStorage` instance (control
 * node and any strand node then share it) or an `(id) => IRawStorage` factory. Pass
 * {@link fileStorageProvider} for a restart that survives on DISK rather than in this
 * process's heap.
 */
function controlNodeConfig({ partyId, profile, keyStore, storage }) {
	return {
		keyStore,
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile,
		storage: { provider: storage },
		network: { transports: [webSockets()], listenAddrs: [] }
	};
}

/** A fresh empty directory under the OS temp dir; the caller removes it. */
function tempStorageDir(tag) {
	return mkdtempSync(join(tmpdir(), `cadre-${tag}-`));
}

/**
 * An `(id) => IRawStorage` factory backed by real files under `baseDir`, one
 * subdirectory per id — `'control'` for the control network, the strand id for each
 * strand. Mirrors `control-db-node-helpers.ts`'s `fileStorageProvider`.
 *
 * The instance per id is MEMOISED, so two calls for the same id hand back the same
 * handle rather than two views of one directory. `CadreNode` asks once per node
 * instance, so a restart against the same `baseDir` gets a *new* `FileRawStorage`
 * reading the rows the previous run left on disk — which is the point: unlike a shared
 * `MemoryRawStorage`, nothing survives in the heap, so a warm start that only appears
 * to work because the old object was still around cannot pass.
 */
function fileStorageProvider(baseDir) {
	const byId = new Map();
	return (id) => {
		let storage = byId.get(id);
		if (!storage) {
			// encodeURIComponent: strand ids are caller-supplied and reach the filesystem
			// here, and `FileStoreDriver` does no escaping of its own.
			storage = new FileRawStorage(join(baseDir, encodeURIComponent(id)));
			byId.set(id, storage);
		}
		return storage;
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

// --------------------------------------------------------------------------
// Warm start on a prior cohort — the port of
// `packages/cadre-core/test/control-database-solo-warm-start.spec.ts`.
//
// Different from the three cases above in three ways, all of which come from the
// shape an embedding React Native team reported:
//  1. Real FILES (`fileStorageProvider`), not one shared `MemoryRawStorage`, so only
//     bytes on disk cross the restart boundary.
//  2. A non-empty member list with zero reachable peers, which flips the strand's
//     mode from `bootstrap` to `networked` while the cohort seed resolves to nobody.
//  3. The EMBEDDER's boot order — `start()` straight to `addStrand()`, so the cohort
//     seed's `queryCadrePeers()` is the control DB's first awaited operation.
// --------------------------------------------------------------------------

const SCHEMA = 'create table Note (Id text primary key);';
const VERSION = '1.0.0';

const strandId = (tag) => `warm-${tag}-${Math.random().toString(36).slice(2)}`;

/**
 * A self-consistent signed sApp config: a throwaway ed25519 key signs the schema and
 * doubles as the sApp id, so the config passes `requireSignedSchemas` (the default
 * node policy). The spec mints this key with `@optimystic/quereus-plugin-crypto`;
 * here it comes from the libp2p keypair already imported for sibling minting, bridged
 * through cadre-core's published `ed25519KeyPairFromLibp2p` — same key type, one
 * fewer registry dependency in the scratch project.
 */
async function signedSApp() {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
	return { id: publicKeyB64, version: VERSION, schema: SCHEMA, signature: signSchema(SCHEMA, VERSION, privateKeyB64) };
}

/**
 * Run `body` against a device whose identity slot and block storage survive every
 * restart inside it, then delete the storage directory. The `keyStore` is shared (same
 * libp2p identity, hence the same PeerId, across restarts) and the storage is
 * file-backed under a fresh temp directory.
 */
async function withDevice(tag, body) {
	const dir = tempStorageDir(tag);
	const keyStore = new InMemoryKeyStore();
	const partyId = freshPartyId(tag);
	const storage = fileStorageProvider(dir);
	try {
		await body(() => controlNodeConfig({ partyId, profile: 'transaction', keyStore, storage }));
	} finally {
		// `force` so a case that failed before creating anything still cleans up, and a
		// scratch project is never left holding block directories.
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Start a node in the non-listening posture and assert it really came up that way. */
async function startNode(node, label) {
	await within(`${label}.start()`, LIFECYCLE_TIMEOUT_MS, () => node.start());
	assertNotListening(node);
	assert.notEqual(node.getControlDatabase(), null, 'control database is null');
}

/**
 * Owner-insert a self-signed, fresh `CadrePeer` row for a sibling at an RFC 5737
 * TEST-NET-1 address (`192.0.2.0/24`, guaranteed unrouted — the connect never
 * answers), then assert it RESOLVES. Without that anti-vacuity check an unsigned or
 * stale row would resolve to `[]` and the case would be testing nothing.
 *
 * Requires seed bootstrap to be wired on `node` (`initializeSeedBootstrap`).
 */
async function mintBlackholePeer(node, n) {
	const key = await generateKeyPair('Ed25519');
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const peerId = peerIdFromPrivateKey(key).toString();
	const addrs = [`/ip4/192.0.2.${n}/tcp/4001/ws/p2p/${peerId}`];
	const record = signPeerRecord({ peerId, publicKey: publicKeyB64, addrs, updatedAt: Date.now() }, privateKeyB64);
	await node.getSeedBootstrapService().insertSelfPeerRecord(record);

	const resolved = await within(`resolvePeerAddrs(${peerId.slice(-8)}) (anti-vacuity)`, OP_TIMEOUT_MS,
		() => node.resolvePeerAddrs(peerId));
	assert.deepEqual(new Set(resolved.map((m) => m.toString())), new Set(addrs));
	return peerId;
}

/**
 * The FIRST era: this device founds the party, publishes itself, and is joined by
 * `siblingCount` others. Runs in OUR order (genesis → seed bootstrap → peer writes)
 * deliberately — the embedder's order is what the SECOND era exercises, and a party
 * has to be founded somehow before it can be abandoned.
 */
async function foundCohort(node, siblingCount) {
	const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
	const db = node.getControlDatabase();
	assert.equal(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db.ensureOwnerKey(publicKeyB64)), true);
	node.initializeSeedBootstrap(privateKeyB64);
	assert.equal(await within('registerSelf() (genesis)', OP_TIMEOUT_MS, () => node.registerSelf()), 'inserted');

	const siblings = [];
	for (let n = 1; n <= siblingCount; n++) {
		siblings.push(await mintBlackholePeer(node, n));
	}
	return { siblings, selfPeerId: node.peerId.toString(), ownerPublicKey: publicKeyB64 };
}

/**
 * The anti-vacuity guard for both warm-start cases. A warm start that silently came up
 * on an EMPTY control database would pass every liveness assertion below while testing
 * nothing — the very state these cases exist to construct would be missing. So before
 * a case does its real work, it proves the rows the first era wrote are readable again
 * from disk.
 */
async function assertWarmState(node, expected) {
	const db = node.getControlDatabase();
	assert.equal(await within('hasOwnerKey() (warm)', OP_TIMEOUT_MS, () => db.hasOwnerKey()), true);
	assert.deepEqual(
		await within('getOwnerKeys() (warm)', OP_TIMEOUT_MS, () => db.getOwnerKeys()),
		new Set([expected.ownerPublicKey])
	);
	const peers = await within('queryCadrePeers() (warm)', OP_TIMEOUT_MS, () => db.queryCadrePeers());
	assert.deepEqual(new Set(peers.map((p) => p.peerId)), new Set(expected.members));
}

/** The embedder's launch call, under its own wider deadline. */
async function addStrand(node, tag) {
	const sAppConfig = await signedSApp();
	return within(`addStrand(${tag})`, ADD_STRAND_TIMEOUT_MS,
		() => node.addStrand({ strandRow: { Id: strandId(tag), MemberPrivateKey: null, Type: 'o' }, sAppConfig, founder: true }));
}

/**
 * The headline case: the exact sequence the embedding app runs, against the exact
 * state its device is in. Era 1 founds the party and records one unreachable sibling;
 * era 2 restarts alone off disk and goes `start()` → `addStrand()`.
 */
async function warmStartVanishedCohort() {
	await withDevice('warm-vanished', async (config) => {
		let cohort;

		const first = new CadreNode(config());
		try {
			await startNode(first, 'first');
			cohort = await foundCohort(first, 1);
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		const second = new CadreNode(config());
		try {
			await startNode(second, 'second');
			// Same key store ⇒ same libp2p identity ⇒ the rows on disk are this node's own.
			assert.equal(second.peerId.toString(), cohort.selfPeerId);
			await assertWarmState(second, {
				members: new Set([cohort.selfPeerId, ...cohort.siblings]),
				ownerPublicKey: cohort.ownerPublicKey
			});

			// From here on: the EMBEDDER's order. No genesis re-run, no
			// `initializeSeedBootstrap` — `addStrand` is the next thing called, so the
			// cohort seed's `queryCadrePeers()` is the first control operation of this
			// process that the app actually awaits.
			const instance = await addStrand(second, 'vanished');

			// `networked`, not `bootstrap`: the stale rows are what make this case
			// different from the cold solo one, and the mode is where that difference
			// lands. If this ever reads `bootstrap` the case has degenerated into a
			// rename of the cadre-of-one cases above.
			assert.equal(instance.mode, 'networked');
			assert.equal(instance.status, 'active');
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}
	});
}

/**
 * The boot-ORDER hypothesis on its own, with the stale rows removed from the picture:
 * a COLD device that goes straight from `start()` to `addStrand()`, so the cohort
 * seed's `queryCadrePeers()` is the control database's very first operation ever —
 * issued with no owner key enrolled and no seed bootstrap wired.
 */
async function coldBootInEmbedderOrder() {
	await withDevice('cold-embedder-order', async (config) => {
		const node = new CadreNode(config());
		try {
			await startNode(node, 'node');
			const db = node.getControlDatabase();
			// Nothing has been written yet — this is the pre-genesis state.
			assert.equal(await within('hasOwnerKey() (pre-genesis)', OP_TIMEOUT_MS, () => db.hasOwnerKey()), false);

			const instance = await addStrand(node, 'cold');
			assert.equal(instance.mode, 'bootstrap');
			assert.equal(instance.status, 'active');

			// And genesis still works AFTER the strand launched — the out-of-order read
			// must not have left the control DB in a state that refuses the owner-key
			// write it never saw coming.
			const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
			assert.equal(await within('ensureOwnerKey() (post-addStrand)', OP_TIMEOUT_MS,
				() => db.ensureOwnerKey(publicKeyB64)), true);
			node.initializeSeedBootstrap(privateKeyB64);
			assert.equal(await within('registerSelf() (post-addStrand)', OP_TIMEOUT_MS, () => node.registerSelf()), 'inserted');
		} finally {
			await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
		}
	});
}

const cases = [
	{ name: 'solo, transaction profile — genesis, read-back, solo write, read-back', run: () => soloWriteAndReadBack('transaction') },
	{ name: 'solo, storage profile — genesis, read-back, solo write, read-back', run: () => soloWriteAndReadBack('storage') },
	{ name: 'solo, restart — re-reads control rows on the same identity and storage', run: () => restartAndReRead() },
	{ name: 'solo warm start — start() then addStrand() with vanished prior-cohort peers on disk', run: () => warmStartVanishedCohort() },
	{ name: 'solo cold boot — addStrand() before any genesis, in the embedder order', run: () => coldBootInEmbedderOrder() }
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
