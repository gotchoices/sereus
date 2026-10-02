/**
 * Native crypto for libp2p-noise on React Native.
 *
 * WHY THIS FILE EXISTS. `@chainsafe/libp2p-noise` ships two implementations and
 * picks by build condition: a NODE one backed by OpenSSL, and a BROWSER one where
 * `defaultCrypto = pureJsCrypto`. Metro resolves the browser build (the package's
 * `browser` field maps `crypto/index.js` to `crypto/index.browser.js`), so every
 * React Native app runs Noise's handshake and per-frame cipher in pure JavaScript,
 * interpreted by an engine with no JIT.
 *
 * Measured on device against Node on the same machine, in sereus-chat
 * (`test/stack/handshake-cost.mjs`; the figures and their context are recorded in
 * its `design/specs/mobile/STATUS.md`):
 *
 *   primitive                  Node (native)   emulator (Hermes)   Galaxy S7
 *   x25519 shared secret          2.635 ms         29.000 ms       57.650 ms
 *   chacha20-poly1305 (512B)      0.053 ms          2.735 ms        7.760 ms
 *   sha256 (512B)                 0.027 ms          5.335 ms       15.165 ms
 *
 * The emulator has a DESKTOP cpu and is still 11x-198x slower than Node on that
 * same machine, so this is not about old hardware: it is the runtime. A strand
 * bring-up pushes thousands of frames, and at those rates the loop is saturated
 * for long enough that libp2p's connection monitor gives up on its own pings and
 * tears connections down (gotchoices/sereus#13).
 *
 * WHAT THIS DOES. `@chainsafe/libp2p-noise` already contains a complete
 * `ICryptoInterface` written against Node's crypto API — the implementation React
 * Native does not get. `react-native-quick-crypto` implements that same API over
 * C++/JSI. So this is a port, not a new crypto implementation: the shapes below
 * follow noise's own `crypto/index.js` deliberately, including the DER prefixes,
 * because getting them subtly wrong is how key handling breaks silently.
 *
 * We do NOT write cryptography here. Every operation is delegated.
 */
import {
	createHash,
	createCipheriv,
	createDecipheriv,
	generateKeyPairSync,
	createPublicKey,
	createPrivateKey,
	diffieHellman,
} from 'react-native-quick-crypto';
// quick-crypto is typed against THIS Buffer, not the global one — they are
// different declarations of the same runtime shape, and mixing them is a type
// error rather than a bug. It is also the JSI-backed implementation, so the
// conversions below are cheaper than the polyfilled global.
import { Buffer } from '@craftzdog/react-native-buffer';
import { noisePureJsCrypto } from '@optimystic/db-p2p';
import type { NoiseCryptoInterface } from '@optimystic/db-p2p';

/**
 * How much of the interface to replace. The app passes the result of
 * `buildNoiseCrypto` as `CadreNodeConfig.network.noiseCrypto`, which cadre-core reads
 * only when it builds the node, so changing modes means rebuilding the node.
 */
export type NoiseCryptoMode = 'off' | 'symmetric' | 'full';

/**
 * Where the switch rests by default.
 *
 * `symmetric` because it is the measured win — sha256 and chacha are the
 * per-frame costs — while leaving the asymmetric path on the pure-JS code that
 * has been exercised all along. Move to `full` once `symmetric` has proven
 * itself on a device, and to `off` to reproduce the connection-monitor behaviour
 * without reinstalling anything.
 */
export const DEFAULT_NOISE_CRYPTO_MODE: NoiseCryptoMode = 'symmetric';

const CHACHA = 'chacha20-poly1305';
const TAG_BYTES = 16;

/**
 * DER wrappers for raw X25519 keys, copied from noise's node implementation.
 * Node's `createPrivateKey`/`createPublicKey` take structured keys, while Noise
 * carries raw 32-byte values, so each conversion adds or strips a fixed prefix.
 */
const PKCS8_PREFIX = Buffer.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);
const X25519_PREFIX = Buffer.from([
	0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
]);

/**
 * Noise passes either a `Uint8Array` or a `Uint8ArrayList` (a rope of chunks).
 * The native calls want one contiguous buffer, and `subarray()` is the list's own
 * way of producing it without us reaching into its internals.
 */
function flatten(data: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
	return data instanceof Uint8Array ? data : data.subarray();
}

/**
 * quick-crypto's signatures are typed against Node's `Buffer`, which is a
 * `Uint8Array` subclass. `Buffer.from(view)` here is a VIEW, not a copy — same
 * backing memory, correct offset and length — so this satisfies the types without
 * paying for the bytes twice on a path that runs thousands of times per sync.
 */
function asBuffer(data: Uint8Array): Buffer {
	// `data.buffer` is typed `ArrayBufferLike`, which admits SharedArrayBuffer;
	// nothing here ever produces one, and the view form avoids copying the bytes.
	return Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
}

