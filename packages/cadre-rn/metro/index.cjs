// @ts-check
// @serfab/cadre-rn/metro: the Metro settings every Sereus React Native app needs.
//
// CommonJS because metro.config.js is loaded by Node with require(). It imports nothing
// from metro, expo or @react-native/metro-config: the app passes in the config its own
// toolchain produced, so this works under either toolchain and pins neither. It relies on
// that config already enabling package exports (both toolchains' defaults do) and leaves
// condition names alone; their order is the app's choice.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const kitDir = path.resolve(__dirname, '..');

/**
 * The kit's optional peers: the native modules and `react-native` itself, which the app
 * must install and of which the bundle must hold exactly one copy. Read from the kit's own
 * manifest so this is never a second list.
 */
const kitPeers = Object.keys(
	JSON.parse(fs.readFileSync(path.join(kitDir, 'package.json'), 'utf8')).peerDependencies ?? {},
);

/**
 * @typedef {{ type: 'sourceFile', filePath: string } | { type: string, [key: string]: unknown }} Resolution
 * @typedef {{ originModulePath: string, resolveRequest?: ResolveRequest | null, [key: string]: unknown }} ResolutionContext
 * @typedef {(context: ResolutionContext, moduleName: string, platform: string | null) => Resolution | null} ResolveRequest
 * @typedef {{
 * 	watchFolders?: readonly string[],
 * 	resolver: {
 * 		unstable_enableSymlinks?: boolean,
 * 		nodeModulesPaths?: readonly string[],
 * 		extraNodeModules?: Record<string, string>,
 * 		resolveRequest?: ResolveRequest | null,
 * 		[key: string]: unknown,
 * 	},
 * 	[key: string]: unknown,
 * }} MetroConfig
 */

/**
 * @typedef {object} CadreMetroOptions
 * @property {string} projectRoot The app's directory: `__dirname` in its metro.config.js.
 * @property {readonly string[]} [linkedRoots] Local checkouts whose packages are linked into
 *   this app (a monorepo root, sibling repositories). Each is watched, and its `node_modules`
 *   is searched after the app's own. Omit when every package comes from npm.
 */

/**
 * Adds the Metro settings a Sereus React Native app needs to `config`, keeping everything
 * the incoming config already set: lists are appended to, alias entries the app already
 * has win over the kit's, and an existing `resolveRequest` is called by the new one.
 *
 * @template {MetroConfig} T
 * @param {T} config The config the app's toolchain produced (`getDefaultConfig(__dirname)`).
 * @param {CadreMetroOptions} options
 * @returns {T} `config`, mutated.
 */
function withCadreMetro(config, { projectRoot, linkedRoots = [] }) {
	const { resolver } = config;
	config.watchFolders = [...(config.watchFolders ?? []), ...linkedRoots];
	resolver.unstable_enableSymlinks = true;
	resolver.nodeModulesPaths = [
		...(resolver.nodeModulesPaths ?? []),
		path.join(projectRoot, 'node_modules'),
		...linkedRoots.map((root) => path.join(root, 'node_modules')),
	];
	resolver.extraNodeModules = { ...nodeBuiltinAliases(), ...(resolver.extraNodeModules ?? {}) };
	resolver.resolveRequest = cadreResolveRequest(resolver.resolveRequest ?? null, projectRoot);
	return config;
}

/**
 * Node built-ins that libp2p and its dependencies import, mapped to what stands in for
 * them on React Native, under both the bare and the `node:` name. Metro statically follows
 * every import in the graph, including ones behind runtime checks that never pass on a
 * phone, so each must resolve to something. Metro consults these only after every
 * `node_modules` lookup fails.
 *
 *   os          shims/node-os.js: networkInterfaces()/platform()/type()/hostname(), for
 *               @libp2p/utils' address discovery. A real shim, not `{}`, because the Node
 *               variant of that module lands in the bundle.
 *   crypto      shims/node-crypto.js: createHash (sha256/sha512) over @noble/hashes, for
 *               the Node variants of multiformats' sha2, @chainsafe/libp2p-noise's
 *               crypto/index and @libp2p/crypto's key modules.
 *   net, tls    shims/empty.js: for the Node variant of @libp2p/websockets' listener,
 *               never called on a phone.
 *   stream      readable-stream from npm, a real port of Node's streams.
 *   buffer      buffer from npm, a real port of Node's Buffer.
 *
 * Only `os` is reached in the reference app's Android export (checked 2026-09-26): Metro
 * picks the `browser` variants of the modules listed for `crypto`, `net` and `tls`, and
 * nothing bundled imports `stream` or `buffer` by those names. The rest stay for an app
 * whose resolver settings land on a Node variant, where an unmapped built-in fails the
 * whole bundle with an error that names the importer rather than the cause.
 *
 * Not carried over from sereus-chat's metro.config.js: its `sign()` stub on the crypto
 * shim and its `http2`, `path` and `fs` stubs. They existed for cadre-core's FCM/APNs push
 * notifiers and its file-based helpers, which now sit behind Node-only subpaths
 * (`@serfab/cadre-core/push-node`, `/key-store-file`, ...) that a React Native app never
 * imports. Stubbing `path` or `fs` to `{}` would instead break any dependency that
 * legitimately uses them.
 *
 * @returns {Record<string, string>}
 */
