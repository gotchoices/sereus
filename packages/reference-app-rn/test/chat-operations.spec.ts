import { describe, it, expect } from 'vitest';
import { parseStoredDatetime } from '../src/chat-operations.js';

/**
 * A `datetime` column reads back without a zone, and `new Date()` treats a zone-less
 * date-time as local time — which put every message on the phone off by the device's
 * UTC offset. These cases only fail without the fix on a machine whose zone is not UTC.
 */
describe('parseStoredDatetime', () => {
	it('reads the zone-less form a datetime column returns as UTC', () => {
		expect(parseStoredDatetime('2026-09-15T22:34:55').toISOString()).toBe('2026-09-15T22:34:55.000Z');
	});

	it('keeps fractional seconds', () => {
		expect(parseStoredDatetime('2026-09-15T22:34:55.123').toISOString()).toBe('2026-09-15T22:34:55.123Z');
	});

	it('leaves a value that already carries a zone alone', () => {
		expect(parseStoredDatetime('2026-09-15T22:34:55.000Z').toISOString()).toBe('2026-09-15T22:34:55.000Z');
		expect(parseStoredDatetime('2026-09-15T16:34:55-06:00').toISOString()).toBe('2026-09-15T22:34:55.000Z');
	});
});
