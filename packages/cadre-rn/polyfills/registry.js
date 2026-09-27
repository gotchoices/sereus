/**
 * Tracks which globals each polyfill actually patched at boot, so the at-boot
 * audit (audit.js) can report `native` vs `polyfilled` against the real
 * Hermes surface instead of merely present/absent. Catches the regression where a
 * React Native upgrade starts — or stops — providing one of these natively, which
 * a present/absent check cannot see.
 *
 * Deliberately a copy of the NativeScript reference app's
 * packages/reference-app-ns/src/polyfills/registry.ts rather than a shared module:
 * that app does not depend on this React Native kit, and this file is four lines of
 * logic. The probe LISTS are what must not be shared — see the note at the top of
 * audit.js.
 */

const polyfilled = new Set();

export function markPolyfilled(name) {
	polyfilled.add(name);
}

export function wasPolyfilled(name) {
	return polyfilled.has(name);
}
