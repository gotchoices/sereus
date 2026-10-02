import { expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { describeChatSchemaCopy } from '../../../test-harness/chat-simple-schema.js';
import { fencedBlocks } from './helpers/fenced-blocks.js';

/**
 * Drift guard for the copy of `schemas/chat-simple.qsql` printed in
 * `docs/reference-app-rn.md`. The three app constants are guarded by a
 * `chat-schema-drift.spec.ts` in each app; the document has no module to import from,
 * so its guard lives here, beside the other spec that reads fenced blocks out of `docs/`.
 */

const DOC_URL = new URL('../../../docs/reference-app-rn.md', import.meta.url);
const HEADING = 'Simplified Chat Schema';

async function readDocumentBlock(): Promise<string> {
	const blocks = fencedBlocks(await readFile(DOC_URL, 'utf-8')).filter(b => b.heading === HEADING);
	// Exactly one, so renaming the heading or adding a second block fails instead of
	// leaving the schema block unchecked.
	expect(
		blocks.length,
		`docs/reference-app-rn.md must have exactly one fenced block directly under the "${HEADING}" heading`
	).toBe(1);
	return blocks[0].text;
}

describeChatSchemaCopy(`The block under "${HEADING}" in docs/reference-app-rn.md`, readDocumentBlock);
