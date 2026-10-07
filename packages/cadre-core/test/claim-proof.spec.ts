import { describe, it, expect } from 'vitest';
import { randomBytes } from '@optimystic/quereus-plugin-crypto';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { claimProof, verifyClaimProof, parseClaimSecret, CLAIM_SECRET_BYTES } from '../src/claim-proof.js';

describe('claim proof', () => {
	const secret = parseClaimSecret(randomBytes(CLAIM_SECRET_BYTES * 8, 'base64url') as string);
	const nodePeerId = '12D3KooWClaimedNode';
	const signerKey = 'owner-key-b64url';
	const seedDigest = 'seed-digest-b64url';

	it('verifies for the node, signer and seed it was built over, and for no other', () => {
		const proof = claimProof(secret, nodePeerId, signerKey, seedDigest);

		expect(verifyClaimProof(secret, nodePeerId, signerKey, seedDigest, proof)).toBe(true);
		// Each binding on its own: a captured proof moves to no other node, anchors no
		// other owner, and attaches to no other seed.
		expect(verifyClaimProof(secret, 'another-node', signerKey, seedDigest, proof)).toBe(false);
		expect(verifyClaimProof(secret, nodePeerId, 'another-signer', seedDigest, proof)).toBe(false);
		expect(verifyClaimProof(secret, nodePeerId, signerKey, 'another-digest', proof)).toBe(false);
	});

	it('parseClaimSecret accepts 32 base64url bytes and names, without echoing, what it refuses', () => {
		expect(parseClaimSecret(` ${uint8ArrayToString(secret, 'base64url')} `)).toEqual(secret);

		const short = randomBytes(128, 'base64url') as string;
		let message = '';
		try {
			parseClaimSecret(short);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toMatch(/exactly 32 bytes/);
		expect(message).not.toContain(short);
		expect(() => parseClaimSecret('not base64url!')).toThrow(/base64url/);
		expect(() => parseClaimSecret('   ')).toThrow(/required/);
	});
});
