/**
 * The app config: `app.json`, plus the kit's config plugin with the Sereus apps this build knows
 * beyond the kit's own list, and, under `APP_VARIANT=second`, a second install of this app.
 *
 * The second install has its own name, URL scheme and package, so it is a separate app to the
 * phone, with its own identity and storage: two Sereus apps on one phone, for trying the join by
 * link (docs/reference-app-rn.md → "Joining an Existing Cadre") on a single device.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';

const SECOND_INSTALL = { name: 'Sereus P2P Chat (second)', scheme: 'sereus-chat-second' };

/**
 * Sereus apps not in the kit's `KNOWN_SEREUS_APPS` (which has the main install). One list, given
 * both to the kit's config plugin (the iOS schemes it may query) and to the app at run time
 * (`extra.sereusApps`, read by `extraSereusApps` in `src/cadre-phone.ts`).
 */
const EXTRA_SEREUS_APPS = [SECOND_INSTALL];

export default ({ config }: ConfigContext): ExpoConfig => {
	const app: ExpoConfig = {
		...config,
		name: required(config.name, 'name'),
		slug: required(config.slug, 'slug'),
		plugins: [...(config.plugins ?? []), ['@serfab/cadre-rn', { appLinks: { extraApps: EXTRA_SEREUS_APPS } }]],
		extra: { ...config.extra, sereusApps: EXTRA_SEREUS_APPS },
	};
	return process.env.APP_VARIANT === 'second' ? secondInstall(app) : app;
};

function secondInstall(app: ExpoConfig): ExpoConfig {
	return {
		...app,
		name: SECOND_INSTALL.name,
		scheme: SECOND_INSTALL.scheme,
		ios: { ...app.ios, bundleIdentifier: `${required(app.ios?.bundleIdentifier, 'ios.bundleIdentifier')}.second` },
		android: { ...app.android, package: `${required(app.android?.package, 'android.package')}.second` },
	};
}

function required(value: string | undefined, field: string): string {
	if (!value) throw new Error(`app.json must set expo.${field}`);
	return value;
}
