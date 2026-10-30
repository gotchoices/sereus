import { describe, it, expect } from 'vitest';
import { describeThrown } from '../src/describe-thrown.js';

describe('describeThrown', () => {
	it('gives an Error its message unchanged', () => {
		expect(describeThrown(new TypeError('dial failed'))).toBe('dial failed');
		expect(describeThrown(new Error('outer', { cause: new Error('inner') }))).toBe('outer');
	});

	it('reads the fields of a WebSocket event or a plain-object rejection', () => {
		expect(describeThrown({ type: 'error', message: 'Failed to connect to relay.sereus.org/4011', isTrusted: false }))
			.toBe('error: Failed to connect to relay.sereus.org/4011');
		expect(describeThrown({ type: 'close', code: 1006, reason: '' })).toBe('close (code 1006)');
		expect(describeThrown({ code: 'ERR_TIMEOUT' })).toBe('code ERR_TIMEOUT');
	});

	it('falls back to JSON for an object with no known fields, skipping fields that are not strings', () => {
		expect(describeThrown({ status: 503 })).toBe('{"status":503}');
		expect(describeThrown({ message: { text: 'nested' } })).toBe('{"message":{"text":"nested"}}');
	});

	it('falls back to String() when JSON says nothing or cannot be made', () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(describeThrown(cyclic)).toBe('[object Object]');
		expect(describeThrown({})).toBe('[object Object]');
	});

	it('cuts a huge object description short', () => {
		const described = describeThrown({ detail: 'x'.repeat(10_000) });
		expect(described).toHaveLength(500);
		expect(described.endsWith('…')).toBe(true);
	});

	it('gives a primitive its String() text', () => {
		expect(describeThrown('plain text')).toBe('plain text');
		expect(describeThrown(42)).toBe('42');
		expect(describeThrown(undefined)).toBe('undefined');
		expect(describeThrown(null)).toBe('null');
	});
});
