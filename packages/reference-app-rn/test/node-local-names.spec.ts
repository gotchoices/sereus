/**
 * `node-local-names.ts` — the names installed phones' node-local records are filed
 * under. Renaming any of them orphans those records, so each is pinned.
 */
import { describe, it, expect } from 'vitest';
import { NODE_LOCAL_DB_NAME, NODE_LOCAL_KV_PREFIX, START_OPTIONS_KV_KEY, STORAGE_PREFIX } from '../src/node-local-names';

describe('node-local names', () => {
	it('pins the storage prefix, database name, kv prefix and start-options key', () => {
		expect(STORAGE_PREFIX).toBe('sereus-');
		expect(NODE_LOCAL_DB_NAME).toBe('sereus-node-local');
		expect(NODE_LOCAL_KV_PREFIX).toBe('sereus:node-local:');
		expect(START_OPTIONS_KV_KEY).toBe('start-options');
	});
});
