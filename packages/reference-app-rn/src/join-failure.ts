/**
 * join-failure.ts — the plain words the alert shows for each way a join can fail before a
 * member admits the app: `CadreNode.redeemCadreInvitation`'s errors, an owner grant's
 * (`owner-keys.ts` words those, since Owner keys shows them too), and the kit's refusals before
 * it switches party.
 *
 * reference-app-ns carries a hand-copied twin (`src/join-failure.ts` there), without the
 * cancelled-join alert, since it offers no cancel; the two apps share no code by design
 * (docs/reference-app-ns.md).
 */

import {
  CadreInviteRejectedError,
  CadreInviteReplyInvalidError,
  CadreInviteUnreachableError,
} from '@serfab/cadre-core';
import { StrandsNeedOwnerJoinError } from '@serfab/cadre-rn/phone-node';
import { chats, JoinCancelledError } from './join-flow';
import { describeOwnerGrantFailure } from './owner-keys';

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
  if (err instanceof StrandsNeedOwnerJoinError) {
    // No strands means pending joins or invitations only.
    const held = err.strandCount > 0 ? `this app's ${chats(err.strandCount)}` : 'what this app\'s own cadre holds';
    return `This invitation makes the app a member, and only an owner can bring ${held} along. In the app that holds your cadre, make an owner grant under Owner keys → Add an owner key, and paste it here.`;
  }
  return describeOwnerGrantFailure(err) ?? (err instanceof Error ? err.message : String(err));
}

/** The alert for a join that did not happen: the user cancelled it, or it failed. */
export function joinFailureAlert(err: unknown): { title: string; message: string } {
  if (err instanceof JoinCancelledError) return { title: 'Join cancelled', message: 'This app is back in its own cadre.' };
  return { title: 'Join failed', message: describeJoinFailure(err) };
}
