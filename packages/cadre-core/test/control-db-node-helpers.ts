/**
 * Shared harness for the control-DB liveness suites —
 * `control-database-solo.spec.ts` (a cadre of one),
 * `control-database-offline-peers.spec.ts` (a cadre whose known siblings are
 * unreachable), and `control-database-solo-warm-start.spec.ts` (a device that
 * WAS in a cadre and is now the only one left). All three stand up a real
 * `CadreNode` in the mobile/browser posture (WebSockets-only transports, no
 * listen address, no bootstrap peers) and wrap every control operation in a
 * labelled deadline, so the config builder, the timeout wrapper and the
 * offline-sibling minting live here once.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it
 * as a suite (same pattern as `membership-gate-helpers.ts`).
 */

import { expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webSockets } from '@libp2p/websockets';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';
import { createLibp2pNode, memoryNodeStorage } from '@optimystic/db-p2p';
import type { NodeStorage, OptimysticNode } from '@optimystic/db-p2p';
import { fileNodeStorage } from '@optimystic/db-p2p-storage-fs';
import type { CadreNode } from '../src/cadre-node.js';
import { withTimeout } from '../src/control-stream.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import type { InMemoryKeyStore } from '../src/key-store.js';
import { signPeerRecord } from '../src/peer-record.js';
import { CONTROL_CLUSTER_POLICY, CONTROL_REPLICATION_BREADTH } from '../src/types.js';
import type { CadreNodeConfig, NetworkConfig, StorageConfig } from '../src/types.js';
import type { NodeClass } from '../src/node-class.js';

/**
 * Run `op` with a hard deadline that *fails the test* naming the operation:
 * `<scope> control op <label> timed out after <ms>ms`. A bare `await` on a
 * hung control call would instead blow vitest's own test timeout, which
 * reports no operation and no stack worth reading.
 *
 * Delegates to cadre-core's own {@link withTimeout} rather than re-deriving
 * the race — that helper is covered by `control-stream-timeout.spec.ts`, so
 * these specs' diagnostics rest on tested code.
 */
export function withinOp<T>(scope: string, label: string, ms: number, op: () => Promise<T>): Promise<T> {
	return withTimeout(ms, `${scope} control op ${label}`, op);
}

/**
 * A spec's own `within` — {@link withinOp} with its scope already bound. Helpers
 * below take one of these so their timeout labels land under the CALLING spec's
 * scope rather than a scope of their own.
 */
export type Within = <T>(label: string, ms: number, op: () => Promise<T>) => Promise<T>;

/** Build a {@link Within} bound to `scope`: `<scope> control op <label> …`. */
export function scopedWithin(scope: string): Within {
	return <T>(label: string, ms: number, op: () => Promise<T>) => withinOp(scope, label, ms, op);
}

/** Abbreviate a peerId for timeout labels. */
export const short = (peerId: string): string => peerId.slice(-8);

/**
 * Assert the node really came up non-listening. {@link controlNodeConfig}
 * asks for `listenAddrs: []`, but `CadreNode` forwards it through a truthiness
 * spread (`cadre-node.ts` → `...(network?.listenAddrs && { listenAddrs })`); a
 * refactor to a length check would silently drop the empty array and these
 * specs would quietly revert to testing the *listening* shape that
 * `control-database-genesis.spec.ts` already covers.
 */
export function expectNotListening(node: CadreNode): void {
	expect(node.getMultiaddrs()).toEqual([]);
}

/** Collect a column from the control DB's inner Quereus database. */
export async function readColumn(node: CadreNode, sql: string, column: string): Promise<unknown[]> {
	const db = node.getControlDatabase();
	expect(db).not.toBeNull();
	const values: unknown[] = [];
	for await (const row of db!.getDatabase().eval(sql)) {
		values.push(row[column]);
	}
	return values;
}

