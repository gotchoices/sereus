/**
 * The package stays self-contained: its sources import cadre-core, the multiaddr parser and
 * their own files, nothing else (no UI framework, no platform module, no app). The stack-free
 * entry point (everything outside `src/sereus/`) does not import cadre-core at all, so a screen
 * or a mock can load it without the stack.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOWED = [/^\.\.?\//, /^@serfab\/cadre-core(\/edge-node)?$/, /^@multiformats\/multiaddr$/];

function files(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
	});
}

function imports(file: string): string[] {
	return [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+'([^']+)'/g)].map(m => m[1]);
}

describe('standalone', () => {
	it('imports nothing but cadre-core, the multiaddr parser and its own files', () => {
		const offenders = files(SRC).flatMap(file =>
			imports(file).filter(spec => !ALLOWED.some(rule => rule.test(spec))).map(spec => `${relative(SRC, file)}: ${spec}`));
		expect(offenders).toEqual([]);
	});

	it('keeps cadre-core out of the stack-free entry point', () => {
		const offenders = files(SRC)
			.filter(file => !relative(SRC, file).startsWith('sereus'))
			.flatMap(file => imports(file).filter(spec => spec.startsWith('@serfab/')).map(spec => `${relative(SRC, file)}: ${spec}`));
		expect(offenders).toEqual([]);
	});
});
