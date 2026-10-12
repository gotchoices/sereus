// @ts-check
// @serfab/cadre-rn/app.plugin.js: the Expo config plugin a Sereus React Native app lists in
// app.json "plugins" as "@serfab/cadre-rn", or as ["@serfab/cadre-rn", { "appLinks": … }].
//
// Android: release builds may dial plain `/ws` addresses. Android refuses non-TLS
// connections unless the app opts in, counts `ws://` as cleartext, and the React Native
// template opts in for debug builds only. Opting in is safe because Noise encrypts and
// authenticates every libp2p connection against the peer id in the address; the full
// reasoning is in docs/reference-app-rn.md → "Release builds: cleartext WebSocket".
//
// `appLinks`: the native settings `@serfab/cadre-rn/app-link` needs so two Sereus apps on one
// phone can open each other with a join request and its answer (docs/architecture.md →
// "Between apps on one phone"). Android: the main activity handles `sereus-join-request:` links,
// so the system chooser lists every owner app, and the known Sereus apps' schemes are declared
// under `<queries>`. iOS: the same schemes are listed in LSApplicationQueriesSchemes. On both,
// that lets `canOpenURL` report which known apps are installed.
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
 * @typedef {{ $: Record<string, string | undefined> }} ManifestElement
 * @typedef {{ action?: ManifestElement[], category?: ManifestElement[], data?: ManifestElement[] }} ManifestIntent
 * @typedef {{ $: Record<string, string | undefined>, 'intent-filter'?: ManifestIntent[] }} ManifestActivity
 * @typedef {{ $: Record<string, string | undefined> }} ManifestApplication
 * @typedef {{ intent?: ManifestIntent[], [key: string]: unknown }} ManifestQuery
 * @typedef {{ manifest: { queries?: ManifestQuery[], [key: string]: unknown } }} AndroidManifest
 * @typedef {ExpoConfig & { modResults: AndroidManifest }} AndroidManifestModConfig
 * @typedef {ExpoConfig & { modResults: Record<string, unknown> }} InfoPlistModConfig
 * @typedef {{
 * 	withAndroidManifest: (
 * 		config: ExpoConfig,
 * 		action: (config: AndroidManifestModConfig) => AndroidManifestModConfig,
 * 	) => ExpoConfig,
 * 	withInfoPlist: (
 * 		config: ExpoConfig,
 * 		action: (config: InfoPlistModConfig) => InfoPlistModConfig,
 * 	) => ExpoConfig,
 * 	AndroidConfig: {
 * 		Manifest: {
 * 			getMainApplicationOrThrow: (manifest: AndroidManifest) => ManifestApplication,
 * 			getMainActivityOrThrow: (manifest: AndroidManifest) => ManifestActivity,
 * 		},
 * 	},
 * }} ConfigPlugins
 * @typedef {{ name: string, scheme: string, androidPackage?: string, iosAppStoreId?: string }} SereusApp
 * @typedef {{ extraApps: SereusApp[] }} AppLinksOptions
 */

/**
 * The Sereus apps the kit knows: a copy of `KNOWN_SEREUS_APPS` in src/app-link/known-apps.ts,
 * which this CommonJS file cannot load. test/app-link/app-link.spec.ts keeps the two equal.
 *
 * @type {readonly SereusApp[]}
 */
const KNOWN_SEREUS_APPS = [
	{ name: 'Sereus P2P Chat', scheme: 'sereus-chat' },
];

/** The scheme every opted-in Sereus app handles on Android: the join request text's own. */
const JOIN_REQUEST_SCHEME = 'sereus-join-request';

/** iOS reads at most this many LSApplicationQueriesSchemes entries. */
const IOS_MAX_QUERIED_SCHEMES = 50;

/**
 * The form of an app's own URL scheme, as `@serfab/cadre-core` checks a join request's reply scheme.
 * NOTE: a copy of cadre-core's `CADRE_JOIN_REPLY_SCHEME`, with no test keeping the two equal; if
 * cadre-core's form changes, change this one with it.
 */
const APP_SCHEME = /^[a-z][a-z0-9+.-]{0,63}$/;

