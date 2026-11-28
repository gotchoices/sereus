/**
 * The few host globals this package relies on, which every runtime it targets provides
 * (Hermes/React Native, browsers, Node, NativeScript). Declared here rather than pulling
 * in the DOM or Node type libraries, so a browser-only or Node-only API cannot slip in
 * unnoticed.
 */
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;

declare const console: {
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
};

/** Text to bytes and back (app-link codecs). */
declare class TextEncoder {
	encode(input?: string): Uint8Array;
}
declare class TextDecoder {
	constructor(label?: string, options?: { fatal?: boolean });
	decode(input?: Uint8Array): string;
}

/** Random bytes (a link request's nonce). React Native gets it from `react-native-get-random-values`. */
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
