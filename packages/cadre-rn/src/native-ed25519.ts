/**
 * Native Ed25519 behind `crypto.subtle`, from a native WebCrypto such as
 * react-native-quick-crypto's.
 *
 * @libp2p/crypto signs and verifies Ed25519 through WebCrypto when a probe
 * (`subtle.generateKey({ name: 'Ed25519' })`) succeeds, and otherwise through pure-JS
 * `@noble/curves`. Hermes has no WebCrypto beyond the boot polyfill's `digest`, so every
 * signature a phone node makes or checks runs in JavaScript: sereus-chat measured 169 ms per
 * verify on a Galaxy S7 against 0.72 ms native, and Optimystic verifies on its reads.
 *
 * `installNativeEd25519` fills the methods libp2p's Ed25519 path calls -- `generateKey`,
 * `importKey`, `exportKey`, `sign`, `verify` -- from a native `SubtleCrypto`, only where the
 * global one lacks them: real WebCrypto is left alone. Signatures are byte-identical to
 * noble's, Ed25519 being deterministic.
 *
 * TIMING. @libp2p/crypto runs its probe once, when its Ed25519 module is evaluated, and keeps
 * the answer. So the install must precede any libp2p import: hence the boot-time
 * `@serfab/cadre-rn/polyfills/native-crypto`, not a call from `noise-crypto` (which itself
 * imports libp2p). This module imports no native module.
 */

/** The `SubtleCrypto` methods libp2p's Ed25519 path calls. */
export const ED25519_METHODS = ['generateKey', 'importKey', 'exportKey', 'sign', 'verify'] as const;
type Method = (typeof ED25519_METHODS)[number];

/** A `SubtleCrypto`, or the part of one this module reads or fills. */
export type SubtleLike = Partial<Record<Method, (...args: never[]) => unknown>> & object;

/** The tag this module puts on a `subtle` it filled. */
const NATIVE_ED25519_TAG = Symbol.for('@serfab/cadre-rn/native-ed25519');

export type NativeEd25519Outcome =
	/** Missing methods were filled from the native WebCrypto. */
	| 'installed'
	/** This module already filled them. */
	| 'already'
	/** The global WebCrypto has every method already (real WebCrypto); left as is. */
	| 'not-needed'
	/** No global `crypto.subtle`, or the native WebCrypto lacks a method; nothing changed. */
	| 'unavailable';

function globalSubtle(): SubtleLike | undefined {
	return (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
}

function isTagged(subtle: SubtleLike): boolean {
	return (subtle as Record<symbol, unknown>)[NATIVE_ED25519_TAG] === true;
}

/**
 * Fill `subtle`'s missing Ed25519 methods from `native`. All or nothing: if `native` lacks any
 * of them, nothing changes, so libp2p's probe never sees a half-native WebCrypto.
 */
export function installNativeEd25519(native: SubtleLike | undefined, subtle: SubtleLike | undefined = globalSubtle()): NativeEd25519Outcome {
	if (!subtle || !native) return 'unavailable';
	if (isTagged(subtle)) return 'already';
	const missing = ED25519_METHODS.filter(method => typeof subtle[method] !== 'function');
	if (missing.length === 0) return 'not-needed';
	if (missing.some(method => typeof native[method] !== 'function')) return 'unavailable';
	const target = subtle as Record<Method, unknown> & Record<symbol, unknown>;
	for (const method of missing) {
		target[method] = (native[method] as (...args: unknown[]) => unknown).bind(native);
	}
	target[NATIVE_ED25519_TAG] = true;
	return 'installed';
}

/** Whether this module filled `subtle`'s Ed25519 methods. */
export function nativeEd25519Active(subtle: SubtleLike | undefined = globalSubtle()): boolean {
	return !!subtle && isTagged(subtle);
}
