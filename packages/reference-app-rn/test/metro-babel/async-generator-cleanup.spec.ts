/**
 * Guards the Babel helper Metro uses to run async generators on Hermes.
 *
 * Hermes has no native async generators, so Metro's Babel transform rewrites every
 * `async function*` onto Babel's `wrapAsyncGenerator` helper. Before 7.29.2 that helper (the
 * copy in `@babel/runtime`, and the one `@babel/core` inlines from `@babel/helpers`) stopped a
 * generator's `finally` at its first `await` once the consumer left the loop early. Quereus's
 * `Database._evalGenerator` releases its execution lock after `await stmt.finalize()` in exactly
 * such a `finally`, and cadre-core's `strandTableCount` returns from its `for await` over
 * `db.eval()` on the first row. On a phone the lock therefore stayed held, and the next write
 * (`StrandDatabase.bootstrapFounder`'s insert) waited forever: founding a strand hung.
 *
 * Node runs async generators natively, so no other spec can see this. This one compiles a probe
 * of that shape with the app's own Metro Babel transformer (`metro.config.js` →
 * `transformer.babelTransformerPath`, which loads `babel-preset-expo`), passing the options Expo
 * CLI sends for an Android Hermes development bundle, and runs the output in Node against the
 * helpers a bundle would use.
 *
 * It is its own Vitest project with no stale-build guard, because it loads no compiled output from
 * other packages: `vitest run --project metro-babel` runs it even while a linked sibling's `dist` is
 * stale. A full `vitest run` still stops at the `node` project's guard before running anything.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformFromAstSync, type types } from '@babel/core';
import { beforeAll, describe, expect, it } from 'vitest';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The fields of the app's Metro config this spec reads. */
interface AppMetroConfig {
	transformer: { babelTransformerPath: string };
	resolver: { nodeModulesPaths: readonly string[] };
}

/**
 * `module` sources import helpers from `@babel/runtime`. Metro compiles `script` sources (such
 * as polyfills) with that import turned off, so `@babel/core` inlines the helper from
 * `@babel/helpers` instead.
 */
type MetroSourceType = 'module' | 'script';

/** Metro's transform options, reduced to the ones Expo's Babel transformer and preset read. */
interface MetroTransformOptions {
	dev: boolean;
	hot: boolean;
	minify: boolean;
	platform: string;
	projectRoot: string;
	type: MetroSourceType;
	unstable_transformProfile: string;
	experimentalImportSupport: boolean;
	hermesParser: boolean;
	customTransformOptions: Record<string, string>;
}

/** Metro's Babel transformer contract, as `@expo/metro-config` implements it. */
interface MetroBabelTransformer {
	transform(args: {
		filename: string;
		src: string;
		options: MetroTransformOptions;
		plugins: readonly unknown[];
	}): { ast: types.File | null };
}

type ModuleRequire = (id: string) => unknown;

interface Lock {
	held: boolean;
}

type ReadFirstRow = (lock: Lock) => Promise<unknown>;

interface EarlyExitOutcome {
	row: unknown;
	held: boolean;
}

/**
 * An `eval`-style generator that takes a lock and releases it in `finally` after an `await`
 * (Quereus `_evalGenerator`), read by a loop that returns on the first row (cadre-core
 * `strandTableCount`). Plain JavaScript, so it can be compiled the way Metro compiles it and also
 * run natively as the control.
 */
const PROBE = `
async function* rows(lock) {
	lock.held = true;
	try {
		yield 1;
		yield 2;
	} finally {
		await Promise.resolve();
		lock.held = false;
	}
}
async function readFirstRow(lock) {
	for await (const row of rows(lock)) {
		return row;
	}
	return 0;
}
`;

const MODULE_PROBE = `${PROBE}export { readFirstRow };\n`;
const SCRIPT_PROBE = `${PROBE}exports.readFirstRow = readFirstRow;\n`;

