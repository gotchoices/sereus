import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { verify } from '@optimystic/quereus-plugin-crypto';
import { buildAuthorizationMessage } from '../src/control-database.js';
import { ed25519KeyPairFromLibp2p } from '../src/ed25519-key.js';
import { softwareOwnerSigner } from '../src/owner-signer.js';

describe('softwareOwnerSigner', () => {
	it('signs an owner digest so the control schema\'s own check accepts it', async () => {
		const { privateKeyB64, publicKeyB64 } = ed25519KeyPairFromLibp2p(await generateKeyPair('Ed25519'));
		const signer = softwareOwnerSigner(privateKeyB64);
		expect(signer.publicKey).toBe(publicKeyB64);

		const message = buildAuthorizationMessage('CadreControl.OwnerKey', 'add', 'party-a', [publicKeyB64, 'stamp-1']);
		const signature = await signer.approve({ partyId: 'party-a', action: 'Add owner key' }, (sign) => sign(message));

		// The call the schema makes: verify(digest(...), context.Signature, A.Key, 'ed25519'), the digest as bytes.
		expect(verify(message, signature, signer.publicKey, 'ed25519')).toBe(true);
	});
});
