import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const empty = resolve(here, 'src/shims/empty.ts');

// Browsers already provide crypto.subtle, EventTarget, ReadableStream,
// structuredClone, Promise.withResolvers, AbortSignal.throwIfAborted, and
// TextEncoder/Decoder — the polyfill surface is dramatically smaller than RN.
// Only Node built-ins consumed transitively by libp2p need aliasing.
//
// node:crypto / crypto are deliberately NOT aliased — anything reaching for
// them in a browser bundle is a real bug we want surfaced, not papered over.
export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			'node:os': empty,
			'node:net': empty,
			'node:tls': empty,
			'node:stream': 'readable-stream',
			'node:buffer': 'buffer',
			os: empty,
			net: empty,
			tls: empty,
			stream: 'readable-stream',
			buffer: 'buffer',
		},
		// `@chainsafe/libp2p-gossipsub@14.x` calls `multiaddr.tuples()`, which
		// only exists on `@multiformats/multiaddr` v12 (kept around as a
		// backward-compat shim). Several optimystic transitive deps pull in
		// v13 where `tuples()` was deleted in favour of `getComponents()`, and
		// the registrar's `_onPeerIdentify` hands the gossipsub topology a v13
		// multiaddr — which then explodes inside its `multiaddrToIPStr` helper
		// and throws out of the topology loop *before* the circuit-relay HOP
		// topology gets a chance to fire its onConnect. Without that fire, no
		// reservation is requested and the browser peer is undialable.
		//
		// Deduping every consumer to the v12 multiaddr instance (which exposes
		// both `tuples()` and `getComponents()`) restores compatibility until
		// gossipsub upstream catches up.
		dedupe: ['@multiformats/multiaddr'],
	},
	define: {
		global: 'globalThis',
	},
	optimizeDeps: {
		include: ['buffer'],
	},
});
