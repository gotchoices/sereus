/**
 * Minimal `node:crypto` shim for the NativeScript runtime.
 *
 * Provides only `createHash()` (SHA-256 / SHA-512) via @noble/hashes, ported
 * from packages/reference-app-rn/polyfills/node-crypto.js. Used by
 * `multiformats/hashes/sha2`, which does:
 *   import crypto from 'crypto';
 *   crypto.createHash('sha256').update(input).digest();
 *
 * Key generation / sign / verify are intentionally NOT implemented here — the
 * @libp2p/crypto `*.browser.js` variants (selected by webpack.config.js's
 * `browser` alias field) cover those via WebCrypto + @noble/curves.
 */

import { sha256, sha512 } from '@noble/hashes/sha2.js';

type HashFn = (input: Uint8Array) => Uint8Array;

const hashFns: Record<string, HashFn> = {
	sha256,
	'sha-256': sha256,
	sha512,
	'sha-512': sha512,
};

class Hash {
	private readonly chunks: Uint8Array[] = [];

	constructor(private readonly fn: HashFn) {}

	update(data: Uint8Array | string): this {
		const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
		this.chunks.push(bytes);
		return this;
	}

	digest(): Uint8Array {
		let total = 0;
		for (const c of this.chunks) total += c.length;
		const buf = new Uint8Array(total);
		let off = 0;
		for (const c of this.chunks) {
			buf.set(c, off);
			off += c.length;
		}
		return this.fn(buf);
	}
}

export function createHash(algorithm: string): Hash {
	const fn = hashFns[algorithm.toLowerCase()];
	if (!fn) throw new Error(`Unsupported hash algorithm: ${algorithm}`);
	return new Hash(fn);
}

export default { createHash };
