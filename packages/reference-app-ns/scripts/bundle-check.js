/*
 * bundle-only smoke (agent / CI runnable).
 *
 * Runs the NativeScript webpack compile for android WITHOUT the native device
 * build — the analog of reference-app-rn's `expo export`. It resolves and parses
 * the whole cadre / db-p2p / Quereus / Optimystic import graph (db-p2p → rn.js,
 * no @libp2p/tcp, @libp2p/crypto browser variants, ES2022 downlevel) and fails
 * if webpack reports any error OR warning. `ns prepare android` additionally
 * drives a gradle native-plugin build that needs the Android SDK / gradle and is
 * out-of-band.
 *
 * Warnings are fatal on purpose: webpack.config.js downgrades missing-export
 * errors to warnings (`exportsPresence: 'warn'`) for a known upstream version
 * skew, and allowlists exactly those messages via `ignoreWarnings`. Anything that
 * still reaches this script is therefore a NEW missing export (or other warning)
 * that nothing has vetted — the strictness the override gave up lives here.
 */

const webpack = require('webpack');
const nsConfigFactory = require('../webpack.config.js');

// Mirror the env the NS CLI passes for `ns prepare android`, minus native build.
const config = nsConfigFactory({
	android: true,
	appPath: 'app',
	appResourcesPath: 'App_Resources',
	production: false,
	sourceMap: false,
});

webpack(config, (err, stats) => {
	if (err) {
		console.error('bundle-check: webpack invocation failed:', err);
		process.exit(1);
	}
	console.log(
		stats.toString({
			colors: false,
			chunks: false,
			modules: false,
			children: false,
			warnings: true,
			errors: true,
			errorDetails: false,
		}),
	);
	const info = stats.toJson({ errors: true, warnings: true });
	const errorCount = info.errors ? info.errors.length : 0;
	const warningCount = info.warnings ? info.warnings.length : 0;
	if (errorCount > 0 || warningCount > 0) {
		console.error(
			`\nbundle-check: FAILED — ${errorCount} error(s), ${warningCount} warning(s).` +
				(warningCount > 0
					? ' Warnings are fatal: see the header comment — an unallowlisted' +
						' warning means a genuinely new resolution/export problem.'
					: ''),
		);
		process.exit(1);
	}
	console.log('\nbundle-check: OK — whole import graph compiled with 0 errors, 0 warnings.');
	process.exit(0);
});