/** A Play application id: a Java package name of two or more dotted parts. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** A numeric App Store id. */
const IOS_APP_STORE_ID = /^[0-9]{1,12}$/;

const VIEW_ACTION = 'android.intent.action.VIEW';

/**
 * @param {ExpoConfig} config
 * @param {unknown} [props] the second element of the app.json plugin entry
 * @returns {ExpoConfig}
 */
function withCadre(config, props) {
	const appLinks = appLinksOption(props);
	const plugins = appConfigPlugins(config);
	const withCleartext = withAndroidCleartextWebSocket(config, plugins);
	return appLinks ? withAppLinks(withCleartext, plugins, appLinks) : withCleartext;
}
withCadre.KNOWN_SEREUS_APPS = KNOWN_SEREUS_APPS;

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
 * @param {ExpoConfig} config
 * @param {ConfigPlugins} plugins
 * @param {AppLinksOptions} appLinks
 * @returns {ExpoConfig}
 */
function withAppLinks(config, plugins, appLinks) {
	const appSchemes = [...KNOWN_SEREUS_APPS, ...appLinks.extraApps].map((app) => app.scheme);
	const withAndroid = plugins.withAndroidManifest(config, (modConfig) => {
		addJoinRequestIntentFilter(plugins.AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults));
		addViewQueries(modConfig.modResults, [JOIN_REQUEST_SCHEME, ...appSchemes]);
		return modConfig;
	});
	return plugins.withInfoPlist(withAndroid, (modConfig) => {
		addQueriedSchemes(modConfig.modResults, appSchemes);
		return modConfig;
	});
}

/**
 * A `VIEW` intent filter for `sereus-join-request:` on the main activity, so opening a join
 * request lists this app in Android's chooser. Skipped when the activity already has one.
 *
 * @param {ManifestActivity} activity
 */
function addJoinRequestIntentFilter(activity) {
	const filters = (activity['intent-filter'] ??= []);
	if (filters.some((filter) => viewsScheme(filter, JOIN_REQUEST_SCHEME))) return;
	filters.push({
		action: [{ $: { 'android:name': VIEW_ACTION } }],
		category: [
			{ $: { 'android:name': 'android.intent.category.DEFAULT' } },
			{ $: { 'android:name': 'android.intent.category.BROWSABLE' } },
		],
		data: [{ $: { 'android:scheme': JOIN_REQUEST_SCHEME } }],
	});
}

/**
 * A `<queries>` `VIEW` intent for each of `schemes`: on Android 11 and later an app's
 * `resolveActivity` (behind `canOpenURL`) sees other apps' handlers of an intent only when the
 * app declares the intent here. Each is skipped when the manifest already declares it.
 *
 * @param {AndroidManifest} androidManifest
 * @param {string[]} schemes
 */
function addViewQueries(androidManifest, schemes) {
	const queries = (androidManifest.manifest.queries ??= []);
	const missing = [...new Set(schemes)].filter((scheme) => !queries.some((query) => (query.intent ?? []).some((intent) => viewsScheme(intent, scheme))));
	if (missing.length === 0) return;
	queries.push({
		intent: missing.map((scheme) => ({
			action: [{ $: { 'android:name': VIEW_ACTION } }],
			data: [{ $: { 'android:scheme': scheme } }],
		})),
	});
}

/**
 * @param {ManifestIntent} intent
 * @param {string} scheme
 * @returns {boolean}
 */
function viewsScheme(intent, scheme) {
	return (intent.action ?? []).some((action) => action.$['android:name'] === VIEW_ACTION)
		&& (intent.data ?? []).some((data) => data.$['android:scheme'] === scheme);
}

/**
 * Adds `schemes` to LSApplicationQueriesSchemes, keeping the entries already there. Refuses
 * when the total passes the 50 iOS reads, since iOS ignores the rest without a word.
 *
 * @param {Record<string, unknown>} infoPlist
 * @param {string[]} schemes
 */
