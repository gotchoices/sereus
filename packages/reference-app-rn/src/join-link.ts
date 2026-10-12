/**
 * join-link.ts — the links this app and another Sereus app on this phone open each other with
 * (docs/architecture.md → "Between apps on one phone"). As the owner app, it answers a join request
 * by opening the asking app back at the scheme the request's `reply` names, and opens an app it
 * recommends, or that app's store page. As the asking app, it opens an owner app with its own
 * request, and puts the answer that comes back into words.
 *
 * The answer link carries the invitation, which holds its private key and the cadre's machine
 * addresses, and the request link the nonce the answer must match: log the other app's name and
 * the outcome, never either link. A recommending link names only the two apps and may be logged.
 */

import { Linking, Platform } from 'react-native';
import { CADRE_JOIN_REQUEST_PREFIX, type CadreJoinReply, type CadreJoinRequest } from '@serfab/cadre-core';
import {
	CADRE_JOIN_RESPONSE_PREFIX,
	installedSereusApps,
	joinRequestLink,
	joinResponseLink,
	KNOWN_SEREUS_APPS,
	recommendedByLink,
	storePageLink,
	type JoinRefusal,
	type SereusApp,
} from '@serfab/cadre-rn/app-link';
import { extraSereusApps, ownAppName, ownScheme } from './cadre-phone';
import { joinFailureAlert } from './join-failure';
import type { JoinResponseOutcome } from './use-link-request';

/** A join request that names where to answer it. Only one that arrived as a link is ever answered. */
export type AnswerableJoinRequest = CadreJoinRequest & { reply: CadreJoinReply };

/** What goes back: the minted invitation's text, or why there is none. */
export type JoinAnswer = { invitation: string } | { refused: JoinRefusal };

/** A Sereus app this app can recommend, and the link that opens it (installed) or its store page. */
export interface RecommendableApp {
	app: SereusApp;
	installed: boolean;
	link: string;
}

/** Why this app does not answer its own request when it is pasted. */
export const OWN_REQUEST_LINE = 'This is this app\'s own request. Open the other app and copy its request there.';

/** The way in when no owner app can be opened. */
export const COPY_REQUEST_LINE = 'Copy this app\'s request into the app that holds your cadre.';

/** Each refusal an owner app can answer with, naming that app. */
const REFUSAL_TEXT: Record<JoinRefusal, (app: string) => string> = {
	denied: (app) => `${app} did not allow this app to join. You can still copy this app's request into it.`,
	'no-cadre': (app) => `${app} has no cadre yet. Open the app that holds your cadre. You can still copy this app's request into it.`,
	'not-owner': (app) => `${app} is a member of your cadre, not an owner. Open an owner app. You can still copy this app's request into it.`,
	// No copy line: that app answers a copied request the same way.
	'already-member': (app) => `This app is already in the cadre ${app} holds.`,
};

export function isAnswerable(request: CadreJoinRequest): request is AnswerableJoinRequest {
	return request.reply !== undefined;
}

/**
 * Open the asking app with `answer`. False when the link was too long to build or the system
 * would not open it (the app was uninstalled meanwhile, say); the caller then shows the
 * invitation for copying. Never throws.
 */
export async function answerJoinRequest(request: AnswerableJoinRequest, answer: JoinAnswer): Promise<boolean> {
	const what = 'invitation' in answer ? 'an invitation' : `the refusal ${answer.refused}`;
	try {
		await Linking.openURL(joinResponseLink(request.reply, { v: 1, nonce: request.reply.nonce, appName: ownAppName(), ...answer }));
		console.info(`[settings] sent ${what} to ${request.appName}`);
		return true;
	} catch (err) {
		console.warn(`[settings] could not send ${what} to ${request.appName}: ${withoutLinkText(err, CADRE_JOIN_RESPONSE_PREFIX)}`);
		return false;
	}
}

/**
 * The other Sereus apps this build knows: the kit's known apps and this build's extras, the first
 * listed for each scheme, this app left out.
 */
