/**
 * Minimal `Intl.PluralRules` polyfill (English-only).
 *
 * moat-maker uses `new Intl.PluralRules('en', { type: 'ordinal' })` at module
 * scope for ordinal formatting in error messages. The NativeScript V8/JSC
 * runtime may ship without ICU, so `Intl` itself can be entirely absent (the
 * at-boot audit reports `Intl.PluralRules` MISSING for exactly this reason — the
 * RN-derived guard on `typeof Intl !== 'undefined'` short-circuited). Create the
 * `Intl` namespace when missing, then install a lightweight English shim. Ported
 * and hardened from packages/reference-app-rn/polyfills/intl-pluralrules.js.
 */

import { markPolyfilled } from './registry';

const intl =
	(globalThis as { Intl?: Record<string, unknown> }).Intl ??
	((globalThis as { Intl?: Record<string, unknown> }).Intl = {} as Record<string, unknown>);

if (typeof intl.PluralRules === 'undefined') {
	const ordinalRules = (n: number): Intl.LDMLPluralRule => {
		const mod10 = n % 10;
		const mod100 = n % 100;
		if (mod10 === 1 && mod100 !== 11) return 'one';
		if (mod10 === 2 && mod100 !== 12) return 'two';
		if (mod10 === 3 && mod100 !== 13) return 'few';
		return 'other';
	};

	const cardinalRules = (n: number): Intl.LDMLPluralRule => (n === 1 ? 'one' : 'other');

	class PluralRules {
		private readonly type: 'ordinal' | 'cardinal';

		constructor(_locale?: string | string[], options?: { type?: 'ordinal' | 'cardinal' }) {
			this.type = options?.type === 'ordinal' ? 'ordinal' : 'cardinal';
		}

		select(n: number): Intl.LDMLPluralRule {
			return this.type === 'ordinal' ? ordinalRules(n) : cardinalRules(n);
		}

		resolvedOptions(): { type: 'ordinal' | 'cardinal'; locale: string } {
			return { type: this.type, locale: 'en' };
		}
	}

	// Native `Intl` may be non-extensible; fall back to defineProperty.
	try {
		intl.PluralRules = PluralRules;
	} catch {
		Object.defineProperty(intl, 'PluralRules', {
			value: PluralRules,
			configurable: true,
			writable: true,
		});
	}
	markPolyfilled('Intl.PluralRules');
}
