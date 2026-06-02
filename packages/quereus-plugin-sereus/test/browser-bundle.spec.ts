/**
 * Smoke tests for the prebuilt browser bundle.
 *
 * These do NOT exercise networking — they check that the artifact:
 *  - exists (rebuild on demand if missing),
 *  - parses cleanly as ESM,
 *  - does not statically reference Node-only modules or `@libp2p/tcp`,
 *  - stays under the soft size caps.
 *
 * Catches the regressions you'd otherwise only see by loading the bundle into
 * Quoomb-web and watching the worker throw on a missing global.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseModule } from 'acorn';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const bundlePath = resolve(pkgRoot, 'dist', 'plugin-browser.js');

// Soft caps. Bump deliberately if a justified dep increase pushes us over.
const MAX_RAW_BYTES = 8 * 1024 * 1024;       // 8 MiB
const MAX_GZIPPED_BYTES = 3 * 1024 * 1024;   // 3 MiB

const FORBIDDEN_BARE_IMPORTS = [
	'@libp2p/tcp',
	'node:fs',
	'node:net',
	'node:dgram',
	'node:os',
	'node:child_process',
	'node:dns',
	'node:tls',
	'node:cluster',
];

let bundle: string;

beforeAll(() => {
	if (!existsSync(bundlePath)) {
		// Build on demand so `yarn test` works in a fresh checkout without
		// requiring the caller to remember `yarn build` first.
		const r = spawnSync('node', ['scripts/build-browser.mjs'], {
			cwd: pkgRoot,
			stdio: 'inherit',
		});
		if (r.status !== 0) {
			throw new Error('build-browser.mjs failed');
		}
	}
	bundle = readFileSync(bundlePath, 'utf8');
});

describe('browser bundle artifact', () => {
	it('parses as ESM', () => {
		expect(() => parseModule(bundle, { ecmaVersion: 2022, sourceType: 'module' })).not.toThrow();
	});

	it('does not statically reference forbidden Node-only modules', () => {
		for (const spec of FORBIDDEN_BARE_IMPORTS) {
			// Match `from "spec"` / `from 'spec'` / `import("spec")`. Allow filenames
			// or comments that mention the literal (they show up because esbuild's
			// section markers reference the original module path).
			const fromRe = new RegExp(`from\\s*['"]${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`);
			const importRe = new RegExp(`import\\s*\\(\\s*['"]${spec.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]`);
			expect(fromRe.test(bundle), `bundle contains \`from "${spec}"\``).toBe(false);
			expect(importRe.test(bundle), `bundle contains \`import("${spec}")\``).toBe(false);
		}
	});

	it('stays under soft size caps', () => {
		const raw = statSync(bundlePath).size;
		const gz = gzipSync(readFileSync(bundlePath)).length;
		// Log so reviewers see the trend.
		 
		console.log(`plugin-browser.js: ${(raw / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzipped`);
		expect(raw, `${raw} bytes exceeds ${MAX_RAW_BYTES}`).toBeLessThan(MAX_RAW_BYTES);
		expect(gz, `${gz} bytes exceeds ${MAX_GZIPPED_BYTES}`).toBeLessThan(MAX_GZIPPED_BYTES);
	});

	it('emits a source map alongside', () => {
		expect(existsSync(`${bundlePath}.map`)).toBe(true);
	});
});
