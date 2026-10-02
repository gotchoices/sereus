/**
 * Guards the three rules of the resolver `metro/index.cjs` installs. A break in any of
 * them still bundles and shows up only on a phone: a Node key-generation variant that
 * throws on first use, or a second copy of a native module.
 *
 * The resolver is driven directly, over a fake upstream `resolveRequest` that records what
 * it was asked and returns a canned resolution. The sereus-chat cases instead run Metro's
 * own resolver, because what they check is which file Metro picks under that app's
 * condition list; `metro-resolver` is a dev dependency pinned to the release the reference
 * app's Metro runs. The packages both read sit in a fixture tree built in a temporary
 * directory, because `node_modules` is git-ignored. The tree holds no links, so removing it
 * recursively is safe.
 *
 * NOTE: nothing ties the `metro-resolver` pin (0.82.5, Expo 53's Metro) to the reference
 * app; if an Expo upgrade moves the app's Metro, move the pin with it, or these cases check
 * a resolver no app runs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type CadreMetro = typeof import('../../metro/index.cjs');
type MetroConfig = Parameters<CadreMetro['withCadreMetro']>[0];
type ResolveRequest = NonNullable<MetroConfig['resolver']['resolveRequest']>;

/**
 * The two metro-resolver entry points the sereus-chat cases call. Typed here because the
 * published typings are out of date: they declare `assetExts` an array, while the resolver
 * calls `assetExts.has()`.
 */
interface MetroResolver {
	resolve(context: object, moduleName: string, platform: string | null): { type: string; filePath?: string };
	createDefaultContext(context: object, dependency: undefined): object;
}

const localRequire = createRequire(import.meta.url);
const { withCadreMetro } = localRequire('../../metro/index.cjs') as CadreMetro;
const metroResolver: MetroResolver = {
	resolve: (localRequire('metro-resolver') as Pick<MetroResolver, 'resolve'>).resolve,
	createDefaultContext: localRequire('metro-resolver/src/createDefaultContext') as MetroResolver['createDefaultContext'],
};

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
	writeJson(join(projectRoot, 'package.json'), { name: 'app' });

	// The real package's shape: `exports` with an `import` condition only, and a `browser`
	// map keyed by the files those exports point at.
	const libp2pCrypto = join(appModules, '@libp2p', 'crypto');
	writeJson(join(libp2pCrypto, 'package.json'), {
		name: '@libp2p/crypto',
		type: 'module',
		exports: {
			'./hmac': { types: './dist/src/hmac/index.d.ts', import: './dist/src/hmac/index.js' },
		},
		browser: {
			'./dist/src/keys/ed25519/index.js': './dist/src/keys/ed25519/index.browser.js',
			'./dist/src/hmac/index.js': './dist/src/hmac/index.browser.js',
			'./dist/src/ciphers/aes-gcm.js': false,
		},
	});
	writeFile(join(libp2pCrypto, 'dist', 'src', 'hmac', 'index.js'), 'export {};\n');
	writeFile(join(libp2pCrypto, 'dist', 'src', 'hmac', 'index.browser.js'), 'export {};\n');

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
		const aesGcm = join(cryptoDir, 'dist', 'src', 'ciphers', 'aes-gcm.js');

		expect(cadreResolver({ type: 'sourceFile', filePath: ed25519 }).resolve('./keys/ed25519/index.js', outsideImporter))
			.toEqual({ type: 'sourceFile', filePath: join(cryptoDir, 'dist', 'src', 'keys', 'ed25519', 'index.browser.js') });
		expect(cadreResolver({ type: 'sourceFile', filePath: aesGcm }).resolve('./ciphers/aes-gcm.js', outsideImporter))
			.toEqual({ type: 'sourceFile', filePath: aesGcm });
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

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Metro's `fileSystemLookup`: whether a path exists, as a file or a directory, and where it really is. */
function lookupPath(path: string) {
	const stats = statSync(path, { throwIfNoEntry: false });
	return stats == null
		? { exists: false as const }
		: { exists: true as const, type: stats.isDirectory() ? 'd' as const : 'f' as const, realPath: realpathSync.native(path) };
}

/**
 * Metro's `getPackageForModule`: the nearest `package.json` above `modulePath`, searching no
 * higher than the nearest `node_modules` directory (Metro's own lookup stops there too) or
 * the fixture root.
 */
