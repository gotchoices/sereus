/**
 * join-link.ts — the answer to a join request another Sereus app on this phone opened this app
 * with (docs/architecture.md → "Between apps on one phone"): this app opens the asking app back
 * at the scheme the request's `reply` names.
 *
 * The answer link carries the invitation, which holds its private key and the cadre's machine
 * addresses: log the asking app's name and the outcome, never the link.
 */

import { Linking } from 'react-native';
import type { CadreJoinReply, CadreJoinRequest } from '@serfab/cadre-core';
import { CADRE_JOIN_RESPONSE_PREFIX, joinResponseLink, type JoinRefusal } from '@serfab/cadre-rn/app-link';
import { ownAppName } from './cadre-phone';

/** A join request that names where to answer it. Only one that arrived as a link is ever answered. */
export type AnswerableJoinRequest = CadreJoinRequest & { reply: CadreJoinReply };

/** What goes back: the minted invitation's text, or why there is none. */
export type JoinAnswer = { invitation: string } | { refused: JoinRefusal };

/** Why this app does not answer its own request, pasted or opened as a link. */
export const OWN_REQUEST_LINE = 'This is this app\'s own request. Open the other app and copy its request there.';

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
		console.warn(`[settings] could not send ${what} to ${request.appName}: ${withoutResponseText(err)}`);
		return false;
	}
}

/** The error's text with the response's body cut wherever it is repeated: React Native's `openURL` rejection names the URL. */
function withoutResponseText(err: unknown): string {
	const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
	const [head, ...afterPrefix] = message.split(CADRE_JOIN_RESPONSE_PREFIX);
	return [head, ...afterPrefix.map((part) => part.replace(/^[A-Za-z0-9_-]*/, '…'))].join(CADRE_JOIN_RESPONSE_PREFIX);
}
