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

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
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
 * Metro's `getPackageForModule`, bounded by `bound`: the nearest `package.json` above
 * `modulePath`, searching no higher than the nearest `node_modules` directory (Metro's own
 * lookup stops there too) or `bound`.
 */
function closestPackageUnder(bound: string) {
	return (modulePath: string) => {
		for (let dir = dirname(modulePath); dir.startsWith(bound) && basename(dir) !== 'node_modules'; dir = dirname(dir)) {
			const packageJsonPath = join(dir, 'package.json');
			if (existsSync(packageJsonPath)) {
				return { rootPath: dir, packageJson: readJson(packageJsonPath), packageRelativePath: relative(dir, modulePath) };
			}
		}
		return null;
	};
}

/**
 * The file Metro's own resolver picks for `moduleName` in an Android build of an app with
 * `resolver`, over the fixture tree. The context carries the fields Metro's
 * `ModuleResolution` passes, with React Native's default main fields. A warning fails the
 * resolution rather than letting Metro fall back quietly, since a fallback would mean the
 * fixture no longer exercises the path it was built for.
 *
 * `overrides` replaces context fields for a case whose fixture is not the shared tree, or
 * whose point is how Metro reads the filesystem.
 */
function metroResolve(
	resolver: MetroConfig['resolver'],
	moduleName: string,
	originModulePath: string,
	overrides: Record<string, unknown> = {},
): string | undefined {
	const context = metroResolver.createDefaultContext({
		allowHaste: false,
		assetExts: new Set<string>(),
		customResolverOptions: {},
		disableHierarchicalLookup: false,
		doesFileExist: (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true,
		extraNodeModules: resolver.extraNodeModules,
		fileSystemLookup: lookupPath,
		getPackage: readJson,
		getPackageForModule: closestPackageUnder(fixtureRoot),
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
		...overrides,
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

/**
 * The watched roots. Metro reads a symlink's target as a string and looks that string up in
 * the file map it crawled from these, so a root spelled differently from the directory on
 * disk hides every package linked under it. What provoked this: on Windows the apps name
 * `../../../optimystic` while the checkout is `C:\Projects\Optimystic`, and the Android
 * export failed with "Unable to resolve module @optimystic/db-core" from cadre-core.
 *
 * Checked through a link rather than through letter case, which only differs on a
 * case-insensitive filesystem. The link is a junction on Windows, which needs no
 * privileges, and a plain symlink elsewhere; it lives in its own temporary tree so the
 * shared fixture stays link-free.
 */
describe('withCadreMetro linked roots', () => {
	let linkRoot: string;

	beforeAll(() => {
		linkRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'cadre-metro-link-')));
		mkdirSync(join(linkRoot, 'sibling', 'node_modules'), { recursive: true });
		symlinkSync(join(linkRoot, 'sibling'), join(linkRoot, 'alias'), 'junction');
	});

	afterAll(() => {
		rmSync(linkRoot, { recursive: true, force: true });
	});

	function rootsOf(linkedRoots: readonly string[]) {
		const config = withCadreMetro<MetroConfig>({ resolver: {} }, { projectRoot, linkedRoots });
		return { watchFolders: config.watchFolders, nodeModulesPaths: config.resolver.nodeModulesPaths };
	}

	it('watches the directory a root resolves to, not the path the app named', () => {
		const sibling = join(linkRoot, 'sibling');

		expect(rootsOf([join(linkRoot, 'alias')])).toEqual({
			watchFolders: [sibling],
			nodeModulesPaths: [join(projectRoot, 'node_modules'), join(sibling, 'node_modules')],
		});
	});

	it('keeps a root that is not there, which Metro ignores', () => {
		const absent = join(linkRoot, 'no-such-checkout');

		expect(rootsOf([absent]).watchFolders).toEqual([absent]);
	});
});

/**
 * Metro's `fileSystemLookup` over a file map crawled from `watchFolders`, which is as much
 * of that map as the cases below rest on: traversal sees only what the crawl reached, and a
 * link is followed by *restarting* traversal at the target string the link stores. So a link
 * whose target names a path outside every watched root is a dead end, however the
 * filesystem would resolve it.
 *
 * `lookupPath` above is the same question asked of the filesystem instead, which is what
 * every other case wants.
 */
function lookupPathLiterally(watchFolders: readonly string[]) {
	const crawled = (path: string) => watchFolders.some((root) => path === root || path.startsWith(root + sep));
	const lookup = (path: string): ReturnType<typeof lookupPath> => {
		if (!crawled(path)) {
			return { exists: false as const };
		}
		const throughLink = firstLinkSubstituted(path);
		if (throughLink != null) {
			return lookup(throughLink);
		}
		// No link is left along it, so the filesystem and the file map agree from here.
		const stats = statSync(path, { throwIfNoEntry: false });
		return stats == null
			? { exists: false as const }
			: { exists: true as const, type: stats.isDirectory() ? 'd' as const : 'f' as const, realPath: path };
	};
	return lookup;
}

/**
 * `path` with its first link replaced by the target string that link stores, or `undefined`
 * when no segment of it is a link. The stored target need not be how the filesystem spells
 * the directory it reaches, which is the whole point.
 *
 * Starts at the second segment: the first is a drive letter or the empty string before a
 * leading separator, and `lstat('C:')` answers about the working directory.
 */
function firstLinkSubstituted(path: string): string | undefined {
	const segments = path.split(sep);
	for (let i = 2; i <= segments.length; i++) {
		const prefix = segments.slice(0, i).join(sep);
		if (lstatSync(prefix, { throwIfNoEntry: false })?.isSymbolicLink() === true) {
			const target = readlinkSync(prefix);
			return [isAbsolute(target) ? target : join(dirname(prefix), target), ...segments.slice(i)].join(sep);
		}
	}
	return undefined;
}

/**
 * A link whose stored target names a path no crawl of the watched roots reached. Metro
 * restarts its lookup at that string, so such a link is a dead end even though the directory
 * it reaches is inside a watched root, and the export fails with "Unable to resolve module
 * <name>" naming an importer that is fine.
 *
 * Why it happens: a package manager writes the path a link was *configured* with, not the
 * one the disk spells. The optimystic checkout portals the FRET DHT as
 * `portal:../Fret/packages/fret`, so its junctions read `C:\Projects\Fret\...` while the
 * directory is `C:\Projects\fret`, and the reference app's Android export could not resolve
 * `p2p-fret` from `@optimystic/db-p2p`. That spelling is the sibling checkout's own
 * configuration and read-only from here (`tickets/rules/sibling-repos.md`).
 *
 * Reproduced by a link through an unwatched directory rather than by letter case, which only
 * differs on a case-insensitive filesystem: `importer/node_modules/dep` stores
 * `<root>/alias/dep`, and `alias` sits outside both watched roots, so the crawl only ever
 * saw the package as `<root>/real/dep` — which is also what the filesystem spells for the
 * link, and so what the kit resolves it to.
 */
describe('withCadreMetro past a link whose target no crawl reached', () => {
	let spellingRoot: string;
	let importer: string;
	let packageMain: string;
	let roots: string[];

	beforeAll(() => {
		spellingRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'cadre-metro-spelling-')));
		const packageDir = join(spellingRoot, 'real', 'dep');
		writeJson(join(packageDir, 'package.json'), { name: 'dep', main: 'index.js' });
		packageMain = join(packageDir, 'index.js');
		writeFile(packageMain, 'export {};\n');

		importer = join(spellingRoot, 'importer', 'index.js');
		writeFile(importer, 'export {};\n');
		mkdirSync(join(spellingRoot, 'importer', 'node_modules'), { recursive: true });
		symlinkSync(join(spellingRoot, 'real'), join(spellingRoot, 'alias'), 'junction');
		symlinkSync(join(spellingRoot, 'alias', 'dep'), join(spellingRoot, 'importer', 'node_modules', 'dep'), 'junction');

		roots = [join(spellingRoot, 'real'), join(spellingRoot, 'importer')];
	});

	afterAll(() => {
		rmSync(spellingRoot, { recursive: true, force: true });
	});

	function resolveDep(resolver: MetroConfig['resolver']) {
		return metroResolve(resolver, 'dep', importer, {
			fileSystemLookup: lookupPathLiterally(roots),
			getPackageForModule: closestPackageUnder(spellingRoot),
		});
	}

	it('resolves the package to the directory the filesystem spells, which Metro alone cannot reach', () => {
		const kit = withCadreMetro<MetroConfig>({ resolver: {} }, { projectRoot, linkedRoots: roots }).resolver;

		expect(() => resolveDep({ ...kit, resolveRequest: null })).toThrow(/Module does not exist/);
		expect(resolveDep(kit)).toBe(packageMain);
	});

	it('leaves a module that is genuinely absent to Metro\'s own error', () => {
		const kit = withCadreMetro<MetroConfig>({ resolver: {} }, { projectRoot, linkedRoots: roots }).resolver;

		expect(() => metroResolve(kit, 'no-such-package', importer, {
			fileSystemLookup: lookupPathLiterally(roots),
			getPackageForModule: closestPackageUnder(spellingRoot),
		})).toThrow(/Module does not exist/);
	});
});
