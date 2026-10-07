import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';

import { decodeNodeClaimPayload, encodeNodeClaimPayload, NODE_CLAIM_PAYLOAD_PREFIX } from '../src/node-claim-payload.js';

/**
 * The QR payload a host shows and a phone scans: encode → decode is the identity, and the
 * decoder refuses an address that would send the phone to another node.
 */
describe('node claim payload', () => {
	it('round-trips, and refuses an address naming another peer', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const other = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const secret = randomBytes(32).toString('base64url');
		const multiaddrs = [
			`/ip4/203.0.113.5/tcp/10004/ws/p2p/${peerId}`,
			`/ip4/192.168.1.20/tcp/10003/p2p/${peerId}`,
		];

		const encoded = encodeNodeClaimPayload({ peerId, multiaddrs, secret });
		expect(encoded.startsWith(NODE_CLAIM_PAYLOAD_PREFIX)).toBe(true);
		// Opaque to a scanner: the secret and addresses are not readable in the text.
		expect(encoded).not.toContain(secret);
		expect(decodeNodeClaimPayload(`  ${encoded}\n`)).toEqual({ peerId, multiaddrs, secret });

		expect(() => decodeNodeClaimPayload(encodeNodeClaimPayload({
			peerId,
			multiaddrs: [multiaddrs[0]!, `/ip4/192.168.1.20/tcp/10003/p2p/${other}`],
			secret,
		}))).toThrow(/names another peer/);
		// The encoder applies the same rule, so a host cannot show a payload the phone refuses.
		expect(() => encodeNodeClaimPayload({ peerId, multiaddrs: [`/ip4/192.168.1.20/tcp/10003/p2p/${other}`], secret }))
			.toThrow(/names another peer/);
		expect(() => decodeNodeClaimPayload(`sereus-join:2.${encoded.slice(NODE_CLAIM_PAYLOAD_PREFIX.length)}`))
			.toThrow(/must start with/);
	});
});
