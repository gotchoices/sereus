/**
 * `join-failure.ts` — which words the "Join failed" alert shows for each class of
 * error `CadreNode.redeemCadreInvitation` throws. The error classes are the real
 * ones from `@serfab/cadre-core`, so an `instanceof` that stops matching (a class
 * renamed or no longer exported) fails here rather than on a phone.
 */
import { describe, it, expect } from 'vitest';
import {
	CadreInviteRejectedError,
	CadreInviteReplyInvalidError,
	CadreInviteUnreachableError,
} from '@serfab/cadre-core';
import { describeJoinFailure } from '../src/join-failure';

describe('describeJoinFailure', () => {
	it.each<[string, unknown, string | RegExp]>([
		['a refusal the member explained by code', new CadreInviteRejectedError('invite-spent', 'expired'), /expired, withdrawn or used up/],
		['a refusal code this build does not know', new CadreInviteRejectedError('something-new', 'x'), /try again/],
		['no member reachable', new CadreInviteUnreachableError([]), /could be reached/],
		['an acceptance that did not verify', new CadreInviteReplyInvalidError('row signed by a stranger'), /did not verify/],
		['a precondition failure', new Error('Node not started'), 'Node not started'],
		['something thrown that is not an Error', 'boom', 'boom'],
	])('describes %s', (_label, err, expected) => {
		expect(describeJoinFailure(err)).toMatch(expected);
	});
});
