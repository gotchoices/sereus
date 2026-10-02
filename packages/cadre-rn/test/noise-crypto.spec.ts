/**
 * The adapter against noise's own pure-JS implementation, byte for byte.
 *
 * `vitest.config.ts` aliases the two native modules to `node:crypto` and `node:buffer`,
 * whose API they implement, so what runs here is the adapter's own framing: the DER
 * prefixes, the tag placement, the list flattening, and which functions each mode
 * replaces. A wrong prefix or a misplaced tag shows up as a mismatch with
 * `noisePureJsCrypto`, which is the implementation the other side of a real handshake
 * may well be running.
 */

import { randomBytes } from 'node:crypto';
import { noisePureJsCrypto } from '@optimystic/db-p2p';
import { Uint8ArrayList } from 'uint8arraylist';
import { describe, expect, it } from 'vitest';

import { buildNoiseCrypto, type NoiseCryptoMode } from '../src/noise-crypto.js';

const X25519_FUNCTIONS = ['generateX25519KeyPair', 'generateX25519KeyPairFromSeed', 'generateX25519SharedKey'] as const;

/** Noise's cipher functions may return either shape; compare contiguous bytes. */
function bytes(data: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	return data instanceof Uint8Array ? data : data.subarray();
}

/** Plain `Uint8Array`s, so no comparison below can hinge on a `Buffer` subclass. */
function random(length: number): Uint8Array {
	return new Uint8Array(randomBytes(length));
}

function build(mode: NoiseCryptoMode) {
	const crypto = buildNoiseCrypto(mode);
	if (!crypto) throw new Error(`mode '${mode}' built no implementation`);
	return crypto;
}

describe('buildNoiseCrypto', () => {
	it("returns undefined for 'off', leaving noise on its default", () => {
		expect(buildNoiseCrypto('off')).toBeUndefined();
	});

	it("keeps the pure-JS x25519 functions under 'symmetric'", () => {
		const crypto = build('symmetric');
		for (const name of X25519_FUNCTIONS) expect(crypto[name], name).toBe(noisePureJsCrypto[name]);
	});

	it("replaces the x25519 functions under 'full'", () => {
		const crypto = build('full');
		for (const name of X25519_FUNCTIONS) expect(crypto[name], name).not.toBe(noisePureJsCrypto[name]);
	});
});

// 'full' spreads the same symmetric functions, so they are exercised once, here.
describe("symmetric primitives under 'symmetric'", () => {
	const crypto = build('symmetric');
	const key = random(32);
	const nonce = random(12);
	const ad = random(32);
	const plaintext = random(512);

	it('hashes a Uint8Array as pure JS does', () => {
		expect(crypto.hashSHA256(plaintext)).toEqual(noisePureJsCrypto.hashSHA256(plaintext));
	});

	it('hashes a multi-chunk Uint8ArrayList as pure JS does', () => {
		const list = new Uint8ArrayList(plaintext.subarray(0, 100), plaintext.subarray(100, 300), plaintext.subarray(300));
		expect(crypto.hashSHA256(list)).toEqual(noisePureJsCrypto.hashSHA256(plaintext));
	});

	it('encrypts to the same ciphertext and tag as pure JS', () => {
		const native = bytes(crypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key));
		expect(native).toEqual(bytes(noisePureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key)));
	});

	it('decrypts what pure JS encrypted', () => {
		const sealed = bytes(noisePureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key));
		expect(bytes(crypto.chaCha20Poly1305Decrypt(sealed, nonce, ad, key))).toEqual(plaintext);
	});

	it('refuses a ciphertext whose tag was altered', () => {
		const sealed = new Uint8Array(bytes(noisePureJsCrypto.chaCha20Poly1305Encrypt(plaintext, nonce, ad, key)));
		sealed[sealed.length - 1] ^= 0x01;
		expect(() => crypto.chaCha20Poly1305Decrypt(sealed, nonce, ad, key)).toThrow();
	});
});

describe("x25519 under 'full'", () => {
	const crypto = build('full');

	it('derives the same key pair from a seed as pure JS', () => {
		const seed = random(32);
		expect(crypto.generateX25519KeyPairFromSeed(seed)).toEqual(noisePureJsCrypto.generateX25519KeyPairFromSeed(seed));
	});

	it('computes the same shared key as pure JS for the same key pairs', () => {
		const ours = noisePureJsCrypto.generateX25519KeyPair();
		const theirs = noisePureJsCrypto.generateX25519KeyPair();
		expect(crypto.generateX25519SharedKey(ours.privateKey, theirs.publicKey))
			.toEqual(noisePureJsCrypto.generateX25519SharedKey(ours.privateKey, theirs.publicKey));
	});

	it('generates a key pair that agrees with a pure-JS peer in both directions', () => {
		const native = crypto.generateX25519KeyPair();
		const peer = noisePureJsCrypto.generateX25519KeyPair();
		expect(native.publicKey).toHaveLength(32);
		expect(native.privateKey).toHaveLength(32);
		expect(crypto.generateX25519SharedKey(native.privateKey, peer.publicKey))
			.toEqual(noisePureJsCrypto.generateX25519SharedKey(peer.privateKey, native.publicKey));
	});
});
