/**
 * What `EdgeNode.joinCadre` takes: a machine invitation, which admits the app as a machine, or an
 * owner grant, which makes it a machine and an owner at once (docs/architecture.md → "An app
 * joins an existing cadre"). Both name the party; the codecs refuse each other's text by name,
 * so an app's one join field decodes whichever was pasted.
 */

import type { CadreInvitation } from '../cadre-invite-protocol.js';
import type { OwnerGrantBundle } from '../owner-grant-protocol.js';

export type JoinCredential = CadreInvitation | OwnerGrantBundle;

/** The bundle's private half tells the two apart: a grant carries `grantPrivateKey`, an invitation `invitePrivateKey`. */
export function isOwnerGrant(credential: JoinCredential): credential is OwnerGrantBundle {
	return 'grantPrivateKey' in credential;
}
