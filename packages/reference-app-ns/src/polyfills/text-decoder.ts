/**
 * A UTF-8-only `TextDecoder` for NativeScript runtimes that have none. Exports the
 * class and installs nothing; `hermes.ts` installs it over a missing global.
 *
 * The same decoder as the `TextDecoder` block in packages/cadre-rn/polyfills/hermes.js.
 * Both copies are checked against Node's native decoder on the inputs in
 * test-harness/utf8-decoder-inputs.ts, so a fix to one belongs in the other.
 *
 * Output is built a chunk of code units at a time, never a character at a time:
 * Optimystic decodes every block, transform and metadata record it reads from storage
 * (gotchoices/sereus#51).
 */

const CHUNK = 4096;
// One slot past CHUNK: the flush check runs before each byte, and a surrogate pair begun
// at CHUNK - 1 ends at CHUNK. Shared by every decoder, which is safe because decode is
// synchronous and never re-entered.
const units = new Uint16Array(CHUNK + 1);

/** Appends `codeUnits` (at most CHUNK of them, far inside any engine's argument limit) as a string. */
function pushString(parts: string[], codeUnits: Uint8Array | Uint16Array): void {
	parts.push(String.fromCharCode.apply(null, codeUnits as unknown as number[]));
}

/** Appends the run of ASCII from `start` straight from the input, and returns where it ends. */
function pushAsciiRun(bytes: Uint8Array, start: number, parts: string[]): number {
	let end = start;
	while (end < bytes.length && bytes[end] < 0x80) end++;
	for (let s = start; s < end; s += CHUNK) {
		pushString(parts, bytes.subarray(s, Math.min(end, s + CHUNK)));
	}
	return end;
}

/**
 * The Encoding Standard's UTF-8 decoder with replacement, from `start` to the end: each
 * maximal invalid subpart becomes one U+FFFD, and so does a sequence the input ends
 * inside. The bounds on the next continuation byte are what reject overlong forms,
 * surrogates and code points above U+10FFFF.
 */
function pushDecoded(bytes: Uint8Array, start: number, parts: string[]): void {
	let pos = 0;
	let codePoint = 0;
	let needed = 0;
	let seen = 0;
	let lower = 0x80;
	let upper = 0xBF;
	let i = start;
	while (i < bytes.length) {
		if (pos >= CHUNK) {
			pushString(parts, units.subarray(0, pos));
			pos = 0;
		}
		const byte = bytes[i];
		if (needed === 0) {
			i++;
			if (byte < 0x80) {
				units[pos++] = byte;
			} else if (byte >= 0xC2 && byte <= 0xDF) {
				needed = 1;
				codePoint = byte & 0x1F;
			} else if (byte >= 0xE0 && byte <= 0xEF) {
				if (byte === 0xE0) lower = 0xA0;
				else if (byte === 0xED) upper = 0x9F;
				needed = 2;
				codePoint = byte & 0x0F;
			} else if (byte >= 0xF0 && byte <= 0xF4) {
				if (byte === 0xF0) lower = 0x90;
				else if (byte === 0xF4) upper = 0x8F;
				needed = 3;
				codePoint = byte & 0x07;
			} else {
				units[pos++] = 0xFFFD;
			}
		} else if (byte < lower || byte > upper) {
			// The bytes so far are one invalid subpart. This byte is not consumed: it is read
			// again as the start of whatever follows.
			units[pos++] = 0xFFFD;
			needed = 0;
			seen = 0;
			lower = 0x80;
			upper = 0xBF;
		} else {
			i++;
			lower = 0x80;
			upper = 0xBF;
			codePoint = (codePoint << 6) | (byte & 0x3F);
			if (++seen === needed) {
				if (codePoint > 0xFFFF) {
					codePoint -= 0x10000;
					units[pos++] = 0xD800 + (codePoint >> 10);
					units[pos++] = 0xDC00 + (codePoint & 0x3FF);
				} else {
					units[pos++] = codePoint;
				}
				needed = 0;
				seen = 0;
			}
		}
	}
	if (needed !== 0) units[pos++] = 0xFFFD;
	if (pos > 0) pushString(parts, units.subarray(0, pos));
}

function decodeUtf8(bytes: Uint8Array, ignoreBOM: boolean): string {
	const start = !ignoreBOM && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ? 3 : 0;
	const parts: string[] = [];
	const asciiEnd = pushAsciiRun(bytes, start, parts);
	if (asciiEnd < bytes.length) pushDecoded(bytes, asciiEnd, parts);
	return parts.length === 1 ? parts[0] : parts.join('');
}

export class TextDecoderPolyfill {
	readonly encoding = 'utf-8';
	readonly fatal = false;
	readonly ignoreBOM = false;

	/** Throws a `RangeError` for any label but UTF-8, rather than decoding it wrongly. */
	constructor(label = 'utf-8') {
		const enc = String(label).toLowerCase().replace('_', '-');
		if (enc !== 'utf-8' && enc !== 'utf8') {
			throw new RangeError(`TextDecoder polyfill only supports UTF-8 (got "${label}")`);
		}
	}

	decode(input?: AllowSharedBufferSource | null): string {
		if (input == null) return '';
		const bytes = input instanceof Uint8Array
			? input
			: ArrayBuffer.isView(input)
				? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
				: new Uint8Array(input);
		return decodeUtf8(bytes, this.ignoreBOM);
	}
}
