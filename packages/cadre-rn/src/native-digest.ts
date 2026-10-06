/**
 * Native SHA-256/512 behind `crypto.subtle.digest`, once a native hash is available.
 *
 * The kit's boot polyfill (`polyfills/hermes.js`) defines `crypto.subtle.digest` with
 * `@noble/hashes`, because it runs before any native module can load and must work in
 * an app that installs none. multiformats' browser `sha256` reaches it, and Optimystic
 * hashes every block it stores or compares (`canonicalBlockHash`). In pure JavaScript on
 * Hermes that digest took 47% of sereus-chat's JS time in a device CPU profile
 * (`feat-rn-kit-native-digest`).
 *
 * `installNativeDigest` replaces that fallback with a native `createHash`, such as
 * react-native-quick-crypto's. It replaces only a digest the boot polyfill tagged: a
 * runtime with real WebCrypto, or an app that installed its own digest, is left alone.
 * It checks the native hash against a known vector before trusting it, keeps the
 * fallback for any other algorithm, and does nothing the second time.
 *
 * `@serfab/cadre-rn/noise-crypto` calls it when it loads, so an app that passes native
 * Noise crypto gets native hashing too. Hashing that runs before that import uses the
 * fallback. This module imports no native module, so an app without native Noise can
 * call it with its own `createHash`.
 *
 * multiformats reads `crypto.subtle.digest` on every call, so a replacement made after
 * boot applies from the next hash on.
 */

/** The tag `polyfills/hermes.js` puts on its pure-JavaScript `digest`. */
export const JS_DIGEST_TAG = Symbol.for('@serfab/cadre-rn/js-digest');
/** The tag this module puts on the native `digest` it installs. */
const NATIVE_DIGEST_TAG = Symbol.for('@serfab/cadre-rn/native-digest');

/** The part of a Node-style hash object this module uses (quick-crypto and `node:crypto` both fit). */
export interface HashLike {
	update(data: Uint8Array): HashLike;
	digest(): Uint8Array;
}
export type CreateHash = (algorithm: string) => HashLike;

/** `SubtleCrypto.digest`'s parameters, declared here so the module needs no DOM typings. */
type DigestAlgorithm = string | { name: string };
type DigestInput = ArrayBuffer | ArrayBufferView;
type DigestFn = (algorithm: DigestAlgorithm, data: DigestInput) => Promise<ArrayBuffer>;
/** The part of `SubtleCrypto` this module reads and replaces. */
export interface DigestHolder {
	digest: DigestFn;
}

export type NativeDigestOutcome =
	/** The tagged fallback was replaced. */
	| 'installed'
	/** A native digest from this module was already in place. */
	| 'already'
	/** The digest present is not the kit's fallback (real WebCrypto, or the app's own); left as is. */
	| 'not-polyfilled'
	/** The native hash failed the known-vector check or threw; the fallback stays. */
	| 'check-failed';

/** WebCrypto algorithm names to Node `createHash` names. Anything else stays with the fallback. */
const NODE_NAMES: Readonly<Record<string, string>> = { 'SHA-256': 'sha256', 'SHA-512': 'sha512' };
/** SHA-256("abc"), FIPS 180-2 appendix B.1. */
const ABC_SHA256_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Digest input as a byte view over the same memory, without copying. */
function asBytes(data: DigestInput): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return new Uint8Array(data);
}

/** The digest's bytes as an `ArrayBuffer` of exactly that length, as `SubtleCrypto.digest` returns. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function algorithmName(algorithm: DigestAlgorithm): string {
	return typeof algorithm === 'string' ? algorithm : algorithm.name;
}

function isTagged(fn: unknown, tag: symbol): boolean {
	return typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[tag] === true;
}

function passesKnownVector(createHash: CreateHash): boolean {
	try {
		const abc = new Uint8Array([0x61, 0x62, 0x63]);
		return toHex(new Uint8Array(createHash('sha256').update(abc).digest())) === ABC_SHA256_HEX;
	} catch (err) {
		console.warn('[cadre-rn] native digest check threw; keeping the JavaScript digest:', err);
		return false;
	}
}

/**
 * Replace the boot polyfill's JavaScript `digest` on `subtle` with one over `createHash`.
 * `subtle` defaults to `globalThis.crypto.subtle`.
 */
export function installNativeDigest(
	createHash: CreateHash,
	subtle: DigestHolder | undefined = (globalThis as { crypto?: { subtle?: DigestHolder } }).crypto?.subtle,
): NativeDigestOutcome {
	if (!subtle) return 'not-polyfilled';
	if (isTagged(subtle.digest, NATIVE_DIGEST_TAG)) return 'already';
	if (!isTagged(subtle.digest, JS_DIGEST_TAG)) return 'not-polyfilled';
	if (!passesKnownVector(createHash)) {
		console.warn('[cadre-rn] native SHA-256 failed its known-vector check; keeping the JavaScript digest');
		return 'check-failed';
	}

	const fallback = subtle.digest;
	const digest: DigestFn = (algorithm, data) => {
		const name = NODE_NAMES[algorithmName(algorithm)];
		if (!name) return fallback.call(subtle, algorithm, data);
		try {
			return Promise.resolve(toArrayBuffer(new Uint8Array(createHash(name).update(asBytes(data)).digest())));
		} catch (err) {
			return Promise.reject(err);
		}
	};
	(digest as unknown as Record<symbol, unknown>)[NATIVE_DIGEST_TAG] = true;
	subtle.digest = digest;
	return 'installed';
}

/** Whether `subtle`'s digest is the native one this module installed. */
export function nativeDigestActive(
	subtle: DigestHolder | undefined = (globalThis as { crypto?: { subtle?: DigestHolder } }).crypto?.subtle,
): boolean {
	return !!subtle && isTagged(subtle.digest, NATIVE_DIGEST_TAG);
}
