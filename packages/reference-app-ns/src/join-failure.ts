/**
 * join-failure.ts — the plain words the "Join cadre" modal shows for each way
 * `CadreNode.redeemCadreInvitation` can fail.
 *
 * A hand-copied twin of reference-app-rn's `src/join-failure.ts`; the two apps
 * share no code by design (docs/reference-app-ns.md).
 */

import {
	CadreInviteRejectedError,
	CadreInviteReplyInvalidError,
	CadreInviteUnreachableError,
} from '@serfab/cadre-core';

const TRY_AGAIN = 'The member could not complete the join right now; try again';

/**
 * One line per rejection code the member can answer with. Keyed by the error's own
 * `code` type, so a code added to cadre-core fails typecheck here until it has words.
 */
const REJECTION_TEXT: Record<CadreInviteRejectedError['code'], string> = {
	'invite-spent': 'This invitation is expired, withdrawn or used up',
	'invite-invalid': 'This invitation is not valid for this device',
	'party-mismatch': 'That member serves a different cadre',
	'issuer-unknown': 'That member does not know the owner who issued this invitation yet; try again shortly',
	busy: TRY_AGAIN,
	conflict: TRY_AGAIN,
	internal: TRY_AGAIN,
	unrecognized: TRY_AGAIN,
};

/** What to tell the person holding the phone about `err`, thrown by a join attempt. */
export function describeJoinFailure(err: unknown): string {
	if (err instanceof CadreInviteRejectedError) return REJECTION_TEXT[err.code];
	if (err instanceof CadreInviteUnreachableError) return 'No member named in the invitation could be reached';
	if (err instanceof CadreInviteReplyInvalidError) return 'A member answered, but its answer did not verify';
	return err instanceof Error ? err.message : String(err);
}
