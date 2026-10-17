/**
 * web-join.ts — this tab's join request, and the check of pasted join text before the edge node
 * joins the cadre it names (`store.svelte.ts` → `joinCadre`; docs/architecture.md → "An app joins
 * an existing cadre"). The text is a machine invitation or an owner grant, which makes the tab an
 * owner too. The join itself, the strand move and the dissolve of the party left are
 * `@serfab/cadre-core/edge-node`'s.
 */
import { decodeCadreInvitation, decodeOwnerGrant, encodeCadreJoinRequest } from '@serfab/cadre-core';
import type { JoinCredential } from '@serfab/cadre-core/edge-node';
import { getCadreNode } from './cadre-web.js';
import { isOwnerGrantText } from './owner-grants.js';

/** The name this tab gives in its join request, for the owner's approval prompt. */
export const WEB_APP_NAME = 'Sereus web reference';

/** The words the page shows for a response the owner app made from another app's request. */
const RESPONSE_FOR_ANOTHER_APP = 'This response was made for another app. Copy this tab’s request again and ask for a new one.';

/** The join request this tab shows under "Join my existing cadre": its peer id and name. */
export function joinRequestText(): string {
	return encodeCadreJoinRequest({ v: 1, peerId: requirePeerId(), appName: WEB_APP_NAME });
}

/**
 * Decode pasted join text as the credential it is: an owner grant by its prefix, else a machine
 * invitation, whose decoder names every other kind of text (an owner key, a join request). An
 * invitation targeted at another peer id is refused before anything stops: the members would
 * refuse it too, but only after this tab had left its own cadre to ask. An owner grant names no app.
 */
export function decodeCredentialForThisTab(encoded: string): JoinCredential {
	if (isOwnerGrantText(encoded)) return decodeOwnerGrant(encoded);
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
