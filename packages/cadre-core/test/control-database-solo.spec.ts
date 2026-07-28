import { describe, it, expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import { MemoryRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { InMemoryKeyStore } from '../src/key-store.js';
import type { CadreNodeConfig, NodeProfile } from '../src/types.js';

/**
 * The **cadre of one** (solo) control-DB shape, as embedding mobile/browser apps
 * actually configure it: WebSockets-only transports, NO listen address, and an
 * empty bootstrap list. A node in this state is the whole membership and the sole
 * authority over its own control data, so every control read/write must complete
 * from local state without consulting a network it knows is empty.
 *
 * Companion spec: `control-database-genesis.spec.ts` covers the *listening* solo
 * shape (default TCP `listenAddrs`, default transports). The two are a matched
 * pair, not duplicates — a node with no listen address cannot be dialed back, and
 * that is the configuration where a cluster/cohort round-trip would hang instead
 * of failing. Keep both.
 *
 * Every control operation here is wrapped in {@link within}, so a regression
 * surfaces as a *failing assertion naming the operation* rather than a silent
 * vitest timeout with nothing to diagnose.
 */

/** Per-operation budget. Solo ops complete in milliseconds; this only catches hangs. */
const OP_TIMEOUT_MS = 15_000;
/** `start()`/`stop()` bring libp2p up and down — a looser budget, still bounded. */
const LIFECYCLE_TIMEOUT_MS = 30_000;

/**
 * Run `op` with a hard deadline that *fails the test* naming the operation.
 * A bare `await` on a hung control call would instead blow vitest's own test
 * timeout, which reports no operation and no stack worth reading.
 */
async function within<T>(label: string, ms: number, op: () => Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`solo control operation did not complete within ${ms}ms: ${label}`)),
			ms
		);
	});
	try {
		return await Promise.race([op(), deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** Collect a column from the control DB's inner Quereus database. */
async function readColumn(node: CadreNode, sql: string, column: string): Promise<unknown[]> {
	const db = node.getControlDatabase();
	expect(db).not.toBeNull();
	const values: unknown[] = [];
	for await (const row of db!.getDatabase().eval(sql)) {
		values.push(row[column]);
	}
	return values;
}

/**
 * The mobile/browser solo config: WebSockets-only, no listen address, no
 * bootstrap peers. `keyStore` + `storage` are passed in so a restart can reuse
 * the same identity and the same block storage (a warm start).
 */
function soloConfig(opts: {
	partyId: string;
	profile: NodeProfile;
	keyStore: InMemoryKeyStore;
	storage: MemoryRawStorage;
}): CadreNodeConfig {
	return {
		keyStore: opts.keyStore,
		controlNetwork: {
			partyId: opts.partyId,
			bootstrapNodes: []
		},
		profile: opts.profile,
		storage: { provider: () => opts.storage },
		network: {
			transports: [webSockets()],
			// The RN/browser default (see types.ts NetworkConfig.listenAddrs): these
			// runtimes cannot accept inbound connections at all.
			listenAddrs: []
		}
	};
}

function freshPartyId(tag: string): string {
	return `solo-${tag}-${Math.random().toString(36).slice(2)}`;
}

describe('control database, cadre of one (no listen addr, no bootstrap peers)', () => {
	for (const profile of ['transaction', 'storage'] as const) {
		describe(`${profile} profile`, () => {
			it('completes genesis, a read-back, a solo write, and a read-back of that write', async () => {
				const partyId = freshPartyId(`${profile}-write`);
				const keyStore = new InMemoryKeyStore();
				const storage = new MemoryRawStorage();
				const node = new CadreNode(soloConfig({ partyId, profile, keyStore, storage }));

				try {
					await within('node.start()', LIFECYCLE_TIMEOUT_MS, () => node.start());

					// Mirrors the reference apps' `runOwnerGenesis`: the node's own libp2p
					// identity, bridged to a base64url owner pair, is the founding owner.
					const { privateKeyB64, publicKeyB64 } = node.getIdentityOwnerKey();
					const db = node.getControlDatabase();
					expect(db).not.toBeNull();

					expect(await within('hasOwnerKey() (pre-genesis)', OP_TIMEOUT_MS, () => db!.hasOwnerKey()))
						.toBe(false);

					// --- Genesis (the bootstrap branch) ---------------------------------
					expect(await within('ensureOwnerKey() (genesis)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(publicKeyB64)))
						.toBe(true);

					// --- Read back, both through the typed API and through raw SQL ------
					expect(await within('getOwnerKeys()', OP_TIMEOUT_MS, () => db!.getOwnerKeys()))
						.toEqual(new Set([publicKeyB64]));
					expect(await within('select from CadreControl.OwnerKey', OP_TIMEOUT_MS,
						() => readColumn(node, 'select Key from CadreControl.OwnerKey', 'Key')))
						.toEqual([publicKeyB64]);

					// Idempotent re-run must also not consult the network.
					expect(await within('ensureOwnerKey() (re-run)', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(publicKeyB64)))
						.toBe(false);

					// --- A normal solo write (not the genesis branch) --------------------
					// registerSelf needs seed-bootstrap wired, exactly as the reference
					// apps do immediately after genesis.
					node.initializeSeedBootstrap(privateKeyB64);
					expect(await within('queryCadrePeers() (pre-write)', OP_TIMEOUT_MS, () => db!.queryCadrePeers()))
						.toEqual([]);
					expect(await within('registerSelf()', OP_TIMEOUT_MS, () => node.registerSelf()))
						.toBe('inserted');

					// --- Read back the solo write ---------------------------------------
					const selfPeerId = node.peerId!.toString();
					const peers = await within('queryCadrePeers() (post-write)', OP_TIMEOUT_MS, () => db!.queryCadrePeers());
					expect(peers).toHaveLength(1);
					expect(peers[0]!.peerId).toBe(selfPeerId);

					const record = await within('queryPeerRecord()', OP_TIMEOUT_MS,
						() => db!.queryPeerRecord(selfPeerId));
					expect(record).not.toBeNull();
					expect(record!.publicKey).toBe(publicKeyB64);
				} finally {
					await within('node.stop()', LIFECYCLE_TIMEOUT_MS, () => node.stop());
				}
			}, 120_000);
		});
	}

	it('re-reads its control rows after a restart on the same identity and storage', async () => {
		const partyId = freshPartyId('restart');
		// Shared across both runs: same identity slot, same block storage — a warm
		// restart, which enters ControlDatabase.initialize's catalog-hydrate path
		// rather than the fresh-schema path.
		const keyStore = new InMemoryKeyStore();
		const storage = new MemoryRawStorage();
		const config = () => soloConfig({ partyId, profile: 'transaction', keyStore, storage });

		const first = new CadreNode(config());
		let ownerPublicKey: string;
		let ownerPrivateKey: string;
		let peerId: string;
		try {
			await within('first.start()', LIFECYCLE_TIMEOUT_MS, () => first.start());
			const owner = first.getIdentityOwnerKey();
			ownerPublicKey = owner.publicKeyB64;
			ownerPrivateKey = owner.privateKeyB64;
			peerId = first.peerId!.toString();

			const db = first.getControlDatabase();
			expect(db).not.toBeNull();
			expect(await within('first ensureOwnerKey()', OP_TIMEOUT_MS, () => db!.ensureOwnerKey(ownerPublicKey)))
				.toBe(true);
			first.initializeSeedBootstrap(owner.privateKeyB64);
			expect(await within('first registerSelf()', OP_TIMEOUT_MS, () => first.registerSelf()))
				.toBe('inserted');
		} finally {
			await within('first.stop()', LIFECYCLE_TIMEOUT_MS, () => first.stop());
		}

		const second = new CadreNode(config());
		try {
			await within('second.start()', LIFECYCLE_TIMEOUT_MS, () => second.start());
			// Same key store ⇒ same libp2p identity ⇒ same PeerId across the restart.
			expect(second.peerId!.toString()).toBe(peerId);

			const db = second.getControlDatabase();
			expect(db).not.toBeNull();

			// The warm-restart reads: these must complete locally, no network.
			expect(await within('second hasOwnerKey()', OP_TIMEOUT_MS, () => db!.hasOwnerKey())).toBe(true);
			expect(await within('second getOwnerKeys()', OP_TIMEOUT_MS, () => db!.getOwnerKeys()))
				.toEqual(new Set([ownerPublicKey]));
			expect(await within('second select from CadreControl.OwnerKey', OP_TIMEOUT_MS,
				() => readColumn(second, 'select Key from CadreControl.OwnerKey', 'Key')))
				.toEqual([ownerPublicKey]);

			const peers = await within('second queryCadrePeers()', OP_TIMEOUT_MS, () => db!.queryCadrePeers());
			expect(peers.map((p) => p.peerId)).toEqual([peerId]);

			// And a write still works after the warm start (refresh, not insert).
			second.initializeSeedBootstrap(ownerPrivateKey);
			expect(await within('second registerSelf()', OP_TIMEOUT_MS, () => second.registerSelf()))
				.toBe('refreshed');
		} finally {
			await within('second.stop()', LIFECYCLE_TIMEOUT_MS, () => second.stop());
		}
	}, 180_000);
});
