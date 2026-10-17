import { describe, it, expect } from 'vitest';
import { InMemoryKeyStore } from '../src/key-store.js';
import { encodeOwnerKeyExport } from '../src/owner-key-export.js';
import { importOwnerKeyInto } from '../src/owner-key-flows.js';
import { readOwnerPrivateKey } from '../src/owner-key-store.js';
import { freshKeyPair } from './strand-spec-helpers.js';
import { newUnstartedNode } from './self-owner-node-helpers.js';

/**
 * The owner-key flows an app's owner-key screen calls (`owner-key-flows.ts`), on a real solo
 * node: an import wires a key only when the party lists it.
 */
describe('owner-key flows', () => {
	it('wires an imported key the party lists, and only stores one it does not', async () => {
		const { node, ownerKey } = await newUnstartedNode('owner-key-flows-import-');
		await node.start();
		try {
			// The party's owner, not yet held by this node: as on a phone whose owner slot was lost.
			await node.getControlDatabase()!.ensureOwnerKey(ownerKey.publicKeyB64);
			const stranger = freshKeyPair();

			const strangerStore = new InMemoryKeyStore();
			const notOwner = await importOwnerKeyInto(strangerStore, node, await encodeOwnerKeyExport({ privateKeyB64: stranger.privateKeyB64 }));
			expect(notOwner).toEqual({ publicKey: stranger.publicKeyB64, wired: false });
			expect(await readOwnerPrivateKey(strangerStore)).toBe(stranger.privateKeyB64);
			expect(node.getOwnerSigner()).toBeNull();

			const locked = await encodeOwnerKeyExport({ privateKeyB64: ownerKey.privateKeyB64, passphrase: 'correct horse' });
			const ownerStore = new InMemoryKeyStore();
			await expect(importOwnerKeyInto(ownerStore, node, locked)).rejects.toMatchObject({ name: 'OwnerKeyExportError', code: 'passphrase-required' });
			expect(await importOwnerKeyInto(ownerStore, node, locked, 'correct horse')).toEqual({ publicKey: ownerKey.publicKeyB64, wired: true });
			expect(await node.isOwner()).toBe(true);
		} finally {
			await node.stop();
		}
	}, 60_000);
});
