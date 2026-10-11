// @ts-check
// @serfab/cadre-rn/app.plugin.js: the Expo config plugin a Sereus React Native app lists in
// app.json "plugins" as "@serfab/cadre-rn".
//
// Android: release builds may dial plain `/ws` addresses. Android refuses non-TLS
// connections unless the app opts in, counts `ws://` as cleartext, and the React Native
// template opts in for debug builds only. Opting in is safe because Noise encrypts and
// authenticates every libp2p connection against the peer id in the address; the full
// reasoning is in docs/reference-app-rn.md → "Release builds: cleartext WebSocket".
//
// CommonJS because Expo loads config plugins with require(). It imports nothing from Expo
// at load time, as metro/index.cjs imports nothing from metro: the kit does not install
// Expo, so Expo's helpers are resolved from the app's own project root when the plugin runs.

'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

/**
 * The parts of Expo's config and of `expo/config-plugins` this plugin uses, typed here
 * because the kit has no Expo types to import.
 *
 * @typedef {{ _internal?: { projectRoot?: string }, [key: string]: unknown }} ExpoConfig
 * @typedef {{ $: Record<string, string | undefined> }} ManifestApplication
 * @typedef {{ manifest: unknown }} AndroidManifest
 * @typedef {ExpoConfig & { modResults: AndroidManifest }} AndroidManifestModConfig
 * @typedef {{
 * 	withAndroidManifest: (
 * 		config: ExpoConfig,
 * 		action: (config: AndroidManifestModConfig) => AndroidManifestModConfig,
 * 	) => ExpoConfig,
 * 	AndroidConfig: {
 * 		Manifest: { getMainApplicationOrThrow: (manifest: AndroidManifest) => ManifestApplication },
 * 	},
 * }} ConfigPlugins
 */

/**
 * @param {ExpoConfig} config
 * @returns {ExpoConfig}
 */
function withCadre(config) {
	return withAndroidCleartextWebSocket(config, appConfigPlugins(config));
}

/**
 * Sets `android:usesCleartextTraffic="true"` on the app's `<application>` element, so
 * release builds can dial `/ws` addresses.
 *
 * @param {ExpoConfig} config
 * @param {ConfigPlugins} plugins
 * @returns {ExpoConfig}
 */
function withAndroidCleartextWebSocket(config, { withAndroidManifest, AndroidConfig }) {
	return withAndroidManifest(config, (modConfig) => {
		AndroidConfig.Manifest.getMainApplicationOrThrow(modConfig.modResults).$['android:usesCleartextTraffic'] = 'true';
		return modConfig;
	});
}

/**
 * `expo/config-plugins` as the app installed it. `@expo/config` sets `_internal.projectRoot`
 * before it applies the plugins listed in app.json; without it there is no app directory
 * to resolve from, and guessing one could load a different Expo than the app's.
 *
 * @param {ExpoConfig} config
 * @returns {ConfigPlugins}
 */
function appConfigPlugins(config) {
	const projectRoot = config._internal?.projectRoot;
	if (!projectRoot) {
		throw new Error('@serfab/cadre-rn config plugin: Expo did not pass the project root (config._internal.projectRoot), so expo/config-plugins cannot be resolved from the app');
	}
	return createRequire(path.join(projectRoot, 'package.json'))('expo/config-plugins');
}

module.exports = withCadre;
