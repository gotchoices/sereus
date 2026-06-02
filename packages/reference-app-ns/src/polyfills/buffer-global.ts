/**
 * `globalThis.Buffer` for the NativeScript runtime.
 *
 * Some libp2p transitive deps reach for the Node `Buffer` global. The webpack
 * config aliases the `buffer` *module* (resolve.fallback), but does not register
 * a global — mirror reference-app-web/src/polyfills.ts and set it here. Must be
 * imported before any library code.
 */

import { Buffer } from 'buffer';
import { markPolyfilled } from './registry';

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };

if (typeof g.Buffer === 'undefined') {
	g.Buffer = Buffer;
	markPolyfilled('Buffer');
}
