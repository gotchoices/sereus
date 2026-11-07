/**
 * quick-crypto 1.1.7's `generateKeyPairSync('x25519', DER)` returns plain ArrayBuffers
 * where Node returns Buffers (gotchoices/sereus#58). This file swaps the aliased
 * `node:crypto` stand-in's `generateKeyPairSync` for one returning that shape, so the
 * adapter's handling of it runs here; `noise-crypto.spec.ts` covers the Buffer shape.
 */

import { noisePureJsCrypto } from '@optimystic/db-p2p';
import { describe, expect, it, vi } from 'vitest';

import { buildNoiseCrypto } from '../src/noise-crypto.js';

vi.mock('react-native-quick-crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	const toArrayBuffer = (der: Buffer): ArrayBuffer => new Uint8Array(der).buffer;
	return {
		...actual,
		generateKeyPairSync: (...args: Parameters<typeof actual.generateKeyPairSync>) => {
			const pair = actual.generateKeyPairSync(...args) as unknown as { publicKey: Buffer; privateKey: Buffer };
			return { publicKey: toArrayBuffer(pair.publicKey), privateKey: toArrayBuffer(pair.privateKey) };
		},
	};
});

describe("x25519 under 'full' when the key pair comes back as ArrayBuffers", () => {
	it('generates a key pair that agrees with a pure-JS peer in both directions', () => {
		const crypto = buildNoiseCrypto('full');
		if (!crypto) throw new Error("mode 'full' built no implementation");
		const native = crypto.generateX25519KeyPair();
		const peer = noisePureJsCrypto.generateX25519KeyPair();
		expect(native.publicKey).toBeInstanceOf(Uint8Array);
		expect(native.publicKey).toHaveLength(32);
		expect(native.privateKey).toHaveLength(32);
		expect(crypto.generateX25519SharedKey(native.privateKey, peer.publicKey))
			.toEqual(noisePureJsCrypto.generateX25519SharedKey(peer.privateKey, native.publicKey));
	});
});
