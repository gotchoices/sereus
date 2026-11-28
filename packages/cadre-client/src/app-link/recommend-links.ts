/**
 * What an owner app opens to recommend a Sereus app the user does not have yet: the app's store
 * page, which on Android names the recommending app in the install referrer. The recommended
 * app reads the referrer at first launch (`recommendedBySchemeFromReferrer`) to name the app that
 * recommended it and open it directly. For an app already installed the owner app opens
 * `recommendedByLink` (links.ts) instead.
 *
 * The scheme a referrer or a link carries is a hint, never trusted: anyone can build a Play link
 * with any referrer. The recommended app drops a scheme that is not on its own known-apps list,
 * and names the app from that list.
 */
import type { SereusApp } from './known-apps.js';

/** The install referrer an owner app's Play link carries, followed by the owner app's own scheme. */
export const RECOMMENDED_BY_REFERRER_PREFIX = 'sereus-recommended-by:1.';

/** The platforms with an app store a link can open; the app passes `Platform.OS`. */
export type StorePlatform = 'android' | 'ios';

/** `sereus-recommended-by:1.<ownScheme>`: the install referrer naming the recommending app. */
export function recommendedByReferrer(ownScheme: string): string {
	return `${RECOMMENDED_BY_REFERRER_PREFIX}${ownScheme}`;
}

/**
 * The recommending app's scheme when the install referrer is exactly the token an owner app's
 * store link carries, and null otherwise: an install no Sereus link started reads
 * `utm_source=google-play&utm_medium=organic`. Unverified: see the module comment.
 */
export function recommendedBySchemeFromReferrer(referrer: string): string | null {
	const trimmed = referrer.trim();
	if (!trimmed.startsWith(RECOMMENDED_BY_REFERRER_PREFIX)) return null;
	const scheme = trimmed.slice(RECOMMENDED_BY_REFERRER_PREFIX.length);
	return scheme.length > 0 ? scheme : null;
}

/**
 * The app's store page, or null when the app has no store id for `platform`. Android: its Play
 * page, with the install referrer naming `ownScheme`. iOS: its App Store page, with nothing about
 * the recommending app, since iOS has no install referrer.
 */
export function storePageLink(app: SereusApp, platform: StorePlatform, ownScheme: string): string | null {
	if (platform === 'android') {
		if (!app.androidPackage) return null;
		const referrer = encodeURIComponent(recommendedByReferrer(ownScheme));
		return `https://play.google.com/store/apps/details?id=${encodeURIComponent(app.androidPackage)}&referrer=${referrer}`;
	}
	return app.iosAppStoreId ? `https://apps.apple.com/app/id${app.iosAppStoreId}` : null;
}
