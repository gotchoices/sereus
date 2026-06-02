/**
 * Tracks which globals each polyfill actually patched at boot, so the at-boot
 * audit (src/polyfills/audit.ts) can report `native` vs `polyfilled` against the
 * real V8/JSC surface instead of merely present/absent. Catches regressions
 * where a NativeScript version starts (or stops) providing an API natively.
 */

const polyfilled = new Set<string>();

export function markPolyfilled(name: string): void {
	polyfilled.add(name);
}

export function wasPolyfilled(name: string): boolean {
	return polyfilled.has(name);
}
