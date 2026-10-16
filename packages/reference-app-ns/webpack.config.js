const path = require('path');
const webpack = require('@nativescript/webpack');
// NOTE: `webpack` is not a declared dependency of this package (scripts/bundle-check.js
// requires it too). It resolves only because @nativescript/webpack lists it under
// `dependencies`, and `yarn dep-check` can't catch the omission — knip's webpack plugin
// treats `webpack` as its own enabler, so it is never reported as unlisted. Fine while
// that dependency holds; if @nativescript/webpack ever demotes webpack to a peer or drops
// it, declare it here explicitly and reuse its exact range string so yarn dedupes onto the
// existing lock entry rather than installing a second webpack.
const webpackCore = require('webpack');
const { browserVariantOf } = require('./browser-map.js');

/**
 * NativeScript (webpack 5) build config for @serfab/reference-app-ns.
 *
 * Reproduces the RN Metro resolver behaviour (packages/reference-app-rn/
 * metro.config.js) so the cadre / db-p2p / Quereus / Optimystic stack bundles
 * under the NativeScript V8/JSC runtime:
 *   - Node-builtin shims/stubs (os / crypto / stream → real; net / tls / http
 *     / dns / … → empty `false`)
 *   - `node:`-scheme stripping (webpack's `externalsPresets.node:false` leaves
 *     `node:` URIs unhandled, so map them to bare specifiers → fallback)
 *   - `react-native` + `browser` export conditions (db-p2p → rn.js, no TCP)
 *   - named packages' `browser` file maps applied to their internal imports
 *     (@libp2p/crypto, main-event)
 *   - esbuild downlevel of ES2022 (private methods) in node_modules — NS 8.x's
 *     toolchain parses bundled deps below ES2022 and rejects `async #method`
 *   - `exportsPresence: 'warn'` so upstream version-skew "export not found"
 *     (gossipsub/autonat vs @libp2p/interface) warn instead of failing the build
 */
