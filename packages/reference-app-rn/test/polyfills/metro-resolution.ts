/**
 * Locates installed packages the way Metro will at bundle time, for the two specs in
 * this directory.
 *
 * Both need to read files out of dependencies that this package does not declare
 * (`libp2p`, `@libp2p/utils`, …) and whose `exports` maps do not list the deep paths
 * involved, so neither `require.resolve` nor a bare import can reach them. Metro finds
 * them by walking `resolver.nodeModulesPaths` from `metro.config.js` — five roots,
 * because this package sets `installConfig.hoistingLimits: "workspaces"` and three
 * sibling checkouts are portaled in. Reading that list from the app's own config is
 * what keeps these specs pointed at the same installs the phone gets.
 *
 * NOTE: this is the `nodeModulesPaths` half of Metro's algorithm only. Metro first
 * looks in the `node_modules` directories above the importing file, so a copy
 * installed inside one package of a sibling checkout would serve that package's files
 * and is not what this returns. Same caveat as `runtimeInstalls` in
 * test/metro-babel/async-generator-cleanup.spec.ts.
 */

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This package's root — two levels up from test/polyfills. */
export const appDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The fields of the app's Metro config these specs read. */
interface AppMetroConfig {
	resolver: { nodeModulesPaths: readonly string[] };
}

let cachedRoots: readonly string[] | undefined;

/** The `node_modules` roots Metro searches, in Metro's order, de-duplicated. */
export function metroNodeModulesPaths(): readonly string[] {
	if (cachedRoots == null) {
		const appRequire = createRequire(join(appDir, 'package.json'));
		const config = appRequire('./metro.config.js') as AppMetroConfig;
		cachedRoots = [...new Set(config.resolver.nodeModulesPaths)];
	}
	return cachedRoots;
}

/**
 * The real directory of an installed package, with symlinks resolved so that portaled
 * siblings report the path their files actually live at.
 *
 * @throws if no root holds the package — a listed dependency that has moved or gone is
 * a spec that has silently stopped checking anything, not a spec that should skip.
 */
export function resolvePackageDir(packageName: string): string {
	for (const root of metroNodeModulesPaths()) {
		const dir = join(root, packageName);
		if (existsSync(join(dir, 'package.json'))) {
			return realpathSync(dir);
		}
	}
	throw new Error(
		`${packageName} is not installed under any of Metro's nodeModulesPaths `
		+ `(${metroNodeModulesPaths().join(', ')}). Either the dependency was removed — in which case drop it `
		+ 'from this spec\'s list — or the install is incomplete; run `yarn install`.',
	);
}
