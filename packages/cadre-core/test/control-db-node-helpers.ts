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
import type { IRawStorage } from '@optimystic/db-p2p';
import { FileRawStorage } from '@optimystic/db-p2p-storage-fs';
import type { CadreNode } from '../src/cadre-node.js';
import { withTimeout } from '../src/control-stream.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import type { InMemoryKeyStore } from '../src/key-store.js';
import { signPeerRecord } from '../src/peer-record.js';
import type { CadreNodeConfig, NetworkConfig, NodeProfile, RawStorageProvider } from '../src/types.js';

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

export interface ControlNodeConfigOpts {
	partyId: string;
	profile: NodeProfile;
	keyStore: InMemoryKeyStore;
	/**
	 * A single `IRawStorage` instance (control node and any strand node then
	 * share it) or a `(id) => IRawStorage` factory. Pass
	 * {@link fileStorageProvider} for a restart that survives on DISK rather
	 * than in the parent process's heap.
	 */
	storage: RawStorageProvider;
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
		profile: opts.profile,
		storage: { provider: opts.storage },
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
 * A `(id) => IRawStorage` factory backed by real files under `baseDir`, one
 * subdirectory per id — `'control'` for the control network (see
 * `CadreNode.startControlNetwork`), the strand id for each strand.
 *
 * The instance per id is MEMOISED, so two calls for the same id hand back the
 * same handle rather than two views of one directory. `CadreNode` asks once per
 * node instance, so a restart against the same `baseDir` gets a *new*
 * `FileRawStorage` reading the rows the previous run left on disk — which is the
 * point: unlike a shared `MemoryRawStorage`, nothing survives in the heap, so a
 * warm start that only appears to work because the old object was still around
 * cannot pass.
 */
export function fileStorageProvider(baseDir: string): (id: string) => IRawStorage {
	const byId = new Map<string, IRawStorage>();
	return (id: string) => {
		let storage = byId.get(id);
		if (!storage) {
			// encodeURIComponent: strand ids are caller-supplied and reach the
			// filesystem here, and `FileStoreDriver` does no escaping of its own.
			storage = new FileRawStorage(join(baseDir, encodeURIComponent(id)));
			byId.set(id, storage);
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
	const record = signPeerRecord({ peerId, publicKey: publicKeyB64, addrs, updatedAt: Date.now() }, privateKeyB64);
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
