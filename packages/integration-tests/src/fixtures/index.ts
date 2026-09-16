/**
 * Test fixtures for integration tests
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '..', '..', 'fixtures');

/**
 * Load the simple sApp app logic — the single source of truth for the realistic
 * signed-write RBAC fixture (see fixtures/simple-sapp.qsql).
 *
 * This is just the app logic; the runtime (StrandDatabase.executeSchema) wraps it
 * in `declare schema App { ... } apply schema App;` before applying, so callers feed
 * the returned string straight into an SAppConfig.schema.
 */
export async function loadSimpleSApp(): Promise<string> {
  return readFile(resolve(fixturesDir, 'simple-sapp.qsql'), 'utf-8');
}

/**
 * Load `schemas/chat-simple.qsql` — the chat schema the reference apps run — from its
 * canonical copy at the repo root, so a scenario exercises the real schema rather than
 * a hand-kept duplicate. A bare table list: feed it straight into an SAppConfig.schema.
 */
export async function loadChatSimpleSchema(): Promise<string> {
  return readFile(resolve(fixturesDir, '..', '..', '..', 'schemas', 'chat-simple.qsql'), 'utf-8');
}

/**
 * Even simpler app logic for basic connectivity tests
 */
export const MINIMAL_SAPP_LOGIC = `
table Data (
    Key text primary key,
    Val text
);
`.trim();
