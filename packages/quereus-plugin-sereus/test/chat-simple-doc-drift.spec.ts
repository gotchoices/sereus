import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { normalizeSchemaText, readChatSimpleSchema } from '../../../test-harness/chat-simple-schema.js';
import { fencedBlocks } from './helpers/fenced-blocks.js';

/**
 * Drift guard for the copy of `schemas/chat-simple.qsql` printed in
 * `docs/reference-app-rn.md`. The three app constants are guarded by a
 * `chat-schema-drift.spec.ts` in each app; the document has no module to import from,
 * so its guard lives here, beside the other spec that reads fenced blocks out of `docs/`.
 */

const DOC_URL = new URL('../../../docs/reference-app-rn.md', import.meta.url);
const HEADING = 'Simplified Chat Schema';

describe('docs/reference-app-rn.md chat schema drift guard', () => {
	it(`the block under "${HEADING}" matches schemas/chat-simple.qsql`, async () => {
		const blocks = fencedBlocks(await readFile(DOC_URL, 'utf-8')).filter(b => b.heading === HEADING);
		// Exactly one, so renaming the heading or adding a second block fails instead of
		// leaving the schema block unchecked.
		expect(
			blocks.length,
			`docs/reference-app-rn.md must have exactly one fenced block directly under the "${HEADING}" heading`
		).toBe(1);

		expect(
			normalizeSchemaText(blocks[0].text),
			`The schema block under "${HEADING}" in docs/reference-app-rn.md differs from ` +
				'schemas/chat-simple.qsql. Edit both so they match; comments, indentation and blank lines are ignored.'
		).toBe(await readChatSimpleSchema());
	});
});
