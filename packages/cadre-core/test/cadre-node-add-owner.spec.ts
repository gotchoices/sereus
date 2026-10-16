import { describe, it, expect } from 'vitest';
import { peerIdFromEd25519PublicKeyB64 } from '../src/ed25519-key.js';
import { freshKeyPair } from './control-constraint-helpers.js';
import { startSelfOwnerNode } from './self-owner-node-helpers.js';

/**
 * `CadreNode.addOwner` while this node has no control connection. An `OwnerKey` add has no
 * re-issue path, so one committed alone in a party with other members would stay on this node:
 * refused by name. A party with no other members cannot fork, so a solo founder adding its
 * backup key commits.
 */
describe('CadreNode.addOwner while alone', () => {
	it('commits while the party has no other member, and is refused once it has one', async () => {
		const { node, ownerKey } = await startSelfOwnerNode('add-owner-alone-', { enrollOwner: true });
		try {
			expect(node.getControlConnectionCount()).toBe(0);
			const backup = freshKeyPair();
			expect(await node.addOwner(backup.publicKey, { label: ' paper backup ' })).toBe(true);
			expect(await node.listOwnerKeys()).toContainEqual({
				key: backup.publicKey, label: 'paper backup', vouchedBy: ownerKey.publicKeyB64, heldHere: false, trusted: true,
			});

			await node.authorizePeer(peerIdFromEd25519PublicKeyB64(freshKeyPair().publicKey)!);
			const refused = freshKeyPair();
			await expect(node.addOwner(refused.publicKey)).rejects.toMatchObject({ name: 'OwnerKeyAddRefusedError', code: 'alone' });
			expect((await node.getControlDatabase()!.getOwnerKeys()).has(refused.publicKey)).toBe(false);
		} finally {
			await node.stop();
		}
	}, 60_000);
});
