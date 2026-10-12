/**
 * recommended-by.ts — which Sereus app recommended this one (docs/architecture.md → "Recommending
 * another app"). Two hints name its scheme: the Android install referrer of an install from that
 * app's store link, and the `cadre-recommended-by` link it opens when this app is installed, which
 * `app/+native-intent.tsx` routes to Settings.
 *
 * Either hint is unverified: anyone can build a Play link with any referrer, and any app can open
 * this one with any link. A scheme counts only when this build's own list of other Sereus apps
 * names it, and the app is named from that list, never from the hint.
 */

import * as Application from 'expo-application';
import { recommendedBySchemeFromReferrer, type SereusApp } from '@serfab/cadre-rn/app-link';
import { otherSereusApps } from './join-link';

/** How long the first-launch question waits for the install referrer before it shows its plain form. */
export const REFERRER_WAIT_MS = 2000;

/**
 * The other Sereus app this build knows by exactly `scheme`; null, logged, for any other scheme,
 * this app's own included. `source` names the hint in the log. Never throws.
 */
export function recommendingApp(scheme: string, source: string): SereusApp | null {
	let app: SereusApp | undefined;
	try {
		app = otherSereusApps().find((candidate) => candidate.scheme === scheme);
	} catch (err) {
		// This build names no single scheme of its own, so it cannot leave itself out of the list.
		console.warn(`[recommended-by] could not list the other Sereus apps to check ${source}:`, err);
		return null;
	}
	// Quoted and cut: the hint is anyone's text, and a crafted one should not fill or forge log lines.
	if (!app) console.info(`[recommended-by] ${source} names ${JSON.stringify(scheme.slice(0, 64))}, not a known Sereus app; ignored`);
	return app ?? null;
}

/**
 * The app the Android install referrer names; null when the read fails (an install not from Play,
 * such as a development build, reads none), names no recommending app, or names one this build does
 * not know. Gives up after {@link REFERRER_WAIT_MS}, so a referrer that comes later is never used.
 * Android only: iOS has no install referrer. Never throws.
 */
export async function appFromInstallReferrer(): Promise<SereusApp | null> {
	const referrer = await readInstallReferrer();
	if (referrer === null) return null;
	const scheme = recommendedBySchemeFromReferrer(referrer);
	if (scheme === null) {
		console.info('[recommended-by] the install referrer names no recommending app');
		return null;
	}
	return recommendingApp(scheme, 'the install referrer');
}

async function readInstallReferrer(): Promise<string | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			console.info(`[recommended-by] the install referrer was not read within ${REFERRER_WAIT_MS} ms; reading it as none`);
			resolve(null);
		}, REFERRER_WAIT_MS);
	});
	try {
		return await Promise.race([Application.getInstallReferrerAsync(), gaveUp]);
	} catch (err) {
		console.info('[recommended-by] could not read the install referrer; reading it as none:', err);
		return null;
	} finally {
		clearTimeout(timer);
	}
}