/** The subset that dominates per-frame cost: one hash and one cipher per frame. */
const symmetric = {
	hashSHA256(data: Uint8Array | { subarray(): Uint8Array }): Uint8Array {
		return new Uint8Array(createHash('sha256').update(flatten(data)).digest());
	},

	chaCha20Poly1305Encrypt(
		plaintext: Uint8Array | { subarray(): Uint8Array },
		nonce: Uint8Array,
		ad: Uint8Array,
		k: Uint8Array,
	): Uint8Array {
		const text = flatten(plaintext);
		const cipher = createCipheriv(CHACHA, k, nonce, { authTagLength: TAG_BYTES });
		cipher.setAAD(asBuffer(ad), { plaintextLength: text.byteLength });
		const updated = cipher.update(asBuffer(text));
		const final = cipher.final();
		// Noise expects ciphertext and tag concatenated, in that order.
		return new Uint8Array(Buffer.concat([updated, final, cipher.getAuthTag()]) as unknown as Uint8Array);
	},

	chaCha20Poly1305Decrypt(
		ciphertext: Uint8Array | { subarray(): Uint8Array },
		nonce: Uint8Array,
		ad: Uint8Array,
		k: Uint8Array,
	): Uint8Array {
		const buf = flatten(ciphertext);
		// The tag is the trailing 16 bytes, not a separate argument.
		const text = buf.subarray(0, buf.length - TAG_BYTES);
		const tag = buf.subarray(buf.length - TAG_BYTES);
		const decipher = createDecipheriv(CHACHA, k, nonce, { authTagLength: TAG_BYTES });
		decipher.setAAD(asBuffer(ad), { plaintextLength: text.byteLength });
		decipher.setAuthTag(asBuffer(tag));
		const out = decipher.update(asBuffer(text));
		const final = decipher.final();
		return new Uint8Array(final.byteLength > 0 ? Buffer.concat([out, final]) : out);
	},
};

/**
 * The handshake's asymmetric half: a few calls per handshake rather than one per frame,
 * but ~58 ms per shared secret on an S7 (the table above).
 */
const asymmetric = {
	generateX25519KeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
		// DER encodings are requested below, so both halves come back as Buffers.
		// quick-crypto types the return as a union over every encoding option, so the
		// narrowing is ours to state — and it is checked at runtime below.
		const { publicKey, privateKey } = generateKeyPairSync('x25519', {
			publicKeyEncoding: { type: 'spki', format: 'der' },
			privateKeyEncoding: { type: 'pkcs8', format: 'der' },
		}) as unknown as { publicKey: Buffer; privateKey: Buffer };
		if (!(publicKey instanceof Uint8Array) || !(privateKey instanceof Uint8Array)) {
			throw new Error('x25519 keypair did not come back as DER buffers');
		}
		return {
			publicKey: new Uint8Array(publicKey.subarray(X25519_PREFIX.length)),
			privateKey: new Uint8Array(privateKey.subarray(PKCS8_PREFIX.length)),
		};
	},

	generateX25519KeyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; privateKey: Uint8Array } {
		const priv = createPrivateKey({
			key: Buffer.concat([PKCS8_PREFIX, asBuffer(seed)]),
			type: 'pkcs8',
			format: 'der',
		});
		const exported = createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer;
		const publicKey = exported.subarray(X25519_PREFIX.length);
		// The seed IS the private key for X25519; noise's own implementation returns
		// it unchanged rather than re-exporting it.
		return { publicKey: new Uint8Array(publicKey), privateKey: seed };
	},

	generateX25519SharedKey(
		privateKey: Uint8Array | { subarray(): Uint8Array },
		publicKey: Uint8Array | { subarray(): Uint8Array },
	): Uint8Array {
		const pub = Buffer.concat([X25519_PREFIX, asBuffer(flatten(publicKey))]);
		const priv = Buffer.concat([PKCS8_PREFIX, asBuffer(flatten(privateKey))]);
		// `diffieHellman` is typed `void | Buffer` because it also has a callback
		// form; the synchronous call always returns the secret. Checked rather than
		// asserted — a silent `undefined` here would surface as a handshake that
		// fails for no visible reason.
		const secret = diffieHellman({
			publicKey: createPublicKey({ key: pub, type: 'spki', format: 'der' }),
			privateKey: createPrivateKey({ key: priv, type: 'pkcs8', format: 'der' }),
		});
		if (secret == null) throw new Error('x25519 diffieHellman returned no secret');
		return new Uint8Array(secret as unknown as Uint8Array);
	},
};

/**
 * Build the implementation for a mode.
 *
 * Always spreads `noisePureJsCrypto` first, so anything not overridden — `getHKDF`
 * in particular — keeps working. That is the pattern optimystic's own docs
 * recommend, and it means a gap here degrades to "slow" rather than "broken".
 */
export function buildNoiseCrypto(mode: NoiseCryptoMode): NoiseCryptoInterface | undefined {
	if (mode === 'off') return undefined;
	if (mode === 'symmetric') return { ...noisePureJsCrypto, ...symmetric };
	return { ...noisePureJsCrypto, ...symmetric, ...asymmetric };
}
