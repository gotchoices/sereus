/**
 * Logs why the app is about to reload (development builds only).
 *
 * Every JS-initiated reload in a development build ends in `DevSettings.reload(reason?)`,
 * but not every caller passes a reason:
 * - `Libraries/Utilities/HMRClient.js` passes `Bundle Splitting – Metro disconnected`
 *   when a lazily loaded bundle arrives after the HMR socket has closed.
 * - A changed module Fast Refresh cannot apply passes none. Metro's require polyfill
 *   (`performFullRefresh` in `metro-runtime/src/polyfills/require.js`) prefers
 *   `window.location.reload()` whenever it exists, and `@expo/metro-runtime` installs a
 *   native `window.location` whose `reload` calls `DevSettings.reload()` with no
 *   argument, so Metro's `No root boundary` / `Invalidated boundary` / `Dependency cycle`
 *   is lost. `Location.reload` is a non-writable property, so it cannot be wrapped instead.
 *
 * On Android the native `DevSettingsModule.reloadWithReason` discards the reason too, so
 * without this the only trace in logcat is the next `Running "main"`.
 *
 * This wraps `reload` on the shared `DevSettings` object. Callers look the method up on
 * that object at call time, so installing the wrap while index.js evaluates covers every
 * reload that can happen after boot. With a reason it prints `[reload] <reason>`; without
 * one it also prints the calling stack, which names the caller (`performFullRefresh` for
 * a Fast Refresh full reload). Reloads started natively (the dev menu's Reload, `r` in
 * the Metro terminal) do not pass through JS and print nothing.
 *
 * Logged with console.warn, which logcat shows as `W ReactNativeJS`.
 * See docs/reference-app-rn.md § Device test runs.
 */

import { DevSettings } from 'react-native';

function logReload(reason) {
	if (reason != null) {
		console.warn(`[reload] ${reason}`);
		return;
	}
	console.warn('[reload] (no reason given) caller:', new Error('reload caller').stack);
}

/* global __DEV__ */
if (__DEV__) {
	const reload = DevSettings.reload;
	DevSettings.reload = (reason) => {
		logReload(reason);
		reload.call(DevSettings, reason);
	};
}
