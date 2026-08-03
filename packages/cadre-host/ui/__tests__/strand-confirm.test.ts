import { describe, expect, it } from 'vitest';

import { requiresTypedConfirmation, typedConfirmationMatches } from '../src/lib/strand-confirm.js';

describe('requiresTypedConfirmation', () => {
	it('demands a typed confirmation only for closed strands', () => {
		expect(requiresTypedConfirmation('c')).toBe(true);
		expect(requiresTypedConfirmation('o')).toBe(false);
	});
});

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
});
