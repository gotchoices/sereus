/**
 * use-recommending-app.ts — Settings' part of joining the app that recommended this one: which app
 * the first-launch question names, and which the prompt offers while this app has a cadre
 * (docs/reference-app-rn.md → "Joining an Existing Cadre").
 */

import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { SereusApp } from '@serfab/cadre-rn/app-link';
import { appFromInstallReferrer, recommendingApp } from './recommended-by';

/** The Sereus app that recommended this one, as the Node card and Settings' prompt use it. */
export interface RecommendingApp {
	/** The app the first-launch question names; null for the plain question. */
	named: SereusApp | null;
	/** The install referrer is still being read and no link named an app, so the first-launch question waits. */
	reading: boolean;
	/** Other choices: the plain question, until another link names an app. */
	dropNamed: () => void;
	/** The app a link named while this app has a cadre, for the prompt; null while none is offered. */
	suggested: SereusApp | null;
	dropSuggested: () => void;
}

type ReferrerRead = 'pending' | SereusApp | null;

/**
 * Which Sereus app recommended this one (`src/recommended-by.ts`), from two hints.
 *
 * The Android install referrer is read once per mount, the first time `asking` is true, and names
 * the app in the first-launch question, which waits for it at most `REFERRER_WAIT_MS`.
 *
 * A `cadre-recommended-by` link (`app/+native-intent.tsx` routes it to Settings as the
 * `recommendedBy` parameter, cleared as soon as it is read, as Settings' other linked parameters
 * are) wins over the referrer, as the user's latest action. While `asking` it names the app in the
 * question, which shows again from the top (`onNamed`). Otherwise it waits until `settled`, then
 * opens the prompt, unless `joinUnderWay`: the request or join already on screen wins, and the link
 * is dropped.
 */
export function useRecommendingApp(asking: boolean, settled: boolean, joinUnderWay: boolean, onNamed: () => void): RecommendingApp {
	const { recommendedBy } = useLocalSearchParams<{ recommendedBy?: string }>();
	const router = useRouter();
	const [referrer, setReferrer] = useState<ReferrerRead>(Platform.OS === 'android' ? 'pending' : null);
	const referrerAsked = useRef(false);
	const [linked, setLinked] = useState<SereusApp | null>(null);
	const [linkNamed, setLinkNamed] = useState<SereusApp | null>(null);
	const [dropped, setDropped] = useState(false);
	const [suggested, setSuggested] = useState<SereusApp | null>(null);

	useEffect(() => {
		if (!asking || referrerAsked.current || Platform.OS !== 'android') return;
		referrerAsked.current = true;
		void appFromInstallReferrer().then(setReferrer);
	}, [asking]);

	useEffect(() => {
		if (typeof recommendedBy !== 'string' || !recommendedBy) return;
		router.setParams({ recommendedBy: undefined });
		setLinked(recommendingApp(recommendedBy, 'a recommended-by link'));
	}, [recommendedBy, router]);

	useEffect(() => {
		if (!linked || !settled) return;
		setLinked(null);
		if (asking) {
			setLinkNamed(linked);
			setDropped(false);
			onNamed();
		} else if (joinUnderWay) {
			console.info(`[settings] ${linked.name} suggested joining the cadre it holds while a request to join or a join is under way; ignored`);
		} else {
			// NOTE: a join that starts while the prompt is open (a response to a request opened just
			// before) leaves the prompt up, and its Join is then refused as a join under way; if that
			// is ever seen, drop `suggested` when `joinUnderWay` turns true.
			setSuggested(linked);
		}
	}, [linked, settled, asking, joinUnderWay]);

	const fromReferrer = referrer === 'pending' ? null : referrer;
	return {
		named: dropped ? null : linkNamed ?? fromReferrer,
		reading: !dropped && linkNamed === null && referrer === 'pending',
		dropNamed: () => setDropped(true),
		suggested,
		dropSuggested: () => setSuggested(null),
	};
}