module.exports = (env) => {
	webpack.init(env);

	webpack.chainWebpack((config) => {
		const nodeOs = path.resolve(__dirname, 'src/polyfills/node-os.ts');
		const nodeCrypto = path.resolve(__dirname, 'src/polyfills/node-crypto.ts');
		const nodeTty = path.resolve(__dirname, 'src/polyfills/node-tty.ts');
		const nodeCluster = path.resolve(__dirname, 'src/polyfills/node-cluster.ts');

		// ── JS-engine condition resolution ──────────────────────────────────
		// `react-native` so @optimystic/db-p2p and @serfab/cadre-core resolve
		// their TCP-free react-native export condition (db-p2p → rn.js, no
		// @libp2p/tcp). `browser` so @libp2p/websockets and friends pick their
		// browser variants. We deliberately omit `node` — the NativeScript
		// V8/JSC runtime is browser-like, not Node.
		config.resolve.set('conditionNames', [
			'react-native',
			'browser',
			'module',
			'import',
			'require',
			'default',
		]);

		// ── Named-package Node → browser rewrite ────────────────────────────
		// Some packages pick their browser files only through a top-level
		// `browser` map — NOT `exports`, so `conditionNames` cannot select it,
		// and (verified) the `browser` alias field does NOT apply it to the
		// package's internal relative imports either. For each package in
		// BROWSER_MAP_PACKAGES (browser-map.js) the map is applied explicitly,
		// like the RN Metro `resolveRequest` rewrite (metro.config.js / docs/reference-app-rn.md §
		// "Why the browser rewrite matters"): an internal relative `.js` import
		// whose package-relative path is a map key is redirected to the mapped
		// file. Reasons per package are in docs/reference-app-ns.md § "Named-
		// package Node → browser rewrite". `browser` stays an alias field for
		// packages whose map covers bare specifiers.
		config.resolve.set('aliasFields', ['browser']);
		config
			.plugin('browser-map-rewrite')
			.use(webpackCore.NormalModuleReplacementPlugin, [
				/\.js$/,
				(resource) => {
					if (!resource.context || !resource.request.startsWith('.')) return;
					const mapped = browserVariantOf(path.resolve(resource.context, resource.request));
					if (mapped) resource.request = mapped;
				},
			]);

		// ── node: scheme → bare specifier ───────────────────────────────────
		// NS sets `externalsPresets.node:false` (built-ins are bundled, not
		// external), which leaves `node:`-prefixed imports as an unhandled URI
		// scheme (UnhandledSchemeError). Rewrite `node:foo` → `foo` so it flows
		// through resolve.fallback / normal resolution, matching the RN Metro
		// `extraNodeModules` handling of both `node:os` and `os`.
		config
			.plugin('strip-node-scheme')
			.use(webpackCore.NormalModuleReplacementPlugin, [
				/^node:/,
				(resource) => {
					resource.request = resource.request.replace(/^node:/, '');
				},
			]);

		// ── libp2p user-agent → NativeScript-safe shim ──────────────────────
		// libp2p.js imports `./user-agent.js` relatively, so its react-native/
		// browser export conditions never select a variant — webpack bundles the
		// node one, whose `process.versions.node.replaceAll('v','')` throws on the
		// NS runtime (no `process.versions.node`), crashing the Libp2p constructor
		// on Connect. Redirect every libp2p copy to a static, NS-safe shim.
		config
			.plugin('libp2p-user-agent-shim')
			.use(webpackCore.NormalModuleReplacementPlugin, [
				/user-agent\.js$/,
				(resource) => {
					const ctx = resource.context ?? '';
					if (
						resource.request === './user-agent.js' &&
						ctx.includes(`libp2p${path.sep}dist${path.sep}src`)
					) {
						resource.request = path.resolve(__dirname, 'src/shims/libp2p-user-agent.js');
					}
				},
			]);

		// ── @chainsafe/libp2p-noise crypto → pure-JS shim ───────────────────
		// noise's `defaultCrypto` overrides X25519 keygen/DH + SHA-256 with
		// `node:crypto` (generateKeyPairSync/createPrivateKey/diffieHellman), absent
		// from the NS createHash-only crypto shim → the Noise constructor throws on
		// Connect. noise exposes no browser condition for its crypto and db-p2p calls
		// `noise()` with no override, so redirect its `crypto/index.js` to a pure-JS
		// (noble) shim — every noise copy in the tree.
		config
			.plugin('noise-crypto-shim')
			.use(webpackCore.NormalModuleReplacementPlugin, [
				/crypto[\\/]index\.js$/,
				(resource) => {
					const ctx = resource.context ?? '';
					if (
						resource.request === './crypto/index.js' &&
						ctx.includes(`@chainsafe${path.sep}libp2p-noise`)
					) {
						resource.request = path.resolve(__dirname, 'src/shims/noise-crypto.js');
					}
				},
			]);

		// ── Node built-in shims / stubs ─────────────────────────────────────
		// crypto/os/tty: custom shims (createHash via @noble/hashes;
		// networkInterfaces stub; tty.isatty → false so debug/weald's eager
		// useColors() check doesn't crash). stream → readable-stream. buffer/events/util/process/
		// string_decoder resolve directly to their installed npm packages
		// (externalsPresets.node:false). net/tls/http/… : `false` (empty module) —
		// imported by transitive libp2p / debug / @multiformats/dns deps on
		// Node-only branches never reached on the TCP-free, browser-transport rn
		// path, but must resolve so the bundle builds.
		config.resolve.merge({
			fallback: {
				os: nodeOs,
				crypto: nodeCrypto,
				tty: nodeTty,
				stream: require.resolve('readable-stream'),
				net: false,
				tls: false,
				http: false,
				https: false,
				http2: false,
				zlib: false,
				dns: false,
				'dns/promises': false,
				dgram: false,
				// cluster: real shim — mortice (libp2p peer-store lock) reads
				// `cluster.isPrimary` and registers `cluster.on('message')` on its
				// single-process path; an empty stub made `.on` throw on Connect.
				cluster: nodeCluster,
				child_process: false,
				worker_threads: false,
				perf_hooks: false,
				async_hooks: false,
				readline: false,
				repl: false,
				inspector: false,
				v8: false,
				vm: false,
				fs: false,
				'fs/promises': false,
				constants: false,
				domain: false,
				punycode: false,
			},
		});

		// ── Downlevel ES2022 in bundled deps ────────────────────────────────
		// libp2p/peer-store, circuit-relay-v2, etc. ship dist with ES2022 private
		// methods (`async #method`). NS 8.x's CommonJS-output toolchain parses
		// node_modules below ES2022 and rejects them ("Unexpected token"). esbuild
		// downlevels syntax (semantics preserved) for everything under
		// node_modules except @nativescript's own packages. NS V8/JSC supports
		// the syntax at runtime; this is purely to satisfy the build-time parser.
		config.module
			.rule('esbuild-downlevel-deps')
			.test(/\.[cm]?js$/)
			.include.add(/[\\/]node_modules[\\/]/).end()
			.exclude.add(/[\\/]node_modules[\\/]@nativescript[\\/]/).end()
			.use('esbuild-loader')
			.loader('esbuild-loader')
			.options({ target: 'es2020' });

		// ── Modern output target ────────────────────────────────────────────
		// The NS V8/JSC runtime supports modern syntax, so let webpack emit it in
		// its own runtime rather than downleveling.
		config.output.set('environment', {
			arrowFunction: true,
			asyncFunction: true,
			bigIntLiteral: true,
			const: true,
			destructuring: true,
			dynamicImport: true,
			forOf: true,
			globalThis: true,
			module: false,
			optionalChaining: true,
			templateLiteral: true,
			nodePrefixForCoreModules: false,
		});
	});

	const config = webpack.resolveConfig();

	// ── exportsPresence: warn ─────────────────────────────────────────────────
	// @optimystic/db-p2p's nested deps carry a version skew: @chainsafe/libp2p-
	// gossipsub imports StrictSign/StrictNoSign/TopicValidatorResult and
	// @libp2p/autonat imports streamMessage from versions of @libp2p/interface /
	// protons-runtime that renamed them. Metro tolerates missing named exports;
	// webpack treats them as hard errors for strict ESM. Downgrade to warnings so
	// the build reflects the same (working-at-runtime) reality as the RN app.
	config.module = config.module ?? {};
	config.module.parser = config.module.parser ?? {};
	config.module.parser.javascript = {
		...(config.module.parser.javascript ?? {}),
		exportsPresence: 'warn',
	};

	// ── Silence the known upstream skew warnings ──────────────────────────────
	// With exportsPresence:'warn' the renamed/removed named imports above no
	// longer fail the build, but each emits a "export 'X' was not found in 'Y'"
	// warning — which bury any genuinely new warning. Suppress ONLY these
	// specific, known-benign cases (the names are never reached on the TCP-free
	// browser-transport rn path), scoped to the exact upstream modules that
	// renamed them. Any OTHER missing export — including a new one from these
	// same modules — still surfaces as a warning, and scripts/bundle-check.js
	// fails on any warning, so this isn't a blanket mute.
	const SKEW_WARNINGS = [
		// gossipsub vs @libp2p/interface
		/export 'Strict(Sign|NoSign)' .*was not found in '@libp2p\/interface'/,
		/export 'TopicValidatorResult' .*was not found in '@libp2p\/interface'/,
		// @libp2p/autonat vs protons-runtime
		/export 'streamMessage' .*was not found in 'protons-runtime'/,
	];
	config.ignoreWarnings = [
		...(config.ignoreWarnings ?? []),
		(warning) => SKEW_WARNINGS.some((re) => re.test(warning.message ?? '')),
	];

	return config;
};