/** What a spec-conformant engine leaves behind: the first row was read and the lock released. */
const RELEASED: EarlyExitOutcome = { row: 1, held: false };

/** Bounds one probe run, so a hang fails with a message instead of timing out the suite. */
const PROBE_DEADLINE_MS = 5_000;

/** Loading Metro's config and Babel's preset cold takes a few seconds. */
const BABEL_TIMEOUT_MS = 60_000;

/**
 * The options Expo CLI passes to Metro's transformer for an Android development bundle on Hermes:
 * `engine` and `unstable_transformProfile` as `@expo/cli` 0.24 sets them in
 * `build/src/start/server/middleware/metroOptions.js`, `experimentalImportSupport` as the app's
 * Metro `getTransformOptions` returns it.
 *
 * NOTE: copied by hand, not read from Expo. If an Expo upgrade changes how it signals Hermes, the
 * probe can compile differently from the phone's bundle, and the helper-usage assertions only catch
 * lowering that stops altogether; re-check these against that file when upgrading Expo.
 */
function hermesAndroidDevOptions(type: MetroSourceType): MetroTransformOptions {
	return {
		dev: true,
		hot: true,
		minify: false,
		platform: 'android',
		projectRoot: appDir,
		type,
		unstable_transformProfile: 'hermes-stable',
		experimentalImportSupport: false,
		hermesParser: false,
		customTransformOptions: { engine: 'hermes', routerRoot: 'app' },
	};
}

function compileForHermes(transformer: MetroBabelTransformer, type: MetroSourceType, src: string): string {
	const filename = join(appDir, 'test', 'metro-babel', `probe.${type}.js`);
	const { ast } = transformer.transform({ filename, src, options: hermesAndroidDevOptions(type), plugins: [] });
	if (!ast) {
		throw new Error(`Metro's Babel transformer returned no AST for ${filename}`);
	}
	const generated = transformFromAstSync(ast, src, { filename, babelrc: false, configFile: false, code: true });
	if (!generated?.code) {
		throw new Error(`Babel generated no code for ${filename}`);
	}
	return generated.code;
}

/**
 * Development bundles compile with Fast Refresh, whose Babel plugin registers top-level functions
 * through `$RefreshReg$` / `$RefreshSig$`. Metro's module runtime (`metro-runtime`'s `require.js`)
 * defines both as no-ops until the refresh runtime takes over; the probe gets the same no-ops.
 */
function refreshReg(): void {
	// no-op, as in metro-runtime
}

function refreshSig(): <T>(type: T) => T {
	return (type) => type;
}

/** Evaluates compiled CommonJS output with the given `require` and returns its `readFirstRow`. */
function loadProbe(code: string, moduleRequire: ModuleRequire): ReadFirstRow {
	const probeModule: { exports: { readFirstRow?: ReadFirstRow } } = { exports: {} };
	const factory = new Function('require', 'module', 'exports', '$RefreshReg$', '$RefreshSig$', code) as (
		requireFn: ModuleRequire,
		moduleObject: typeof probeModule,
		exportsObject: typeof probeModule.exports,
		refreshRegFn: typeof refreshReg,
		refreshSigFn: typeof refreshSig,
	) => void;
	factory(moduleRequire, probeModule, probeModule.exports, refreshReg, refreshSig);
	const { readFirstRow } = probeModule.exports;
	if (typeof readFirstRow !== 'function') {
		throw new Error('the probe did not export readFirstRow');
	}
	return readFirstRow;
}

async function earlyExit(readFirstRow: ReadFirstRow): Promise<EarlyExitOutcome> {
	const lock: Lock = { held: false };
	const row = await withDeadline(readFirstRow(lock), PROBE_DEADLINE_MS);
	return { row, held: lock.held };
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`the probe did not settle within ${ms} ms`)), ms);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/** For output that must carry its helpers inline: any import means the runtime path was taken. */
function refuseRequire(id: string): never {
	throw new Error(`the probe must not import anything, but it required ${id}`);
}

