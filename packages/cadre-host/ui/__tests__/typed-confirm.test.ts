import { describe, expect, it } from 'vitest';

import { typedConfirmationMatches } from '../src/lib/typed-confirm.js';

describe('typedConfirmationMatches', () => {
	it('accepts an exact match', () => {
		expect(typedConfirmationMatches('family-photos', 'family-photos')).toBe(true);
	});

	it('accepts surrounding whitespace on either side', () => {
		expect(typedConfirmationMatches('ledger-2024', '  ledger-2024 ')).toBe(true);
		expect(typedConfirmationMatches(' ledger-2024 ', 'ledger-2024')).toBe(true);
	});

	it('rejects a case difference', () => {
		expect(typedConfirmationMatches('Ledger-2024', 'ledger-2024')).toBe(false);
		expect(typedConfirmationMatches('ledger-2024', 'LEDGER-2024')).toBe(false);
	});

	it('rejects empty input', () => {
		expect(typedConfirmationMatches('ledger-2024', '')).toBe(false);
		expect(typedConfirmationMatches('ledger-2024', '   ')).toBe(false);
	});

	it('rejects a substring or a superstring', () => {
		expect(typedConfirmationMatches('ledger-2024', 'ledger')).toBe(false);
		expect(typedConfirmationMatches('ledger-2024', 'ledger-20244')).toBe(false);
	});

	it('never matches when the expected value is blank', () => {
		// Guards the gate against a missing id silently enabling the button.
		expect(typedConfirmationMatches('', '')).toBe(false);
		expect(typedConfirmationMatches('   ', '   ')).toBe(false);
	});

	it('carries interior whitespace and slashes verbatim', () => {
		// Ids are arbitrary caller-chosen strings; only the ends are trimmed.
		expect(typedConfirmationMatches('a/b c', 'a/b c')).toBe(true);
		expect(typedConfirmationMatches('a/b c', 'a/bc')).toBe(false);
	});

	it('matches a percent-escape literally rather than decoding it', () => {
		// The dialog compares what the row shows, not what the URL will carry.
		expect(typedConfirmationMatches('ns%2Fstrand', 'ns/strand')).toBe(false);
		expect(typedConfirmationMatches('ns/strand', 'ns/strand')).toBe(true);
	});
});
