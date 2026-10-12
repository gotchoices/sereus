import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';

import {
	CADRE_INVITATION_PREFIX,
	CADRE_JOIN_REQUEST_PREFIX,
	decodeCadreJoinRequest,
	encodeCadreJoinRequest,
} from '../src/cadre-join-request.js';

/** A request body encoded by hand, as a peer that skipped the encoder's checks would send it. */
function handEncoded(body: Record<string, unknown>): string {
	return CADRE_JOIN_REQUEST_PREFIX + uint8ArrayToString(new TextEncoder().encode(JSON.stringify(body)), 'base64url');
}

/**
 * The join request an app copies to the app that manages the cadre: encode → decode is the
 * identity, and the decoder refuses by name what would make a useless invitation.
 */
describe('cadre join request', () => {
	it('round-trips, and refuses a missing prefix, a pasted invitation, a non-Ed25519 peer id and an over-long name', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const encoded = encodeCadreJoinRequest({ v: 1, peerId, appName: '  Chat on Ana\'s phone ' });
		expect(encoded.startsWith(CADRE_JOIN_REQUEST_PREFIX)).toBe(true);
		expect(decodeCadreJoinRequest(`\n${encoded}  `)).toEqual({ v: 1, peerId, appName: 'Chat on Ana\'s phone' });

		expect(() => decodeCadreJoinRequest(encoded.slice(CADRE_JOIN_REQUEST_PREFIX.length))).toThrow(/must start with/);
		expect(() => decodeCadreJoinRequest(`${CADRE_INVITATION_PREFIX}eyJ2IjoxfQ`)).toThrow(/cadre invitation, not a join request/);
		// A targeted invitation names the requester's key, which only an Ed25519 peer id embeds.
		const secp = peerIdFromPrivateKey(await generateKeyPair('secp256k1')).toString();
		expect(() => decodeCadreJoinRequest(handEncoded({ v: 1, peerId: secp, appName: 'App' }))).toThrow(/must be an Ed25519 peer id/);
		expect(() => decodeCadreJoinRequest(handEncoded({ v: 1, peerId, appName: 'x'.repeat(65) }))).toThrow(/at most 64 characters/);
		// The encoder refuses what the decoder would, so an app cannot copy a request the owner's app rejects.
		expect(() => encodeCadreJoinRequest({ v: 1, peerId, appName: '   ' })).toThrow(/must name the requesting app/);
	});

	it('carries a reply to an app\'s own scheme, and refuses a web scheme or a guessable nonce both ways', async () => {
		const peerId = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
		const linked = { v: 1 as const, peerId, appName: 'Chat', reply: { scheme: 'sereus-chat', nonce: 'AbCdEfGhIjKlMnOp_-12' } };
		expect(decodeCadreJoinRequest(encodeCadreJoinRequest(linked))).toEqual(linked);

		// An owner app opens the reply itself, so a request must not be able to aim the invitation at a web server.
		const web = { ...linked, reply: { ...linked.reply, scheme: 'https' } };
		expect(() => encodeCadreJoinRequest(web)).toThrow(/an app's own scheme, not "https"/);
		expect(() => decodeCadreJoinRequest(handEncoded(web))).toThrow(/an app's own scheme, not "https"/);
		const guessable = { ...linked, reply: { ...linked.reply, nonce: 'short' } };
		expect(() => encodeCadreJoinRequest(guessable)).toThrow(/nonce must be 16 to 64/);
		expect(() => decodeCadreJoinRequest(handEncoded(guessable))).toThrow(/nonce must be 16 to 64/);
	});
});
