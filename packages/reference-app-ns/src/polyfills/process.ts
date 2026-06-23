/**
 * Global `process` shim for the NativeScript runtime.
 *
 * @nativescript/webpack's DefinePlugin rewrites every bare `process` identifier
 * to `global.process` (see node_modules/@nativescript/webpack/dist/configuration/
 * base.js → `process: 'global.process'`), but the NativeScript V8/JSC runtime
 * defines no `global.process`. So dependency code that reads `process.env.*` at
 * module scope — notably `debug` (`process.env.DEBUG`), pulled in transitively by
 * @libp2p/logger — evaluates `undefined.env` and throws
 * "Cannot read properties of undefined (reading 'env')" the moment the cadre /
 * libp2p graph loads (e.g. when the Chat page builds). Provide a minimal,
 * Node-like `process` (env + nextTick + browser flags) before any library code.
 * Mirrors the `globalThis.Buffer` approach in buffer-global.ts. Imported FIRST.
 *
 * Note: this file never references the bare `process` identifier (which the
 * DefinePlugin would rewrite) — only `globalThis.process` via a cast.
 */

import { markPolyfilled } from './registry';

interface MinimalWriteStream {
	fd: number;
	isTTY: boolean;
	write: (chunk: string | Uint8Array) => boolean;
}

interface MinimalProcess {
	env: Record<string, string | undefined>;
	browser: boolean;
	platform: string;
	version: string;
	versions: Record<string, string>;
	nextTick: (cb: (...args: unknown[]) => void, ...args: unknown[]) => void;
	argv: string[];
	cwd: () => string;
	stdout: MinimalWriteStream;
	stderr: MinimalWriteStream;
}

// `debug` (src/node.js) and `weald` (libp2p's logger backend) compute
// `useColors()` eagerly at every logger creation via
// `tty.isatty(process.stderr.fd)` — so `stdout`/`stderr` must exist with an
// `fd`, or that read throws "Cannot read properties of undefined (reading
// 'fd')" the moment the libp2p graph loads. `isTTY: false` makes both backends
// resolve to no-color; the matching node-tty shim supplies `isatty`. `write`
// routes to the console for the (default-disabled) case where DEBUG is enabled.
function makeStream(fd: number, sink: (msg: string) => void): MinimalWriteStream {
	return {
		fd,
		isTTY: false,
		write(chunk) {
			const text = typeof chunk === 'string' ? chunk : String(chunk);
			// debug/weald append their own trailing newline; drop one so the
			// console layer doesn't double-space.
			sink(text.endsWith('\n') ? text.slice(0, -1) : text);
			return true;
		},
	};
}

// Cast through `unknown` so this shim's shape governs `process` rather than the
// ambient Node `Process` type (@nativescript/types), which we deliberately do
// not satisfy in full on the V8/JSC runtime.
const g = globalThis as unknown as { process?: Partial<MinimalProcess> };

// Patch when absent, or when present-but-incomplete (no `env`) — some hosts
// expose a stub `process` without the members the dependency graph reaches for.
if (g.process == null || typeof g.process.env === 'undefined') {
	const existing = g.process;
	const shim: MinimalProcess = {
		env: existing?.env ?? {},
		browser: true,
		platform: existing?.platform ?? 'browser',
		version: existing?.version ?? '',
		versions: existing?.versions ?? {},
		nextTick:
			existing?.nextTick ??
			((cb, ...args) => {
				queueMicrotask(() => cb(...args));
			}),
		argv: existing?.argv ?? [],
		cwd: existing?.cwd ?? (() => '/'),
		stdout: existing?.stdout ?? makeStream(1, (m) => console.log(m)),
		stderr: existing?.stderr ?? makeStream(2, (m) => console.error(m)),
	};
	g.process = shim;
	markPolyfilled('process');
}
