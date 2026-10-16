/*
 * Named-package `browser` file maps, shared by the rewrite plugin in
 * webpack.config.js and the check in scripts/bundle-check.js that no file the
 * rewrite should have replaced was bundled. Why each package is listed:
 * docs/reference-app-ns.md § "Named-package Node → browser rewrite".
 */

const path = require('path');
const fs = require('fs');

/**
 * Packages whose own `browser` file map is applied to their internal relative
 * imports. Explicit rather than every package: most bundled Node variants are
 * harmless, so a package joins only once its Node variant is measured to break
 * or cost something on NativeScript.
 */
const BROWSER_MAP_PACKAGES = new Set(['@libp2p/crypto', 'main-event']);

/**
 * The installed package that owns `file` — its name and root directory, taken
 * from the last `node_modules` segment of the path (scoped names span two
 * segments) — or null when `file` is not under any `node_modules`.
 */
function owningPackage(file) {
	const nm = `${path.sep}node_modules${path.sep}`;
	const i = file.lastIndexOf(nm);
	if (i === -1) return null;
	const [first, second] = file.slice(i + nm.length).split(path.sep);
	const name = first.startsWith('@') ? `${first}/${second}` : first;
	return { name, root: path.join(file.slice(0, i + nm.length), ...name.split('/')) };
}

const browserMapCache = new Map();

/**
 * The `browser` object map (package-relative key → package-relative value) from
 * `<pkgRoot>/package.json`, or null. Read per installed copy, so each copy in the
 * tree (local + nested optimystic) uses its own version's map.
 */
function loadBrowserMap(pkgRoot) {
	if (!browserMapCache.has(pkgRoot)) {
		const map = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).browser;
		browserMapCache.set(pkgRoot, map && typeof map === 'object' ? map : null);
	}
	return browserMapCache.get(pkgRoot);
}

/**
 * The absolute path of the browser file that replaces `file`, when `file`
 * belongs to a listed package and is a key of that copy's `browser` map; else
 * null. A `false` map value ("empty module") is not applied — no listed
 * package uses one.
 */
function browserVariantOf(file) {
	const pkg = owningPackage(file);
	if (!pkg || !BROWSER_MAP_PACKAGES.has(pkg.name)) return null;
	// NOTE: exact-key lookup in `./dir/file.js` form, which both listed packages use; a
	// package whose map keys omit `./` or the extension (the browser-field spec allows
	// both) would silently not rewrite — `yarn test:bundle` does not catch that case.
	const rel = `./${path.relative(pkg.root, file).split(path.sep).join('/')}`;
	const mapped = loadBrowserMap(pkg.root)?.[rel];
	return typeof mapped === 'string' ? path.resolve(pkg.root, mapped) : null;
}

module.exports = { browserVariantOf };
