/**
 * Guards the three rules of the resolver `metro/index.cjs` installs. A break in any of
 * them still bundles and shows up only on a phone: a Node key-generation variant that
 * throws on first use, or a second copy of a native module.
 *
 * The resolver is driven directly, over a fake upstream `resolveRequest` that records what
 * it was asked and returns a canned resolution. The packages the helper reads sit in a
 * fixture tree built in a temporary directory, because `node_modules` is git-ignored. The
 * tree holds no links, so removing it recursively is safe.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type CadreMetro = typeof import('../../metro/index.cjs');
type ResolveRequest = NonNullable<Parameters<CadreMetro['withCadreMetro']>[0]['resolver']['resolveRequest']>;

const { withCadreMetro } = createRequire(import.meta.url)('../../metro/index.cjs') as CadreMetro;

let fixtureRoot: string;
let projectRoot: string;
/** A file outside the app, as the kit's own files are in this monorepo. */
let outsideImporter: string;

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
	writeFile(path, JSON.stringify(value));
}

beforeAll(() => {
	fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'cadre-metro-')));
	projectRoot = join(fixtureRoot, 'app');
	outsideImporter = join(fixtureRoot, 'kit', 'polyfills', 'webrtc.js');
	const appModules = join(projectRoot, 'node_modules');

	writeJson(join(appModules, '@libp2p', 'crypto', 'package.json'), {
		name: '@libp2p/crypto',
		browser: {
			'./dist/src/keys/ed25519/index.js': './dist/src/keys/ed25519/index.browser.js',
			'./dist/src/hmac/index.js': false,
		},
	});

	const babelRuntime = join(appModules, '@babel', 'runtime');
	writeJson(join(babelRuntime, 'package.json'), {
		name: '@babel/runtime',
		exports: {
			'./helpers/interopRequireDefault': [
				{
					node: './helpers/interopRequireDefault.js',
					import: './helpers/esm/interopRequireDefault.js',
					default: './helpers/interopRequireDefault.js',
				},
				'./helpers/interopRequireDefault.js',
			],
		},
	});
	writeFile(join(babelRuntime, 'helpers', 'interopRequireDefault.js'), 'module.exports = () => undefined;\n');
	writeFile(join(babelRuntime, 'helpers', 'esm', 'interopRequireDefault.js'), 'export default () => undefined;\n');
});

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

interface UpstreamCall {
	originModulePath: string;
	moduleName: string;
}

/** The helper's resolver over a fake upstream that answers every request with `answer`. */
function cadreResolver(answer: { type: 'sourceFile'; filePath: string } | null = null) {
	const calls: UpstreamCall[] = [];
	const upstream: ResolveRequest = (context, moduleName) => {
		calls.push({ originModulePath: context.originModulePath, moduleName });
		return answer;
	};
	const config = withCadreMetro({ resolver: { resolveRequest: upstream } }, { projectRoot });
	const resolveRequest = config.resolver.resolveRequest as ResolveRequest;
	const resolve = (moduleName: string, originModulePath: string) =>
		resolveRequest({ originModulePath }, moduleName, 'android');
	return { resolve, calls };
}

describe('withCadreMetro resolveRequest', () => {
	it('swaps a resolved @libp2p/crypto file for its browser-field variant, ignoring false targets', () => {
		const cryptoDir = join(projectRoot, 'node_modules', '@libp2p', 'crypto');
		const ed25519 = join(cryptoDir, 'dist', 'src', 'keys', 'ed25519', 'index.js');
		const hmac = join(cryptoDir, 'dist', 'src', 'hmac', 'index.js');

		expect(cadreResolver({ type: 'sourceFile', filePath: ed25519 }).resolve('./keys/ed25519/index.js', outsideImporter))
			.toEqual({ type: 'sourceFile', filePath: join(cryptoDir, 'dist', 'src', 'keys', 'ed25519', 'index.browser.js') });
		expect(cadreResolver({ type: 'sourceFile', filePath: hmac }).resolve('./hmac/index.js', outsideImporter))
			.toEqual({ type: 'sourceFile', filePath: hmac });
	});

	it('resolves a kit peer from the app, and leaves other packages to their importer', () => {
		const { resolve, calls } = cadreResolver();

		resolve('react-native', outsideImporter);
		resolve('@libp2p/crypto', outsideImporter);

		expect(dirname(calls[0].originModulePath)).toBe(projectRoot);
		expect(calls[1].originModulePath).toBe(outsideImporter);
	});

	it('resolves an @babel/runtime helper to the CommonJS file of the app\'s copy', () => {
		const { resolve, calls } = cadreResolver();

		expect(resolve('@babel/runtime/helpers/interopRequireDefault', outsideImporter)).toEqual({
			type: 'sourceFile',
			filePath: join(projectRoot, 'node_modules', '@babel', 'runtime', 'helpers', 'interopRequireDefault.js'),
		});
		expect(calls).toEqual([]);
	});
});