/**
 * Directories on Metro's `nodeModulesPaths` that hold an `@babel/runtime` install.
 *
 * NOTE: Metro first looks in the `node_modules` directories above the importing file and only
 * then in `nodeModulesPaths`, so a copy installed inside one package of a sibling checkout (for
 * example `../quereus/packages/quereus/node_modules/@babel/runtime`) would serve that package's
 * files and is not probed here. None exists today; if one appears, probe its directory too.
 */
function runtimeInstalls(nodeModulesPaths: readonly string[]): string[] {
	return [...new Set(nodeModulesPaths)].filter((dir) => existsSync(join(dir, '@babel', 'runtime', 'package.json')));
}

function versionOf(moduleRequire: ModuleRequire, packageName: string): string {
	return (moduleRequire(`${packageName}/package.json`) as { version: string }).version;
}

function helperDefectMessage(helperSource: string): string {
	return (
		`${helperSource}: after an early exit from \`for await\`, the compiled generator skipped the code after the ` +
		'first `await` in its `finally`. This is the Babel wrapAsyncGenerator defect before 7.29.2, which left ' +
		"Quereus's execution lock held and hung strand founding on Hermes. Upgrade inside Babel 7 with " +
		'`yarn up -R @babel/runtime @babel/helpers` (a bare `yarn up` moves to Babel 8), then restart Metro with `--clear`.'
	);
}

describe("async generators compiled by the app's Metro Babel transformer", () => {
	let transformer: MetroBabelTransformer;
	let transformerRequire: ReturnType<typeof createRequire>;
	let nodeModulesPaths: readonly string[];

	beforeAll(() => {
		const appRequire = createRequire(join(appDir, 'package.json'));
		const metroConfig = appRequire('./metro.config.js') as AppMetroConfig;
		transformerRequire = createRequire(metroConfig.transformer.babelTransformerPath);
		transformer = transformerRequire(metroConfig.transformer.babelTransformerPath) as MetroBabelTransformer;
		nodeModulesPaths = metroConfig.resolver.nodeModulesPaths;
	}, BABEL_TIMEOUT_MS);

	it('the probe expects what a native engine does', async () => {
		expect(await earlyExit(loadProbe(SCRIPT_PROBE, refuseRequire))).toEqual(RELEASED);
	});

	it('modules release the lock with every @babel/runtime on Metro nodeModulesPaths', async () => {
		const code = compileForHermes(transformer, 'module', MODULE_PROBE);
		expect(code, 'the probe was not lowered onto the runtime helper').toContain('@babel/runtime/helpers/wrapAsyncGenerator');
		const installs = runtimeInstalls(nodeModulesPaths);
		expect(installs, 'no @babel/runtime on Metro nodeModulesPaths').not.toEqual([]);
		for (const dir of installs) {
			const runtimeRequire = createRequire(join(dir, '@babel', 'runtime', 'package.json'));
			const source = `@babel/runtime ${versionOf(runtimeRequire, '@babel/runtime')} in ${dir}`;
			expect(await earlyExit(loadProbe(code, runtimeRequire)), helperDefectMessage(source)).toEqual(RELEASED);
		}
	}, BABEL_TIMEOUT_MS);

	it('scripts release the lock with the helper @babel/core inlines from @babel/helpers', async () => {
		const code = compileForHermes(transformer, 'script', SCRIPT_PROBE);
		expect(code, 'the probe was not lowered onto an inlined helper').toMatch(/function _wrapAsyncGenerator\s*\(/);
		const coreRequire = createRequire(transformerRequire.resolve('@babel/core'));
		const source = `@babel/helpers ${versionOf(coreRequire, '@babel/helpers')} inlined by @babel/core ${versionOf(transformerRequire, '@babel/core')}`;
		expect(await earlyExit(loadProbe(code, refuseRequire)), helperDefectMessage(source)).toEqual(RELEASED);
	}, BABEL_TIMEOUT_MS);
});
