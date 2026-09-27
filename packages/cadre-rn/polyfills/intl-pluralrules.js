/**
 * Minimal Intl.PluralRules polyfill for Hermes.
 * moat-maker uses `new Intl.PluralRules('en', { type: 'ordinal' })` at
 * module scope for ordinal formatting in error messages.  Hermes does not
 * ship Intl.PluralRules, so we provide a lightweight English-only shim.
 */

import { markPolyfilled } from './registry';

if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'undefined') {
	const ordinalRules = (n) => {
		const mod10 = n % 10;
		const mod100 = n % 100;
		if (mod10 === 1 && mod100 !== 11) return 'one';
		if (mod10 === 2 && mod100 !== 12) return 'two';
		if (mod10 === 3 && mod100 !== 13) return 'few';
		return 'other';
	};

	const cardinalRules = (n) => {
		if (n === 1) return 'one';
		return 'other';
	};

	class PluralRules {
		#type;

		constructor(_locale, options) {
			this.#type = options?.type === 'ordinal' ? 'ordinal' : 'cardinal';
		}

		select(n) {
			return this.#type === 'ordinal' ? ordinalRules(n) : cardinalRules(n);
		}

		resolvedOptions() {
			return { type: this.#type, locale: 'en' };
		}
	}

	Intl.PluralRules = PluralRules;
	markPolyfilled('Intl.PluralRules');
}