function nodeBuiltinAliases() {
	const emptyShim = path.join(kitDir, 'shims', 'empty.js');
	/** @type {Record<string, string>} */
	const targets = {
		os: path.join(kitDir, 'shims', 'node-os.js'),
		crypto: path.join(kitDir, 'shims', 'node-crypto.js'),
		net: emptyShim,
		tls: emptyShim,
		stream: require.resolve('readable-stream'),
		// The trailing slash makes Node look for the npm package: for a bare built-in name,
		// require.resolve returns the name itself.
		buffer: require.resolve('buffer/'),
	};
	/** @type {Record<string, string>} */
	const aliases = {};
	for (const [name, target] of Object.entries(targets)) {
		aliases[name] = target;
		aliases[`node:${name}`] = target;
	}
	return aliases;
}

/**
 * The resolver the app's config gets. It resolves through `upstream` (or Metro's own
 * resolver when there is none) and applies three rules, in this order: the kit's peers
 * resolve from the app, `@babel/runtime` helpers resolve to their CommonJS files, and two
 * libp2p packages get their `browser`-field variants.
 *
 * @param {ResolveRequest | null} upstream
 * @param {string} projectRoot
 * @returns {ResolveRequest}
 */
function cadreResolveRequest(upstream, projectRoot) {
	const appOrigin = path.join(projectRoot, 'package.json');
	const libp2pBrowserVariant = libp2pBrowserRewriter();

	/** @type {ResolveRequest} */
	const resolveUpstream = (context, moduleName, platform) => (upstream
		? upstream(context, moduleName, platform)
		: /** @type {ResolveRequest} */ (context.resolveRequest)({ ...context, resolveRequest: undefined }, moduleName, platform));

	return (context, moduleName, platform) => {
		if (isKitPeer(moduleName)) {
			return libp2pBrowserVariant(resolveUpstream({ ...context, originModulePath: appOrigin }, moduleName, platform));
		}
		const helper = babelRuntimeHelper(moduleName, projectRoot);
		if (helper != null) {
			return { type: 'sourceFile', filePath: helper };
		}
		return libp2pBrowserVariant(resolveUpstream(context, moduleName, platform));
	};
}

/**
 * Rule 1: whether `moduleName` names one of the kit's peers, or a subpath of one. Those
 * resolve as if the app imported them.
 *
 * Metro looks in the `node_modules` directories above the importing file before
 * `nodeModulesPaths`. In a monorepo the kit's real path is outside the app, so its own
 * imports of these would find a copy hoisted to the repository root first: its types-only
 * dev install of react-native-quick-crypto, or the root's react-native-webrtc (hoisted
 * there for @libp2p/webrtc), which put two copies of react-native-webrtc in the bundle,
 * each numbering peer connections from its own counter. The rule applies to every
 * importer, not only the kit: native code is linked only for the app's own dependencies,
 * so any other copy of one of these is JavaScript that does not match the native side. For
 * an app that installs the kit from npm nothing changes for the kit's imports, which
 * already sit inside the app's `node_modules`.
 *
 * A peer the app has not installed fails with Metro's usual "unable to resolve", and only
 * if something imports it.
 *
 * @param {string} moduleName
 */
function isKitPeer(moduleName) {
	return kitPeers.some((peer) => moduleName === peer || moduleName.startsWith(`${peer}/`));
}

/**
 * Rule 2: the CommonJS file for an `@babel/runtime` import, from the app's copy, or
 * `undefined` to leave it to Metro.
 *
 * Metro's Babel output `require()`s these helpers and expects the function itself. An app
 * whose condition list puts `import` ahead of `require` (sereus-chat's does, for ESM-only
 * libp2p packages) otherwise gets the ESM wrapper, and the bundle fails at startup with
 * "_interopRequireDefault is not a function". Node's resolution picks the `node` condition,
 * the CommonJS file. Expo's default conditions already pick that file, so for an Expo app
 * this only makes every importer use the app's copy.
 *
 * @param {string} moduleName
 * @param {string} projectRoot
 * @returns {string | undefined}
 */
function babelRuntimeHelper(moduleName, projectRoot) {
	if (!moduleName.startsWith('@babel/runtime/')) {
		return undefined;
	}
	try {
		return require.resolve(moduleName, { paths: [projectRoot] });
	} catch (error) {
		// A path this Babel release does not export, or no copy under the app: Metro's own
		// resolution then either finds it or reports it, naming the importer.
		if (isModuleNotFound(error)) {
			return undefined;
		}
		throw error;
	}
}

