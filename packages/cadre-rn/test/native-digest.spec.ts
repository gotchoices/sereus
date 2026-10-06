/**
 * `installNativeDigest` against a `crypto.subtle`-shaped object, with `node:crypto`'s
 * `createHash` as the native hash (the same API react-native-quick-crypto implements).
 * Nothing global is touched: every case passes its own `subtle`.
 */

import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
	installNativeDigest,
	JS_DIGEST_TAG,
	nativeDigestActive,
	type CreateHash,
	type DigestHolder,
} from '../src/native-digest.js';

const nodeCreateHash: CreateHash = algorithm => createHash(algorithm);

/** A `subtle` whose digest is tagged as the boot polyfill tags it, and counts its calls. */
function polyfilledSubtle(): DigestHolder & { fallbackCalls: string[] } {
	const fallbackCalls: string[] = [];
	const digest = (algorithm: string | { name: string }, data: ArrayBuffer | ArrayBufferView) => {
		fallbackCalls.push(typeof algorithm === 'string' ? algorithm : algorithm.name);
		return webcrypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>);
	};
	(digest as unknown as Record<symbol, unknown>)[JS_DIGEST_TAG] = true;
	return { digest, fallbackCalls };
}

function hex(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString('hex');
}

describe('installNativeDigest', () => {
	it('replaces the tagged fallback, and hashes SHA-256 and SHA-512 natively', async () => {
		const subtle = polyfilledSubtle();
		expect(installNativeDigest(nodeCreateHash, subtle)).toBe('installed');
		expect(nativeDigestActive(subtle)).toBe(true);

		const data = new TextEncoder().encode('a block to hash');
		for (const algorithm of ['SHA-256', 'SHA-512', { name: 'SHA-256' }] as const) {
			const got = await subtle.digest(algorithm, data);
			expect(hex(got)).toBe(hex(await webcrypto.subtle.digest(algorithm, data)));
		}
		expect(subtle.fallbackCalls).toEqual([]);
	});

	it('hashes exactly the bytes of a view, not its whole buffer', async () => {
		const subtle = polyfilledSubtle();
		installNativeDigest(nodeCreateHash, subtle);
		const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
		const view = backing.subarray(2, 5);
		const dataView = new DataView(backing.buffer, 2, 3);
		const expected = hex(await webcrypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3])));
		expect(hex(await subtle.digest('SHA-256', view))).toBe(expected);
		expect(hex(await subtle.digest('SHA-256', dataView))).toBe(expected);
		expect(hex(await subtle.digest('SHA-256', new Uint8Array([1, 2, 3]).buffer))).toBe(expected);
	});

	it('returns an ArrayBuffer of exactly the digest length', async () => {
		const subtle = polyfilledSubtle();
		installNativeDigest(nodeCreateHash, subtle);
		const out = await subtle.digest('SHA-256', new Uint8Array([1]));
		expect(out).toBeInstanceOf(ArrayBuffer);
		expect(out.byteLength).toBe(32);
	});

	it('leaves any other algorithm to the fallback', async () => {
		const subtle = polyfilledSubtle();
		installNativeDigest(nodeCreateHash, subtle);
		await subtle.digest('SHA-1', new Uint8Array([1]));
		expect(subtle.fallbackCalls).toEqual(['SHA-1']);
	});

	it('leaves an untagged digest alone (real WebCrypto, or the app\'s own)', () => {
		// Real WebCrypto's digest, untagged.
		const original: DigestHolder['digest'] = (algorithm, data) =>
			webcrypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>);
		const subtle: DigestHolder = { digest: original };
		expect(installNativeDigest(nodeCreateHash, subtle)).toBe('not-polyfilled');
		expect(subtle.digest).toBe(original);
		expect(installNativeDigest(nodeCreateHash, undefined)).toBe('not-polyfilled');
	});

	it('does nothing the second time', () => {
		const subtle = polyfilledSubtle();
		expect(installNativeDigest(nodeCreateHash, subtle)).toBe('installed');
		const installed = subtle.digest;
		expect(installNativeDigest(nodeCreateHash, subtle)).toBe('already');
		expect(subtle.digest).toBe(installed);
	});

	it('keeps the fallback when the native hash fails the known-vector check, or throws', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const wrong: CreateHash = () => createHash('sha512');
			const subtle = polyfilledSubtle();
			const before = subtle.digest;
			expect(installNativeDigest(wrong, subtle)).toBe('check-failed');
			expect(subtle.digest).toBe(before);

			const throwing: CreateHash = () => { throw new Error('no native module'); };
			expect(installNativeDigest(throwing, subtle)).toBe('check-failed');
			expect(subtle.digest).toBe(before);
			expect(nativeDigestActive(subtle)).toBe(false);
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it('rejects, rather than throws, when the native hash fails mid-call', async () => {
		let calls = 0;
		const flaky: CreateHash = algorithm => {
			if (++calls > 1) throw new Error('native failure');
			return createHash(algorithm);
		};
		const subtle = polyfilledSubtle();
		installNativeDigest(flaky, subtle);
		await expect(subtle.digest('SHA-256', new Uint8Array([1]))).rejects.toThrow('native failure');
	});
});
