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