/** A collision-proof partyId; pass the full tag (e.g. `solo-transaction-write`). */
export function freshPartyId(tag: string): string {
	return `${tag}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A control database's libp2p node, for a spec that builds `ControlDatabase` directly, the way
 * `CadreNode` builds its own: WebSockets-only with no listen address (so it opens no connections
 * and binds no port), this party's control network name, and the control cluster policy — that
 * last because the schema apply's writes commit through it. Nothing checks that these stay in
 * step with `CadreNode.buildControlNodeOptions`; what such a spec tests is the schema apply over
 * optimystic storage, not how a node is configured.
 */
export function createControlNode(partyId: string, storage: NodeStorage, privateKey?: PrivateKey): Promise<OptimysticNode> {
	return createLibp2pNode({
		...(privateKey && { privateKey }),
		port: 0,
		bootstrapNodes: [],
		networkName: `control-${partyId}`,
		storage,
		fretProfile: 'edge',
		clusterSize: CONTROL_REPLICATION_BREADTH,
		clusterPolicy: CONTROL_CLUSTER_POLICY,
		transports: [webSockets()],
		listenAddrs: [],
		arachnode: { enableRingZulu: false }
	});
}

export interface ControlNodeConfigOpts {
	partyId: string;
	nodeClass: NodeClass;
	keyStore: InMemoryKeyStore;
	/**
	 * How each scope's storage is opened — {@link memoryStorageProvider} for a restart that
	 * survives in the parent process's heap, {@link fileStorageProvider} for one that survives
	 * on DISK and nowhere else.
	 */
	storage: StorageConfig['open'];
	/** Defaults to `[webSockets()]` — the mobile/browser posture. */
	transports?: NetworkConfig['transports'];
	/** Defaults to `[]` — no inbound connections, as RN/browser cannot accept them. */
	listenAddrs?: string[];
	/**
	 * Reconcile-pass tuning. Specs that drive DEAD addresses on purpose set
	 * `dialTimeoutMs` here so a pass costs (dialed siblings) × a number the spec
	 * chose, rather than each address's libp2p attempt timeout multiplied by
	 * address fan-out and stretched by whatever else the machine is running.
	 * Omitted entirely when absent, so the production defaults stay in force.
	 */
	controlCohort?: NetworkConfig['controlCohort'];
}

/**
 * The mobile/browser control-node config: WebSockets-only, no listen address,
 * no bootstrap peers. `keyStore` + `storage` are passed in so a restart can
 * reuse the same identity and the same block storage (a warm start).
 */
export function controlNodeConfig(opts: ControlNodeConfigOpts): CadreNodeConfig {
	return {
		keyStore: opts.keyStore,
		controlNetwork: {
			partyId: opts.partyId,
			bootstrapNodes: []
		},
		nodeClass: opts.nodeClass,
		storage: { open: opts.storage },
		network: {
			transports: opts.transports ?? [webSockets()],
			// The RN/browser default (see types.ts NetworkConfig.listenAddrs): these
			// runtimes cannot accept inbound connections at all.
			listenAddrs: opts.listenAddrs ?? [],
			...(opts.controlCohort ? { controlCohort: opts.controlCohort } : {})
		}
	};
}

/** A fresh empty directory under the OS temp dir; the caller removes it. */
export function tempStorageDir(tag: string): string {
	return mkdtempSync(join(tmpdir(), `cadre-${tag}-`));
}

/**
 * A `StorageConfig.open` backed by real files under `baseDir`, one subdirectory per scope —
 * `controlStorageScope(partyId)` for the control network (see `CadreNode.startControlNetwork`),
 * the strand id for each strand.
 *
 * What this gives a restart is the same DIRECTORY, not a fresh handle over it. Memoised per
 * scope, so two opens for the same scope hand back the same value; and `fileNodeStorage` keeps
 * one set of stores per directory in the process anyway, counted by holder, so even a caller that
 * builds a second `fileStorageProvider` over one `baseDir` is handed the stores the first opened.
 * A genuinely cold handle over warm bytes is therefore not obtainable through this helper — a spec
 * that needs one constructs `FileRawStorage`, `FileKVStore` and `FilePieceStore` itself, which is
 * what upstream's own factory comment points callers that are not ordinary hosts at.
 *
 * What it still buys over {@link memoryStorageProvider} is that the bytes are REAL: the rows a
 * restart reads were written through a filesystem backend and its write-ahead log, not kept as
 * heap objects, so a hydrate path that only works against an in-memory store fails here.
 *
 * The returned `OpenNodeStorage`s are deliberately not closed: the caller removes `baseDir`. The
 * directory's log is therefore never checkpointed and its lock never released inside the process,
 * which is what it was before this took one set of stores per scope instead of one block store.
 */
export function fileStorageProvider(baseDir: string): StorageConfig['open'] {
	const byScope = new Map<string, NodeStorage>();
	return async (scope: string) => {
		let storage = byScope.get(scope);
		if (!storage) {
			// encodeURIComponent: cadre-core's own scope keys are already path-safe, but
			// a test may pass a hand-written strand id, and `FileStoreDriver` does no
			// escaping of its own.
			storage = fileNodeStorage(join(baseDir, encodeURIComponent(scope)));
			byScope.set(scope, storage);
		}
		return storage;
	};
}

/**
 * A `StorageConfig.open` backed by one `memoryNodeStorage()` per scope — the heap-resident
 * counterpart of {@link fileStorageProvider}, memoised for the same reason: `CadreNode` asks once
 * per scope, and handing back a fresh (empty) set on a second open of the same scope would split
 * that scope's blocks across two views.
 *
 * Because the stores live in the parent process's heap, a node rebuilt over the same opener is a
 * restart that keeps its blocks — which is what the restart specs want and exactly what
 * {@link fileStorageProvider} deliberately does NOT give them. Use this one when the point is
 * "same stored rows, new node"; use the file-backed one when the point is "nothing but the bytes
 * on disk crossed the boundary".
 */
export function memoryStorageProvider(): StorageConfig['open'] {
	const byScope = new Map<string, NodeStorage>();
	return async (scope: string) => {
		let storage = byScope.get(scope);
		if (!storage) {
			storage = memoryNodeStorage();
			byScope.set(scope, storage);
		}
		return storage;
	};
}

/** A known-but-unreachable sibling: the peerId on record and the addrs recorded for it. */
export interface OfflinePeer {
	peerId: string;
	addrs: string[];
}

/**
 * Owner-insert a self-signed, fresh `CadrePeer` record for an offline sibling,
 * then assert it RESOLVES — without this a spec built on it is vacuous (an
 * unsigned or stale row resolves to `[]`, the peerStore fallback misses too, and
 * no dial is ever attempted).
 *
 * Requires seed bootstrap to be wired on `node` (`initializeSeedBootstrap`).
 */
export async function insertResolvableOfflinePeer(
	node: CadreNode,
	within: Within,
	key: PrivateKey,
	addrs: string[],
	opTimeoutMs: number
): Promise<OfflinePeer> {
	const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(key);
	const peerId = peerIdFromPrivateKey(key).toString();
	const record = signPeerRecord(node.partyId, { peerId, publicKey: publicKeyB64, addrs, updatedAt: Date.now(), profile: null }, privateKeyB64);
	await node.getSeedBootstrapService()!.insertSelfPeerRecord(record);

	const resolved = await within(`resolvePeerAddrs(${short(peerId)}) (anti-vacuity)`, opTimeoutMs,
		() => node.resolvePeerAddrs(peerId));
	expect(new Set(resolved.map((m) => m.toString()))).toEqual(new Set(addrs));
	return { peerId, addrs };
}

/**
 * Mint a sibling at an RFC 5737 TEST-NET-1 address (`192.0.2.0/24`, guaranteed
 * unrouted — the connect never answers). `n` keeps each sibling's address
 * distinct within a suite.
 */
export async function mintBlackholePeer(
	node: CadreNode,
	within: Within,
	n: number,
	opTimeoutMs: number
): Promise<OfflinePeer> {
	const key = await generateKeyPair('Ed25519');
	const peerId = peerIdFromPrivateKey(key).toString();
	return insertResolvableOfflinePeer(node, within, key, [`/ip4/192.0.2.${n}/tcp/4001/ws/p2p/${peerId}`], opTimeoutMs);
}
