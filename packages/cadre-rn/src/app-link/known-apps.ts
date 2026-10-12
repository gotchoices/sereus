/**
 * The Sereus apps one app can open at their own URL scheme, and the lookup of which of them are
 * installed. iOS has no app chooser for a scheme several apps register, so an app asking to join
 * opens one owner app by that app's own scheme, chosen from this list.
 */

/** A Sereus app another can open at its own URL scheme. */
export interface SereusApp {
	/** The name the asking app shows in its list of owner apps. */
	name: string;
	/** The app's own custom URL scheme (`expo.scheme`), lowercase. */
	scheme: string;
	/** The app's Play application id, for its store page; absent while it is not on Play. */
	androidPackage?: string;
	/** The app's numeric App Store id, for its store page; absent while it is not on the App Store. */
	iosAppStoreId?: string;
}

/**
 * The Sereus apps the kit knows; one entry per published app. A new app is added here by a pull
 * request and a kit release; until then an app passes it as an extra (`appLinks.extraApps` in
 * the config plugin, and the `apps` argument of {@link installedSereusApps}).
 *
 * `app.plugin.cjs` keeps a copy (`withCadre.KNOWN_SEREUS_APPS`), because the CommonJS plugin
 * cannot load this ESM build; `test/app-link/app-link.spec.ts` keeps the two equal.
 */
export const KNOWN_SEREUS_APPS: readonly SereusApp[] = [
	{ name: 'Sereus P2P Chat', scheme: 'sereus-chat' },
];

/**
 * The apps in `apps` that `canOpenURL('<scheme>://')` reports installed, minus `ownScheme`, in
 * the order given and one per scheme. For iOS, where each queried scheme must be listed in
 * `LSApplicationQueriesSchemes`: React Native's `canOpenURL` rejects for a scheme that is not, and
 * such an app is counted as not installed, with one warning naming the schemes to add.
 */
export async function installedSereusApps(
	apps: readonly SereusApp[],
	ownScheme: string,
	canOpenURL: (url: string) => Promise<boolean>,
): Promise<SereusApp[]> {
	const candidates = oneAppPerScheme(apps).filter((app) => app.scheme !== ownScheme);
	const unqueryable: { scheme: string; error: unknown }[] = [];
	const installed = await Promise.all(candidates.map(async (app) => {
		try {
			return await canOpenURL(`${app.scheme}://`);
		} catch (error) {
			unqueryable.push({ scheme: app.scheme, error });
			return false;
		}
	}));
	if (unqueryable.length > 0) {
		console.warn(
			`[cadre-rn/app-link] canOpenURL refused ${unqueryable.map((entry) => entry.scheme).join(', ')}; ` +
			'add each to LSApplicationQueriesSchemes (the config plugin\'s appLinks.extraApps does)',
			unqueryable,
		);
	}
	return candidates.filter((_app, index) => installed[index]);
}

/** The first app listed for each scheme: the known list and an app's extras may name one twice. */
function oneAppPerScheme(apps: readonly SereusApp[]): SereusApp[] {
	const seen = new Set<string>();
	return apps.filter((app) => {
		if (seen.has(app.scheme)) return false;
		seen.add(app.scheme);
		return true;
	});
}
