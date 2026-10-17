/**
 * web-join.ts — this tab's join request, and the check of a pasted invitation before the edge
 * node joins the cadre it names (`store.svelte.ts` → `joinCadre`; docs/architecture.md → "An app
 * joins an existing cadre"). The join itself, the strand move and the dissolve of the party left
 * are `@serfab/cadre-core/edge-node`'s.
 */
import { decodeCadreInvitation, encodeCadreJoinRequest, type CadreInvitation } from '@serfab/cadre-core';
import { getCadreNode } from './cadre-web.js';

/** The name this tab gives in its join request, for the owner's approval prompt. */
export const WEB_APP_NAME = 'Sereus web reference';

/** The words the page shows for a response the owner app made from another app's request. */
const RESPONSE_FOR_ANOTHER_APP = 'This response was made for another app. Copy this tab’s request again and ask for a new one.';

/** The join request this tab shows under "Join my existing cadre": its peer id and name. */
export function joinRequestText(): string {
	return encodeCadreJoinRequest({ v: 1, peerId: requirePeerId(), appName: WEB_APP_NAME });
}

/**
 * Decode a pasted invitation, refusing one targeted at another peer id before anything
 * stops: the members would refuse it too, but only after this tab had left its own cadre to ask.
 */
export function decodeInvitationForThisTab(encoded: string): CadreInvitation {
	const peerId = requirePeerId();
	const invitation = decodeCadreInvitation(encoded);
	const target = invitation.invite.peerId;
	if (target && target !== peerId) throw new Error(RESPONSE_FOR_ANOTHER_APP);
	return invitation;
}

function requirePeerId(): string {
	const peerId = getCadreNode()?.peerId?.toString();
	if (!peerId) throw new Error('CadreNode not started');
	return peerId;
}
