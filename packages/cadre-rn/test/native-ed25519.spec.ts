/**
 * `installNativeEd25519` — filling a JavaScript-only `crypto.subtle` with a native WebCrypto's
 * Ed25519 methods. Node's own WebCrypto stands in for react-native-quick-crypto's: the module's
 * decisions (fill what is missing, leave real WebCrypto alone, all or nothing) are what is
 * under test, and the filled methods must really sign and verify.
 */
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ED25519_METHODS, installNativeEd25519, nativeEd25519Active, type SubtleLike } from '../src/native-ed25519.js';

const native = webcrypto.subtle as unknown as SubtleLike;

/** What the boot polyfill leaves on Hermes: a `subtle` with a digest and nothing else. */
function bootSubtle(): SubtleLike & { digest: () => void } {
	return { digest: () => undefined };
}

describe('installNativeEd25519', () => {
	it('fills every missing Ed25519 method, and they sign and verify', async () => {
		const subtle = bootSubtle();
		expect(installNativeEd25519(native, subtle)).toBe('installed');
		for (const method of ED25519_METHODS) expect(typeof subtle[method]).toBe('function');
		expect(nativeEd25519Active(subtle)).toBe(true);

		const filled = subtle as unknown as SubtleCrypto;
		const keys = (await filled.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
		const message = new TextEncoder().encode('tally');
		const signature = await filled.sign({ name: 'Ed25519' }, keys.privateKey, message);
		expect(await filled.verify({ name: 'Ed25519' }, keys.publicKey, signature, message)).toBe(true);
	});

	it('keeps the digest it found', () => {
		const subtle = bootSubtle();
		const digest = subtle.digest;
		installNativeEd25519(native, subtle);
		expect(subtle.digest).toBe(digest);
	});

	it('leaves a complete WebCrypto alone', () => {
		const subtle = { ...Object.fromEntries(ED25519_METHODS.map(m => [m, () => undefined])) } as SubtleLike;
		const before = { ...subtle };
		expect(installNativeEd25519(native, subtle)).toBe('not-needed');
		expect(subtle).toEqual(before);
		expect(nativeEd25519Active(subtle)).toBe(false);
	});

	it('changes nothing when the native WebCrypto lacks a method, so no probe sees half of one', () => {
		const subtle = bootSubtle();
		const partial = { generateKey: () => undefined, sign: () => undefined } as SubtleLike;
		expect(installNativeEd25519(partial, subtle)).toBe('unavailable');
		expect(Object.keys(subtle)).toEqual(['digest']);
	});

	it('does nothing a second time', () => {
		const subtle = bootSubtle();
		installNativeEd25519(native, subtle);
		const sign = subtle.sign;
		expect(installNativeEd25519(native, subtle)).toBe('already');
		expect(subtle.sign).toBe(sign);
	});

	it('reports a missing native WebCrypto as unavailable', () => {
		expect(installNativeEd25519(undefined, bootSubtle())).toBe('unavailable');
	});

	it('defaults to the global crypto.subtle, which under Node is complete', () => {
		expect(installNativeEd25519(native)).toBe('not-needed');
	});
});
