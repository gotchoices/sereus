/**
 * Guards scenarios that spawn (or import) real compiled cadre packages.
 *
 * A few scenarios launch `@serfab/cadre-cli` as a genuine child process (or
 * pull in `@serfab/cadre-host`/`@serfab/cadre-core` for their real, non-mocked
 * behaviour) instead of exercising code under test in-process. Those packages
 * run from their built `dist` output, not `src` — so an edit to `src` with no
 * following `yarn build` is silently invisible: the child runs the *previous*
 * build and any resulting failure (e.g. a 90s startup timeout) looks like a
 * real regression instead of a stale-build mistake.
 *
 * `assertCadreBuildFresh()` fails fast, before any child is spawned, when a
 * package's `src` has been touched more recently than its compiled entry
 * point (or the entry point is missing outright).
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface BuildTarget {
  /** Package name as imported (its `package.json` is resolved to find the root). */
  packageName: string;
  /** Compiled entry point actually spawned/imported at runtime, relative to the package root. */
  distEntry: string;
}

/** Every package a spawn-a-real-binary scenario ends up running compiled code from. */
const TARGETS: BuildTarget[] = [
  { packageName: '@serfab/cadre-core', distEntry: 'dist/index.js' },
  { packageName: '@serfab/cadre-cli', distEntry: 'dist/bin/cadre.js' },
  { packageName: '@serfab/cadre-host', distEntry: 'dist/index.js' },
];

/** Test files aren't part of the build output — a touched test shouldn't trip this. */
const SOURCE_EXCLUDE = /\.(test|spec)\.tsx?$/;
const SOURCE_EXCLUDE_DIRS = new Set(['test', '__tests__']);

/**
 * Throws with a clear `yarn build` remedy if any target package's `dist`
 * predates its `src`. Call this as the first line of a scenario's `beforeAll`
 * — before any real cadre-cli child is spawned.
 */
export function assertCadreBuildFresh(): void {
  const problems: string[] = [];
  for (const target of TARGETS) {
    const root = resolvePackageRoot(target.packageName);
    const entryPath = join(root, target.distEntry);

    let entryMtime: number;
    try {
      entryMtime = statSync(entryPath).mtimeMs;
    } catch {
      problems.push(
        `${target.packageName}: not built (missing ${target.distEntry}). ` +
        `Run: yarn workspace ${target.packageName} build`,
      );
      continue;
    }

    const newestSrc = newestMtime(join(root, 'src'));
    if (newestSrc !== undefined && newestSrc > entryMtime) {
      problems.push(
        `${target.packageName}: dist is stale — src was edited after the last build. ` +
        `Run: yarn workspace ${target.packageName} build`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      'Stale build detected: this scenario spawns/imports real compiled cadre output.\n' +
      problems.map((p) => `  - ${p}`).join('\n'),
    );
  }
}

/**
 * Locate `packageName`'s root directory by resolving its main entry point and
 * walking up until a `package.json` with a matching `name` is found. These
 * packages are ESM-only (no `require` condition), and not all of them export
 * `./package.json` from their `exports` map, so a plain
 * `require.resolve(`${packageName}/package.json`)` isn't reliable here.
 */
function resolvePackageRoot(packageName: string): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(packageName)));
  for (;;) {
    const pkgJsonPath = join(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string };
      if (pkg.name === packageName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not locate package root for ${packageName}`);
    dir = parent;
  }
}

/** Newest mtime (ms) among source files under `dir`, recursively. */
function newestMtime(dir: string): number | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let newest: number | undefined;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SOURCE_EXCLUDE_DIRS.has(entry.name)) continue;
      const sub = newestMtime(join(dir, entry.name));
      if (sub !== undefined && (newest === undefined || sub > newest)) newest = sub;
    } else if (entry.isFile() && !SOURCE_EXCLUDE.test(entry.name)) {
      const mtime = statSync(join(dir, entry.name)).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    }
  }
  return newest;
}
