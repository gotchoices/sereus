/*
 * NativeScript-safe replacement for @chainsafe/libp2p-noise's
 * `dist/src/crypto/index.js`.
 *
 * The upstream module's `defaultCrypto` spreads the pure-JS backend but then
 * OVERRIDES X25519 keygen/DH and SHA-256 with `node:crypto` implementations
 * (`crypto.generateKeyPairSync('x25519')`, `createPrivateKey`, `diffieHellman`).
 * The NS V8/JSC `crypto` shim is createHash-only, so the `Noise` constructor's
 * `generateX25519KeyPair()` throws
 * "node_crypto…default.generateKeyPairSync is not a function" — the next Connect
 * failure after the user-agent fix. noise's package `exports` expose no
 * browser/react-native condition for its crypto and db-p2p calls `noise()` with
 * no `crypto` override, so the node backend is otherwise unavoidable here.
 *
 * Mirror the package's own `pureJsCrypto` (the @noble backend in
 * `crypto/js.js`) and bind every name the original module exports to it — a deep
 * re-export of the package's `js.js` is blocked by its `exports` field, so the
 * small noble wrapper table is duplicated here verbatim. Wired up by the
 * `noise-crypto-shim` NormalModuleReplacementPlugin in webpack.config.js.
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

export const pureJsCrypto = {
	hashSHA256(data) {
		return sha256(data.subarray());
	},
	getHKDF(ck, ikm) {
		const prk = extract(sha256, ikm, ck);
		const okm = expand(sha256, prk, undefined, 96);
		return [okm.subarray(0, 32), okm.subarray(32, 64), okm.subarray(64, 96)];
	},
	generateX25519KeyPair() {
		const privateKey = x25519.utils.randomSecretKey();
		return { publicKey: x25519.getPublicKey(privateKey), privateKey };
	},
	generateX25519KeyPairFromSeed(seed) {
		return { publicKey: x25519.getPublicKey(seed), privateKey: seed };
	},
	generateX25519SharedKey(privateKey, publicKey) {
		return x25519.getSharedSecret(privateKey.subarray(), publicKey.subarray());
	},
	chaCha20Poly1305Encrypt(plaintext, nonce, ad, k) {
		return chacha20poly1305(k, nonce, ad).encrypt(plaintext.subarray());
	},
	chaCha20Poly1305Decrypt(ciphertext, nonce, ad, k, dst) {
		return chacha20poly1305(k, nonce, ad).decrypt(ciphertext.subarray(), dst);
	},
};

// The original module exports these distinct backends; on NS they all map to the
// pure-JS one (it implements the full surface each consumer reaches for).
export const nodeCrypto = pureJsCrypto;
export const asCrypto = pureJsCrypto;
export const defaultCrypto = pureJsCrypto;
