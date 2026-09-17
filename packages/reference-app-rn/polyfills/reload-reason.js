/**
 * Logs why the app is about to reload (development builds only).
 *
 * Every JS-initiated reload in a development build goes through
 * `DevSettings.reload(reason)`: React Refresh's full refresh (`No root boundary`,
 * `Invalidated boundary`, `Dependency cycle`) from `Libraries/Core/setUpReactRefresh.js`,
 * and `Bundle Splitting – Metro disconnected` from `Libraries/Utilities/HMRClient.js`
 * when a lazily loaded bundle arrives after the HMR socket has closed. On Android the
 * native `DevSettingsModule.reloadWithReason` discards the reason, so without this the
 * only trace in logcat is the next `Running "main"`.
 *
 * This wraps `reload` on the shared `DevSettings` object to print `[reload] <reason>`
 * first. Both callers look the method up on that object at call time, so installing
 * the wrap while index.js evaluates covers every reload that can happen after boot.
 * Reloads started natively (the dev menu's Reload, `r` in the Metro terminal) do not
 * pass through JS and print nothing.
 *
 * Logged with console.warn, which logcat shows as `W ReactNativeJS`.
 * See docs/reference-app-rn.md § Device test runs.
 */

import { DevSettings } from 'react-native';

/* global __DEV__ */
if (__DEV__) {
	const reload = DevSettings.reload;
	DevSettings.reload = (reason) => {
		console.warn(`[reload] ${reason ?? '(no reason given)'}`);
		reload.call(DevSettings, reason);
	};
}
