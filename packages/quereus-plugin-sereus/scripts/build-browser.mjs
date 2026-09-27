#!/usr/bin/env node
/**
 * Build the browser/worker bundle for `@serfab/quereus-plugin-sereus`.
 *
 * Produces a single ESM artifact at `dist/plugin-browser.js` consumable by
 * Quereus plugin-loader via `dynamicLoadModule(url, ...)`. The corresponding
 * declaration file (`dist/plugin-browser.d.ts`) is emitted by the preceding
 * `tsc -p tsconfig.build.json` step — this script only overwrites `.js`/`.js.map`.
 */

import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

const entry = join(pkgRoot, 'src', 'plugin-browser.ts');
const outfile = join(pkgRoot, 'dist', 'plugin-browser.js');

await build({
	entryPoints: [entry],
	outfile,
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	// NOTE: the map is ~12.8 MB, over six times the minified bundle, and `package.json`
	// `files` publishes `dist`, so every install of this package downloads it. Kept because
	// it is what keeps the minified bundle debuggable; revisit if install size becomes a
	// complaint — dropping `sourcesContent` or excluding the map are the levers.
	sourcemap: true,
	minify: true,
	// `react-native` is the only export condition `@optimystic/db-p2p` exposes
	// for its TCP-free entry. Setting it here makes transitive imports of the
	// main `@optimystic/db-p2p` specifier (from `@optimystic/quereus-plugin-optimystic`,
	// for example) resolve to `dist/src/rn.js` — keeping `@libp2p/tcp` and the
	// rest of the Node-only `libp2p-node.ts` out of the bundle.
	conditions: ['react-native'],
	// Hosts (Quoomb-web's worker) already have their own `@quereus/quereus`
	// instance. We do not import it at runtime — see `connect-browser.ts` —
	// but mark it external defensively in case a transitive import path
	// reaches it. The worker will not see this import because the resolved
	// module graph never references it.
	external: ['@quereus/quereus'],
	define: {
		'process.env.NODE_ENV': '"production"',
	},
	banner: {
		js: `/* ${pkg.name} ${pkg.version} — browser bundle */`,
	},
	logLevel: 'info',
});

const buf = readFileSync(outfile);
const gz = gzipSync(buf);
const fmt = (n) => `${(n / 1024).toFixed(1)} KiB`;
console.log(`plugin-browser.js: ${fmt(buf.length)} raw, ${fmt(gz.length)} gzipped`);
