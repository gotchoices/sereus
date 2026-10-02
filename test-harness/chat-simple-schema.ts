/**
 * Comparison of the hand-kept copies of `schemas/chat-simple.qsql` against the file.
 *
 * The reference apps embed the schema as a string constant (a React Native bundle cannot
 * read a `.qsql` file from disk) and `docs/reference-app-rn.md` prints it. Each copy has
 * a spec that registers `describeChatSchemaCopy` for it:
 *   - `packages/reference-app-rn/test/chat-schema-drift.spec.ts`
 *   - `packages/reference-app-web/test/chat-schema-drift.spec.ts`
 *   - `packages/reference-app-ns/test/chat-schema-drift.spec.ts`
 *   - `packages/quereus-plugin-sereus/test/chat-simple-doc-drift.spec.ts` (the document)
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripSqlComments } from './qsql-body.js';

// A path, not a `URL`: the apps' type-check programs include the DOM lib, whose global
// `URL` is not the `node:url` one `readFile` accepts.
const CHAT_SIMPLE_QSQL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'chat-simple.qsql');

/**
 * The form in which two copies of a schema must be identical: comments removed, CRLF
 * read as LF, each line trimmed of leading and trailing spaces and tabs, empty lines
 * dropped. Comments are ignored because the file, the code copies and the document each
 * carry different ones.
 *
 * Interior whitespace, letter case and the line a token sits on all stay significant, so
 * a reformat that moves a token to another line fails. That false positive is accepted
 * in exchange for a normalization too simple to hide a real difference.
 */
function normalizeSchemaText(text: string): string {
	return stripSqlComments(text)
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(line => line.replace(/^[ \t]+|[ \t]+$/g, ''))
		.filter(line => line.length > 0)
		.join('\n');
}

/** `schemas/chat-simple.qsql`, normalized. Rejects if the file is missing. */
async function readChatSimpleSchema(): Promise<string> {
	return normalizeSchemaText(await readFile(CHAT_SIMPLE_QSQL_PATH, 'utf-8'));
}

/**
 * Registers the guard for one copy. `where` names the copy in the test title and the
 * failure message; `readCopy` returns its text, and may throw when the copy cannot be
 * located. The await lives here rather than in each spec because `test/` trees are not
 * linted for floating promises, and an unawaited assertion would pass.
 */
export function describeChatSchemaCopy(where: string, readCopy: () => string | Promise<string>): void {
	describe('chat schema drift guard', () => {
		it(`${where} matches schemas/chat-simple.qsql`, async () => {
			expect(
				normalizeSchemaText(await readCopy()),
				`${where} differs from schemas/chat-simple.qsql. ` +
					'Edit both so they match; comments, indentation and blank lines are ignored.'
			).toBe(await readChatSimpleSchema());
		});
	});
}