function addQueriedSchemes(infoPlist, schemes) {
	const existing = infoPlist.LSApplicationQueriesSchemes;
	if (existing !== undefined && !(Array.isArray(existing) && existing.every((entry) => typeof entry === 'string'))) {
		throw new Error('@serfab/cadre-rn config plugin: ios.infoPlist.LSApplicationQueriesSchemes must be a list of schemes');
	}
	const merged = [...new Set([...(existing ?? []), ...schemes])];
	if (merged.length > IOS_MAX_QUERIED_SCHEMES) {
		throw new Error(`@serfab/cadre-rn config plugin: LSApplicationQueriesSchemes would list ${merged.length} schemes; iOS reads at most ${IOS_MAX_QUERIED_SCHEMES}`);
	}
	infoPlist.LSApplicationQueriesSchemes = merged;
}

/**
 * The `appLinks` option, or null when the app did not ask for it. `true` takes the known apps
 * alone; an object may add `extraApps`. Refuses a misspelt key rather than ignoring it, since an
 * ignored option leaves the app without links and no error until a user tries one.
 *
 * @param {unknown} props
 * @returns {AppLinksOptions | null}
 */
function appLinksOption(props) {
	if (props === undefined || props === null) return null;
	const { appLinks, ...unknown } = /** @type {Record<string, unknown>} */ (requireObject(props, 'options'));
	refuseUnknownKeys(unknown, 'options');
	if (appLinks === undefined || appLinks === false) return null;
	if (appLinks === true) return { extraApps: [] };
	const { extraApps = [], ...unknownAppLinks } = /** @type {Record<string, unknown>} */ (requireObject(appLinks, 'appLinks'));
	refuseUnknownKeys(unknownAppLinks, 'appLinks');
	if (!Array.isArray(extraApps)) throw new Error('@serfab/cadre-rn config plugin: appLinks.extraApps must be a list of { name, scheme, androidPackage?, iosAppStoreId? }');
	return { extraApps: extraApps.map(requireSereusApp) };
}

/**
 * @param {unknown} app
 * @param {number} index
 * @returns {SereusApp}
 */
function requireSereusApp(app, index) {
	const where = `appLinks.extraApps[${index}]`;
	const { name, scheme, androidPackage, iosAppStoreId, ...unknown } = /** @type {Record<string, unknown>} */ (requireObject(app, where));
	refuseUnknownKeys(unknown, where);
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error(`@serfab/cadre-rn config plugin: ${where}.name must be the app's name`);
	}
	if (typeof scheme !== 'string' || !APP_SCHEME.test(scheme)) {
		throw new Error(`@serfab/cadre-rn config plugin: ${where}.scheme must be a lowercase URL scheme (it is ${JSON.stringify(scheme)})`);
	}
	/** @type {SereusApp} */
	const sereusApp = { name: name.trim(), scheme };
	if (androidPackage !== undefined) {
		sereusApp.androidPackage = requireMatch(androidPackage, ANDROID_PACKAGE, `${where}.androidPackage`, 'a Play application id such as com.example.app');
	}
	if (iosAppStoreId !== undefined) {
		sereusApp.iosAppStoreId = requireMatch(iosAppStoreId, IOS_APP_STORE_ID, `${where}.iosAppStoreId`, 'the numeric App Store id, as a string');
	}
	return sereusApp;
}

/**
 * @param {unknown} value
 * @param {RegExp} form
 * @param {string} where
 * @param {string} what
 * @returns {string}
 */
function requireMatch(value, form, where, what) {
	if (typeof value !== 'string' || !form.test(value)) {
		throw new Error(`@serfab/cadre-rn config plugin: ${where} must be ${what} (it is ${JSON.stringify(value)})`);
	}
	return value;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {object}
 */
function requireObject(value, where) {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`@serfab/cadre-rn config plugin: ${where} must be an object`);
	}
	return value;
}

/**
 * @param {Record<string, unknown>} rest
 * @param {string} where
 */
function refuseUnknownKeys(rest, where) {
	const keys = Object.keys(rest);
	if (keys.length > 0) {
		throw new Error(`@serfab/cadre-rn config plugin: unknown ${where} key${keys.length > 1 ? 's' : ''} ${keys.join(', ')}`);
	}
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
