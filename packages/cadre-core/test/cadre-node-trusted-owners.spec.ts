import { describe, it, expect } from 'vitest';
import { generatePrivateKey, getPublicKey } from '@optimystic/quereus-plugin-crypto';
import { CadreNode } from '../src/cadre-node.js';
import { MemoryTrustedOwnerStore } from '../src/trusted-owner-store.js';
import type { CadreNodeConfig } from '../src/types.js';

/**
 * Wiring coverage for the node-local trusted-owner anchor
 * (`CadreNodeConfig.trustedOwners` → `CadreNode.getTrustedOwnerStore`):
 * construction/adoption in start(), config-pin seeding, the runtime enrollment
 * seam (`trustOwnerKeys`), genesis self-trust via `initializeSeedBootstrap`,
 * and the fail-closed party-scope check. The store contract itself is covered
 * in trusted-owner-store.spec.ts.
 */
describe('CadreNode trusted-owner anchor wiring', () => {
	function makeNode(partyId: string, trustedOwners?: CadreNodeConfig['trustedOwners']): CadreNode {
		return new CadreNode({
			controlNetwork: { partyId, bootstrapNodes: [] },
			profile: 'transaction',
			trustedOwners,
		});
	}

	/** Start a node and neutralize the background self-registration timer. */
	async function startClean(node: CadreNode): Promise<void> {
		await node.start();
		clearTimeout((node as unknown as { selfRegistrationTimer: ReturnType<typeof setTimeout> }).selfRegistrationTimer);
		(node as unknown as { selfRegistrationTimer: null }).selfRegistrationTimer = null;
	}

	it('exposes no store before start, a party-scoped in-memory default after', async () => {
		const partyId = 'anchor-' + Math.random().toString(36).slice(2);
		const node = makeNode(partyId);
		expect(node.getTrustedOwnerStore()).toBeNull();
		try {
			await startClean(node);
			const store = node.getTrustedOwnerStore();
			expect(store).not.toBeNull();
			expect(store!.partyId).toBe(partyId);
			expect(store!.all().size).toBe(0);
		} finally {
			await node.stop();
		}
	}, 60_000);

	it('seeds config pins, adopts an injected store, anchors genesis on initializeSeedBootstrap, and keeps the anchor across stop()→start()', async () => {
		const partyId = 'anchor-' + Math.random().toString(36).slice(2);
		const injected = new MemoryTrustedOwnerStore(partyId);
		const pinnedPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const pinned = getPublicKey(pinnedPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		const runtimePrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const runtimeKey = getPublicKey(runtimePrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		const ownerPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const ownerPublicKey = getPublicKey(ownerPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		const node = makeNode(partyId, { store: injected, pinnedKeys: [pinned], pinnedSource: 'invite' });
		try {
			await startClean(node);
			// Adopted the injected instance and seeded the config pin into it.
			expect(node.getTrustedOwnerStore()).toBe(injected);
			expect(injected.has(pinned)).toBe(true);

			// Runtime enrollment seam.
			await node.trustOwnerKeys([runtimeKey], 'operator');
			expect(injected.has(runtimeKey)).toBe(true);

			// Genesis self-trust: wiring seed-bootstrap with an owner private key
			// anchors the derived public key.
			node.initializeSeedBootstrap(ownerPrivateKey);
			expect(injected.has(ownerPublicKey)).toBe(true);

			// Restart cycle: the anchor survives (same store, nothing dropped).
			await node.stop();
			await startClean(node);
			expect(node.getTrustedOwnerStore()).toBe(injected);
			expect(injected.all()).toEqual(new Set([pinned, runtimeKey, ownerPublicKey]));
		} finally {
			await node.stop();
		}
	}, 120_000);

	it('trustOwnerKeys before start fails closed', async () => {
		const node = makeNode('anchor-' + Math.random().toString(36).slice(2));
		await expect(node.trustOwnerKeys(['K'], 'invite')).rejects.toThrow(/started before trusting/i);
	});

	it('trustOwnerKeys rejects a malformed key and anchors none of the batch', async () => {
		const partyId = 'anchor-' + Math.random().toString(36).slice(2);
		const goodPrivateKey = generatePrivateKey('ed25519', 'base64url') as string;
		const goodKey = getPublicKey(goodPrivateKey, 'ed25519', 'base64url', 'base64url') as string;
		const node = makeNode(partyId);
		try {
			await startClean(node);
			await expect(node.trustOwnerKeys([goodKey, 'not-a-key'], 'invite')).rejects.toThrow(/owner key/i);
			expect(node.getTrustedOwnerStore()!.has(goodKey)).toBe(false);
		} finally {
			await node.stop();
		}
	}, 60_000);

	it('a malformed config pin fails start() closed', async () => {
		const node = makeNode('anchor-' + Math.random().toString(36).slice(2), { pinnedKeys: ['not-a-key'] });
		await expect(node.start()).rejects.toThrow(/owner key/i);
	}, 60_000);

	it('an injected store scoped to a different party fails start() closed', async () => {
		const node = makeNode('anchor-' + Math.random().toString(36).slice(2), {
			store: new MemoryTrustedOwnerStore('some-other-party'),
		});
		await expect(node.start()).rejects.toThrow(/refusing to mix trust anchors/i);
	}, 60_000);
});