/** @param {unknown} error */
function isModuleNotFound(error) {
	const code = /** @type {{ code?: unknown }} */ (error)?.code;
	return code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
}

/**
 * Packages whose `browser`-field rewrites rule 3 applies by hand:
 *
 *   @libp2p/crypto   ed25519/secp256k1/rsa/ecdh keys, webcrypto, hmac, aes-gcm. The browser
 *                    variants use @noble/curves and WebCrypto and run under Hermes; the Node
 *                    variants call crypto.generateKeyPairSync / createPrivateKey / sign /
 *                    verify, which shims/node-crypto.js does not implement, so without the
 *                    rewrite the first generateKeyPair('Ed25519') throws "undefined cannot
 *                    be used as a constructor".
 *   @libp2p/webrtc   private-to-public/{listener,transport} and get-rtcpeerconnection. The
 *                    Node variants pull node-datachannel, a native addon absent on React
 *                    Native; the browser variants read the WebRTC engine off the globals
 *                    react-native-webrtc's registerGlobals() installs (see
 *                    @serfab/cadre-rn/polyfills/webrtc). The `browser` variant is forced
 *                    rather than the `react-native` one because the `react-native` field
 *                    maps only webrtc/index.js, leaving private-to-public on
 *                    node-datachannel.
 *
 * The package's own `browser` map also lists webrtc/index.js, but that entry never fires:
 * Metro applies the `react-native` field first, so the resolved file is already
 * webrtc/index.react-native.js (which imports react-native-webrtc directly), not the key
 * this rewrite looks up. An Android export's source map holds that file plus the browser
 * variants of private-to-public's transport and get-rtcpeerconnection.
 *
 * Why by hand: with package exports enabled (both toolchains' default) Metro resolves these
 * packages through `exports`, and does not reliably apply the `browser` rewrite to their
 * internal relative imports.
 */
const BROWSER_REWRITTEN_PACKAGES = new Set(['@libp2p/crypto', '@libp2p/webrtc']);

/**
 * Rule 3: returns a function that swaps a resolved file for its `browser`-field variant
 * when the file lies in one of {@link BROWSER_REWRITTEN_PACKAGES}. The map comes from the
 * package directory of the file actually resolved, cached per directory, so every
 * installed copy is covered, a nested one included. Anything but a `sourceFile`
 * resolution, `null` included, passes through unchanged.
 *
 * @returns {(resolution: Resolution | null) => Resolution | null}
 */
function libp2pBrowserRewriter() {
	/** @type {Map<string, Map<string, string>>} */
	const mapsByPackageDir = new Map();

	/** @param {string} packageDir */
	const browserMapOf = (packageDir) => {
		let map = mapsByPackageDir.get(packageDir);
		if (map == null) {
			map = readBrowserMap(packageDir);
			mapsByPackageDir.set(packageDir, map);
		}
		return map;
	};

	return (resolution) => {
		if (resolution?.type !== 'sourceFile') {
			return resolution;
		}
		const { filePath } = /** @type {{ filePath: string }} */ (resolution);
		const packageDir = rewrittenPackageDirOf(filePath);
		const target = packageDir == null ? undefined : browserMapOf(packageDir).get(path.normalize(filePath));
		return target == null ? resolution : { type: 'sourceFile', filePath: target };
	};
}

/**
 * The directory of the installed package `filePath` belongs to, when that package is one
 * of {@link BROWSER_REWRITTEN_PACKAGES}. The package is the one after the last
 * `node_modules` segment, so a file of a dependency nested inside one of them is not
 * attributed to it.
 *
 * @param {string} filePath
 * @returns {string | undefined}
 */
function rewrittenPackageDirOf(filePath) {
	const segments = path.normalize(filePath).split(path.sep);
	const nodeModules = segments.lastIndexOf('node_modules');
	if (nodeModules < 0) {
		return undefined;
	}
	const nameLength = segments[nodeModules + 1]?.startsWith('@') ? 2 : 1;
	const nameSegments = segments.slice(nodeModules + 1, nodeModules + 1 + nameLength);
	if (!BROWSER_REWRITTEN_PACKAGES.has(nameSegments.join('/'))) {
		return undefined;
	}
	return segments.slice(0, nodeModules + 1 + nameLength).join(path.sep);
}

/**
 * The package's `browser` field as absolute source path → absolute browser-variant path.
 * Entries whose target is not a path (`"node:net": false`) are skipped: those specifiers
 * are covered by the built-in aliases, and there is no file to swap in.
 *
 * @param {string} packageDir
 * @returns {Map<string, string>}
 */
function readBrowserMap(packageDir) {
	const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
	/** @type {Map<string, string>} */
	const map = new Map();
	if (manifest.browser == null || typeof manifest.browser !== 'object') {
		return map;
	}
	for (const [from, to] of Object.entries(manifest.browser)) {
		if (typeof to === 'string') {
			map.set(path.resolve(packageDir, from), path.resolve(packageDir, to));
		}
	}
	return map;
}

module.exports = { withCadreMetro };
