/**
 * Shared harness for the control-DB liveness suites —
 * `control-database-solo.spec.ts` (a cadre of one) and
 * `control-database-offline-peers.spec.ts` (a cadre whose known siblings are
 * unreachable). Both stand up a real `CadreNode` in the mobile/browser posture
 * (WebSockets-only transports, no listen address, no bootstrap peers) and wrap
 * every control operation in a labelled deadline, so the config builder and
 * the timeout wrapper live here once.
 *
 * Not a `*.spec.ts` file, so vitest's `test/**\/*.spec.ts` glob never runs it
 * as a suite (same pattern as `membership-gate-helpers.ts`).
 */

import { expect } from 'vitest';
import { webSockets } from '@libp2p/websockets';
import type { MemoryRawStorage } from '@optimystic/db-p2p';
import type { CadreNode } from '../src/cadre-node.js';
import { withTimeout } from '../src/control-stream.js';
import type { InMemoryKeyStore } from '../src/key-store.js';
import type { CadreNodeConfig, NetworkConfig, NodeProfile } from '../src/types.js';

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
	storage: MemoryRawStorage;
	/** Defaults to `[webSockets()]` — the mobile/browser posture. */
	transports?: NetworkConfig['transports'];
	/** Defaults to `[]` — no inbound connections, as RN/browser cannot accept them. */
	listenAddrs?: string[];
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
		storage: { provider: () => opts.storage },
		network: {
			transports: opts.transports ?? [webSockets()],
			// The RN/browser default (see types.ts NetworkConfig.listenAddrs): these
			// runtimes cannot accept inbound connections at all.
			listenAddrs: opts.listenAddrs ?? []
		}
	};
}
