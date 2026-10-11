/**
 * `join-failure.ts` — which words the "Join failed" alert shows for each class of
 * error `CadreNode.redeemCadreInvitation` and the phone kit's `joinCadre` throw. The
 * error classes are the real ones from `@serfab/cadre-core` and `@serfab/cadre-rn`, so
 * an `instanceof` that stops matching (a class renamed or no longer exported) fails
 * here rather than on a phone.
 */
import { describe, it, expect } from 'vitest';
import {
	CadreInviteRejectedError,
	CadreInviteReplyInvalidError,
	CadreInviteUnreachableError,
	type StrandBundle,
} from '@serfab/cadre-core';
import { StrandsNeedOwnerJoinError } from '@serfab/cadre-rn/phone-node';
import { describeJoinFailure } from '../src/join-failure';

describe('describeJoinFailure', () => {
	it.each<[string, unknown, string | RegExp]>([
		['a refusal the member explained by code', new CadreInviteRejectedError('invite-spent', 'expired'), /expired, withdrawn or used up/],
		['a refusal code this build does not know', new CadreInviteRejectedError('something-new', 'x'), /try again/],
		['no member reachable', new CadreInviteUnreachableError([]), /could be reached/],
		['an acceptance that did not verify', new CadreInviteReplyInvalidError('row signed by a stranger'), /did not verify/],
		['a member invitation while the app holds chats', new StrandsNeedOwnerJoinError(bundleOf(2), 'party-a'), /bring this app's 2 chats along/],
		['a precondition failure', new Error('Node not started'), 'Node not started'],
		['something thrown that is not an Error', 'boom', 'boom'],
	])('describes %s', (_label, err, expected) => {
		expect(describeJoinFailure(err)).toMatch(expected);
	});
});

/** A bundle of `strands` strands; the error reads only the lists' lengths and the party id. */
function bundleOf(strands: number): StrandBundle {
	return { v: 1, partyId: 'party-b', strands: new Array(strands).fill({}), pendingJoins: [], formationInvites: [] } as unknown as StrandBundle;
}
