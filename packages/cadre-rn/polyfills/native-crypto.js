// `@serfab/cadre-rn/polyfills/native-crypto`: native Ed25519 and SHA-256/512 behind
// `crypto.subtle`, through react-native-quick-crypto, from boot. The app imports it right
// after `@serfab/cadre-rn/polyfills` and before any libp2p or app code.
//
// Why at boot. @libp2p/crypto decides once, when its Ed25519 module is evaluated, whether to
// sign through WebCrypto or pure-JS @noble/curves (`src/native-ed25519.ts`), so native
// Ed25519 has to exist before anything imports libp2p. The digest does not have that
// constraint -- multiformats reads `crypto.subtle.digest` on every call, which is why
// `@serfab/cadre-rn/noise-crypto` can install it on load -- but installing it here too makes
// the hashing native from the first block rather than from the `noise-crypto` import on.
//
// After `/polyfills`, not before: requiring quick-crypto loads its readable-stream, which
// reads globals (Symbol.asyncIterator and others) those polyfills install.
//
// NOTE: the app must list react-native-quick-crypto (and its react-native-nitro-modules and
// react-native-quick-base64) as its own dependencies and rebuild its native app; quick-crypto
// needs React Native's new architecture. Measured on a Galaxy S7 by sereus-chat, which carried
// this in its own polyfills first: Ed25519 verify 169 ms in JS against 0.72 ms native.
import * as quickCrypto from 'react-native-quick-crypto';
import { installNativeDigest } from '../dist/native-digest.js';
import { installNativeEd25519 } from '../dist/native-ed25519.js';
import { markPolyfilled } from './registry';

const qc = quickCrypto.default ?? quickCrypto;

const ed25519 = installNativeEd25519(qc.subtle);
if (ed25519 === 'installed') markPolyfilled('crypto.subtle.importKey');
else if (ed25519 === 'unavailable') console.warn('[cadre-rn] native Ed25519 unavailable: libp2p signs and verifies in pure JS');

const digest = installNativeDigest(algorithm => qc.createHash(algorithm));
if (digest === 'check-failed') console.warn('[cadre-rn] native digest failed its check: block hashing stays in pure JS');
