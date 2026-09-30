import { describe, it, expect } from 'vitest';
import { normalizeSchemaText, readChatSimpleSchema } from '../../../test-harness/chat-simple-schema.js';
import { CHAT_SCHEMA } from '../src/chat-strand.js';

/**
 * The schema this app launches its chat strands with is a hand-kept copy of
 * `schemas/chat-simple.qsql`, as are the other reference apps' constants. A copy that
 * falls behind gives that app a different schema from the one the others run.
 */
describe('chat schema drift guard', () => {
	it('CHAT_SCHEMA matches schemas/chat-simple.qsql', async () => {
		expect(
			normalizeSchemaText(CHAT_SCHEMA),
			'CHAT_SCHEMA in packages/reference-app-rn/src/chat-strand.ts differs from schemas/chat-simple.qsql. ' +
				'Edit both so they match; comments, indentation and blank lines are ignored.'
		).toBe(await readChatSimpleSchema());
	});
});