export function otherSereusApps(): SereusApp[] {
	const seen = new Set([ownScheme()]);
	return [...KNOWN_SEREUS_APPS, ...extraSereusApps()].filter((app) => {
		if (seen.has(app.scheme)) return false;
		seen.add(app.scheme);
		return true;
	});
}

/**
 * The other Sereus apps on this phone this app can open with its request, for iOS, which has no
 * chooser: those of {@link otherSereusApps} that `canOpenURL` reports installed.
 */
export function installedOwnerApps(): Promise<SereusApp[]> {
	return installedAmong(otherSereusApps());
}

/**
 * The other Sereus apps this app can recommend: each installed one, to open, and each other one
 * with a store page on this platform, to get.
 */
export async function recommendableApps(): Promise<RecommendableApp[]> {
	const others = otherSereusApps();
	const installed = new Set((await installedAmong(others)).map((app) => app.scheme));
	return others.flatMap((app) => {
		const isInstalled = installed.has(app.scheme);
		const link = isInstalled ? recommendedByLink(app, ownScheme()) : storePage(app);
		return link === null ? [] : [{ app, installed: isInstalled, link }];
	});
}

/** Open a recommended app, or its store page. False when the system would not open it; never throws. */
export async function openRecommendedApp({ app, installed, link }: RecommendableApp): Promise<boolean> {
	const what = installed ? app.name : `the store page of ${app.name}`;
	try {
		await Linking.openURL(link);
		console.info(`[settings] opened ${what}`);
		return true;
	} catch (err) {
		console.warn(`[settings] could not open ${what}:`, err);
		return false;
	}
}

function installedAmong(apps: readonly SereusApp[]): Promise<SereusApp[]> {
	// Wrapped: React Native's `canOpenURL` reads `this`.
	return installedSereusApps(apps, ownScheme(), (url) => Linking.canOpenURL(url));
}

/** The app's store page; null on a platform with no store the kit links to, or when the app has no id there. */
function storePage(app: SereusApp): string | null {
	return Platform.OS === 'android' || Platform.OS === 'ios' ? storePageLink(app, Platform.OS, ownScheme()) : null;
}

/**
 * Open an owner app with this app's join request: `app` at its own scheme (iOS), or with null
 * whichever app Android's chooser offers, this one included. False when the system would not open
 * it; never throws.
 */
export async function openOwnerApp(requestText: string, app: SereusApp | null): Promise<boolean> {
	const which = app?.name ?? 'the app chooser';
	try {
		await Linking.openURL(joinRequestLink(requestText, app));
		console.info(`[settings] opened ${which} with this app's join request`);
		return true;
	} catch (err) {
		console.warn(`[settings] could not open ${which} with this app's join request: ${withoutLinkText(err, CADRE_JOIN_REQUEST_PREFIX)}`);
		return false;
	}
}

/** The alert for what became of an answer an owner app opened this app with; null when the join ran, since its steps show in the section. */
export function joinResponseAlert(outcome: JoinResponseOutcome): { title: string; message: string; detail?: string } | null {
	switch (outcome.kind) {
		case 'joined':
			return null;
		case 'join-failed':
			return joinFailureAlert(outcome.error);
		case 'refused':
			return { title: 'Not joined', message: REFUSAL_TEXT[outcome.refusal](outcome.appName) };
		case 'join-under-way':
			return {
				title: 'A join is already under way',
				message: 'The other app\'s answer was not used. Finish the join on screen first; to join through that app instead, choose it again.',
			};
		case 'unsolicited':
			return { title: 'Cannot use this answer', message: 'This answer was not for a request this app has open.' };
		case 'unreadable':
			return { title: 'Cannot use this answer', message: 'This app could not take this answer.', detail: outcome.error };
	}
}

/**
 * The error's text with a link's body cut wherever it is repeated after `prefix`: React Native's
 * `openURL` rejection names the URL.
 */
function withoutLinkText(err: unknown, prefix: string): string {
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	const [head, ...afterPrefix] = message.split(prefix);
	return [head, ...afterPrefix.map((part) => part.replace(/^[A-Za-z0-9_-]*/, '…'))].join(prefix);
}
