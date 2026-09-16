import { describe, it, expect, afterEach } from 'vitest';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import type { createLibp2pNode, IRawStorage } from '@optimystic/db-p2p';
import { CadreNode } from '../src/cadre-node.js';
import { controlStorageScope, isControlStorageScope } from '../src/storage-scope.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * The control database's storage scope key carries the party id, so two parties on
 * one device never share a control store — which is what `CadreNodeConfig.storage`
 * used to do, a node started for one party reading the other's strands, owner keys
 * and peers as its own (`tickets/complete/phone-control-storage-shared-across-parties`).
 *
 * Property, not instance: the assertions below are about the relationship between the
 * party id and the store handed out, so a future change that scopes by something other
 * than base64url still has to satisfy them.
 *
 * `buildControlNodeOptions` is private and pure on a bare `new CadreNode` — it reads
 * only `this.config` — so this file starts no libp2p node, opens no database and
 * touches no filesystem. Same access shape as
 * `cadre-node-control-node-options.spec.ts`, which covers the resolve-once /
 * cache-wrapper half of the same seam.
 */
function controlOptions(node: CadreNode): Parameters<typeof createLibp2pNode>[0] {
	return (node as unknown as {
		buildControlNodeOptions: () => Parameters<typeof createLibp2pNode>[0]
	}).buildControlNodeOptions();
}

/** `stop()`'s teardown, reached the same private-cast way; retires the cache registration. */
function nodeCleanup(node: CadreNode): Promise<void> {
	return (node as unknown as { cleanup(): Promise<void> }).cleanup();
}

/** Every node built in a test, so `afterEach` can retire its shared-pool registration. */
const built: CadreNode[] = [];

afterEach(async () => {
	// `wrapStorageWithCache` registers in a PROCESS-WIDE pool; leaving registrations
	// behind would make any pool-population assertion elsewhere in this process read
	// a polluted baseline. `cleanup` is safe on a bare node — every handle it touches
	// is null or a constructor-built object whose dispose is a no-op when never started.
	for (const node of built.splice(0)) {
		await nodeCleanup(node);
	}
});

/**
 * One provider shared by every node in a test, memoized per scope — the shape of a real
 * persistent provider (one directory or database per scope), and the shape in which the
 * bug was visible: two nodes over ONE provider used to be handed ONE store.
 */
function memoizingProvider(): { provider: (scope: string) => IRawStorage; scopes: string[] } {
	const scopes: string[] = [];
	const stores = new Map<string, IRawStorage>();
	const provider = (scope: string): IRawStorage => {
		scopes.push(scope);
		let store = stores.get(scope);
		if (!store) {
			// A bare object, not a MemoryRawStorage: `buildControlNodeOptions` passes a
			// MemoryRawStorage through UNWRAPPED, and these assertions are about which
			// object the node ends up with, so the cache wrapper must be on every arm alike.
			store = {} as IRawStorage;
			stores.set(scope, store);
		}
		return store;
	};
	return { provider, scopes };
}

function nodeForParty(partyId: string, provider: (scope: string) => IRawStorage): CadreNode {
	const config: CadreNodeConfig = {
		controlNetwork: { partyId, bootstrapNodes: [] },
		profile: 'transaction',
		storage: { provider }
	};
	const node = new CadreNode(config);
	built.push(node);
	return node;
}

/** The inverse of `controlStorageScope`, spelled out so the encoding is pinned both ways. */
function decodeControlScope(scope: string): string {
	return uint8ArrayToString(uint8ArrayFromString(scope.slice('control-'.length), 'base64url'), 'utf8');
}

describe('control storage scope', () => {
	it('gives two parties on one provider two different control stores', () => {
		const { provider, scopes } = memoizingProvider();

		const a = controlOptions(nodeForParty('party-a', provider));
		const b = controlOptions(nodeForParty('party-b', provider));

		expect(scopes).toEqual([controlStorageScope('party-a'), controlStorageScope('party-b')]);
		expect(scopes[0]).not.toBe(scopes[1]);
		expect(a.storage).toBeDefined();
		expect(a.storage).not.toBe(b.storage);
	});

	it('gives the same party the same control store, so a restart reaches its own data', () => {
		// The `RawStorageProvider` contract's other half: a provider is re-entered for a
		// scope whose runtime has stopped and must reach the SAME durable backend. A key
		// that varied per node (a random suffix, say) would satisfy the test above and
		// silently orphan every party's data on restart.
		const { provider, scopes } = memoizingProvider();

		const first = controlOptions(nodeForParty('party-a', provider));
		const second = controlOptions(nodeForParty('party-a', provider));

		expect(scopes).toEqual([controlStorageScope('party-a'), controlStorageScope('party-a')]);
		expect(second.storage).toBe(first.storage);
	});

	/**
	 * A party id is arbitrary text — nothing in cadre-core validates its shape, and the
	 * React Native app lets a user type one into Settings. Scope keys reach real
	 * namespaces unescaped (cadre-cli's `${config.path}/${scope}`, a LevelDB filename, an
	 * IndexedDB database name), so the charset invariant is load-bearing rather than
	 * decorative — without this arm the encoding looks like ceremony and the next editor
	 * removes it.
	 */
	it.each([
		['a path traversal', '../../etc/passwd'],
		['an embedded separator', 'party/with/slashes'],
		['a Windows separator and drive', 'C:\\party'],
		['non-ASCII text', 'партия-🗝'],
		['the empty string', ''],
		['a plain uuid', '11111111-2222-4333-8444-555555555555'],
	])('keeps the scope key path-safe and reversible for %s', (_label, partyId) => {
		const scope = controlStorageScope(partyId);

		expect(scope).toMatch(/^[A-Za-z0-9._-]+$/);
		expect(decodeControlScope(scope)).toBe(partyId);
	});

	it('recognizes its own keys and rejects strand ids', () => {
		expect(isControlStorageScope(controlStorageScope('party-a'))).toBe(true);
		// A strand scope is a strand id; every id cadre-core mints is `strand-`-prefixed.
		expect(isControlStorageScope('strand-1789519231669-k3f9qz')).toBe(false);
		expect(isControlStorageScope('11111111-2222-4333-8444-555555555555')).toBe(false);
		// The pre-fix literal is not a control scope either: a provider still special-
		// casing it is looking for a key cadre-core no longer mints.
		expect(isControlStorageScope('control')).toBe(false);
	});
});
