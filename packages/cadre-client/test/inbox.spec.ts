import { describe, expect, it } from 'vitest';
import { nodeCodeInbox } from '../src/inbox.js';

describe('nodeCodeInbox', () => {
	it('holds the latest node code offered, until taken', () => {
		const inbox = nodeCodeInbox();
		const seen: Array<string | null> = [];
		inbox.pending.subscribe(v => seen.push(v));
		expect(inbox.offer('https://example.com/nothing')).toBe(false);
		expect(inbox.offer('sereus-join:1.first')).toBe(true);
		expect(inbox.offer('https://sereus.org/node#sereus-join:1.second')).toBe(true);
		expect(inbox.take()).toBe('sereus-join:1.second');
		expect(inbox.take()).toBeNull();
		expect(seen).toEqual([null, 'sereus-join:1.first', 'sereus-join:1.second', null]);
	});
});
