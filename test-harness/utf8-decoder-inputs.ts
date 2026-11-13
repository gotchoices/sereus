/**
 * Inputs for checking a stand-in `TextDecoder` against the runtime's native one.
 *
 * Two apps ship their own copy of the same UTF-8 decoder, and each has a test that
 * decodes every input here with its copy and with Node's `TextDecoder` and expects no
 * differences:
 *   - `packages/cadre-rn/polyfills/hermes.js`, tested by
 *     `packages/cadre-rn/test/polyfills/hermes-polyfills.spec.ts`
 *   - `packages/reference-app-ns/src/polyfills/text-decoder.ts`, tested by
 *     `packages/reference-app-ns/test/polyfills.spec.ts`
 *
 * Imports nothing: cadre-rn's `polyfills` Vitest project runs without the stale-build
 * guard, and must stay runnable while a sibling repository is unbuilt.
 */

/**
 * Bytes where UTF-8 changes meaning: the ASCII edges, the edges of the continuation
 * range and of each narrowed range after E0, ED, F0 and F4, every lead-byte class edge,
 * and the bytes that are never valid.
 */
const UTF8_BOUNDARY_BYTES = [
	0x00, 0x41, 0x7F, 0x80, 0x8F, 0x90, 0x9F, 0xA0, 0xBB, 0xBF, 0xC0, 0xC1, 0xC2, 0xDF,
	0xE0, 0xE1, 0xEC, 0xED, 0xEE, 0xEF, 0xF0, 0xF1, 0xF3, 0xF4, 0xF5, 0xF7, 0xF8, 0xFE, 0xFF,
];

/** mulberry32: a fixed seed gives the same sequence on every run, so a failure reproduces. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `count` byte strings up to `maxLength` long, most bytes drawn from UTF8_BOUNDARY_BYTES. */
function randomUtf8EdgeBytes(seed: number, count: number, maxLength: number): Uint8Array[] {
	const random = seededRandom(seed);
	const nextByte = () => random() < 0.6
		? UTF8_BOUNDARY_BYTES[Math.floor(random() * UTF8_BOUNDARY_BYTES.length)]
		: Math.floor(random() * 256);
	return Array.from(
		{ length: count },
		() => Uint8Array.from({ length: Math.floor(random() * (maxLength + 1)) }, nextByte),
	);
}

/** Hand-picked invalid and boundary cases, encoded text that crosses output flushes, and seeded random bytes. */
export function decoderInputs(): Uint8Array[] {
	const fixed = [
		// byte-order marks: one is stripped, a second is text, a partial one is invalid
		[], [0xEF, 0xBB, 0xBF], [0xEF, 0xBB, 0xBF, 0x41], [0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF, 0x41], [0xEF, 0xBB],
		// overlong forms
		[0xC0, 0x80], [0xC1, 0xBF], [0xE0, 0x80, 0x80], [0xE0, 0x9F, 0xBF], [0xF0, 0x80, 0x80, 0x80], [0xF0, 0x8F, 0xBF, 0xBF],
		// surrogate code points, then U+D7FF just below them
		[0xED, 0xA0, 0x80], [0xED, 0xBF, 0xBF], [0xED, 0x9F, 0xBF],
		// above U+10FFFF, then U+10FFFF itself
		[0xF4, 0x90, 0x80, 0x80], [0xF5, 0x80, 0x80, 0x80], [0xF8, 0x88, 0x80, 0x80, 0x80], [0xF4, 0x8F, 0xBF, 0xBF],
		// each truncation, at the end and before ASCII
		[0xC3], [0xE2], [0xE2, 0x82], [0xF0], [0xF0, 0x9F], [0xF0, 0x9F, 0x98], [0xF0, 0x9F, 0x98, 0x41],
		[0xE2, 0x41], [0x61, 0xE2, 0x82],
		// stray continuations and never-valid bytes
		[0x80], [0xBF, 0x80], [0xFE], [0xFF], [0xFF, 0xFE],
	].map((bytes) => Uint8Array.from(bytes));
	const encoder = new TextEncoder();
	const text = [
		'héllo',
		'a€😀z',
		// ASCII alone, over two flushes
		'x'.repeat(9000),
		// an ASCII run longer than a flush, then the multi-byte decoder
		'a'.repeat(5000) + 'é',
		// every surrogate pair at an odd offset, so one straddles the 4096-unit flush
		'é' + '😀'.repeat(3000),
	].map((value) => encoder.encode(value));
	return [
		...fixed,
		...text,
		...randomUtf8EdgeBytes(51, 4000, 24),
		// long enough to cross flushes with invalid sequences in flight
		...randomUtf8EdgeBytes(5151, 4, 10_000),
	];
}

/** A failing input as hex, cut short so a long one does not swamp the report. */
export function describeBytes(bytes: Uint8Array): string {
	const head = Array.from(bytes.subarray(0, 32), (byte) => byte.toString(16).padStart(2, '0')).join('');
	return bytes.length > 32 ? `${head}… (${bytes.length} bytes)` : head;
}
