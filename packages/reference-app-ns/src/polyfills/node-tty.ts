/**
 * Minimal `node:tty` shim for the NativeScript runtime.
 *
 * `debug` (src/node.js) and `weald` (libp2p's logger backend) call
 * `tty.isatty(process.stderr.fd)` in their eager `useColors()` check. Stubbing
 * `tty` to an empty module (`false` in webpack fallback) made `isatty`
 * undefined, so the call threw. The NativeScript runtime is never a TTY, so
 * report `false` — both backends then resolve to no-color and never touch any
 * other tty surface. Pairs with the `stdout`/`stderr` streams in process.ts.
 */

export function isatty(_fd?: number): boolean {
	return false;
}

export default { isatty };