function closestPackage(modulePath: string) {
	for (let dir = dirname(modulePath); dir.startsWith(fixtureRoot) && basename(dir) !== 'node_modules'; dir = dirname(dir)) {
		const packageJsonPath = join(dir, 'package.json');
		if (existsSync(packageJsonPath)) {
			return { rootPath: dir, packageJson: readJson(packageJsonPath), packageRelativePath: relative(dir, modulePath) };
		}
	}
	return null;
}

/**
 * The file Metro's own resolver picks for `moduleName` in an Android build of an app with
 * `resolver`, over the fixture tree. The context carries the fields Metro's
 * `ModuleResolution` passes, with React Native's default main fields. A warning fails the
 * resolution rather than letting Metro fall back quietly, since a fallback would mean the
 * fixture no longer exercises the path it was built for.
 */
function metroResolve(resolver: MetroConfig['resolver'], moduleName: string, originModulePath: string): string | undefined {
	const context = metroResolver.createDefaultContext({
		allowHaste: false,
		assetExts: new Set<string>(),
		customResolverOptions: {},
		disableHierarchicalLookup: false,
		doesFileExist: (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
		extraNodeModules: resolver.extraNodeModules,
		fileSystemLookup: lookupPath,
		getPackage: readJson,
		getPackageForModule: closestPackage,
		mainFields: ['react-native', 'browser', 'main'],
		nodeModulesPaths: resolver.nodeModulesPaths ?? [],
		originModulePath,
		preferNativePlatform: true,
		resolveAsset: () => null,
		resolveHasteModule: () => undefined,
		resolveHastePackage: () => undefined,
		resolveRequest: resolver.resolveRequest,
		sourceExts: ['js', 'json'],
		unstable_conditionNames: resolver.unstable_conditionNames,
		unstable_conditionsByPlatform: resolver.unstable_conditionsByPlatform,
		unstable_enablePackageExports: resolver.unstable_enablePackageExports,
		unstable_logWarning: (message: string) => {
			throw new Error(`Metro warned: ${message}`);
		},
	}, undefined);
	return metroResolver.resolve(context, moduleName, 'android').filePath;
}

/**
 * sereus-chat's resolver settings (`apps/mobile/metro.config.js`): package exports on, and
 * `import` ahead of `require` in every condition list, for its ESM-only libp2p packages.
 */
function sereusChatConfig(): MetroConfig {
	const platformConditions = ['react-native', 'import', 'require', 'default'];
	return {
		resolver: {
			unstable_enablePackageExports: true,
			unstable_conditionNames: ['import', 'require', 'default'],
			unstable_conditionsByPlatform: { ios: platformConditions, android: platformConditions },
		},
	};
}

// Each case first resolves without the kit, showing that these settings alone pick the file
// the rule exists to replace; otherwise the case could pass without the rule doing anything.
describe('withCadreMetro under sereus-chat\'s resolver settings, through Metro\'s resolver', () => {
	const kitResolver = () => withCadreMetro(sereusChatConfig(), { projectRoot }).resolver;
	const appFile = () => join(projectRoot, 'index.js');

	it('still resolves an @babel/runtime helper to its CommonJS file', () => {
		const helper = '@babel/runtime/helpers/interopRequireDefault';
		const helpers = join(projectRoot, 'node_modules', '@babel', 'runtime', 'helpers');

		expect(metroResolve(sereusChatConfig().resolver, helper, appFile())).toBe(join(helpers, 'esm', 'interopRequireDefault.js'));
		expect(metroResolve(kitResolver(), helper, appFile())).toBe(join(helpers, 'interopRequireDefault.js'));
	});

	it('still swaps an @libp2p/crypto file reached through `exports` for its browser variant', () => {
		const hmac = join(projectRoot, 'node_modules', '@libp2p', 'crypto', 'dist', 'src', 'hmac');

		expect(metroResolve(sereusChatConfig().resolver, '@libp2p/crypto/hmac', appFile())).toBe(join(hmac, 'index.js'));
		expect(metroResolve(kitResolver(), '@libp2p/crypto/hmac', appFile())).toBe(join(hmac, 'index.browser.js'));
	});
});
