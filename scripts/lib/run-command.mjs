/**
 * Spawning a build tool from a repo script, with the two Windows quirks both
 * `scripts/smoke-published-install.mjs` and `scripts/check-published.mjs` hit.
 *
 * `.cmd` shims (`yarn`, `npm`) cannot be spawned without a shell on modern node, so
 * shell out there and quote anything with whitespace. And output streams as it goes
 * by default — a silent redirect would let an agent runner's idle timer expire on a
 * multi-minute `yarn build`. `quiet` captures instead, and is only for commands that
 * finish in well under a second: `yarn pack` lists every file it archives, which is
 * ~900 lines across the publishable set and buries the report its caller exists to
 * print. A quiet command that fails echoes everything it captured before throwing.
 *
 * NOTE: only the win32 branch has ever run. If this is ever used on macOS or Linux,
 * expect the first failure here (`shell: false`).
 */

import { spawnSync } from 'node:child_process';

export function run(command, commandArgs, cwd, { quiet = false } = {}) {
	const useShell = process.platform === 'win32';
	const finalArgs = useShell
		? commandArgs.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg}"` : arg))
		: commandArgs;
	console.log(`\n$ ${command} ${commandArgs.join(' ')}   (in ${cwd})`);
	const result = spawnSync(command, finalArgs, {
		cwd,
		stdio: quiet ? 'pipe' : 'inherit',
		shell: useShell,
		encoding: quiet ? 'utf8' : undefined
	});
	if (result.error) {
		throw new Error(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		if (quiet) {
			process.stderr.write(result.stdout ?? '');
			process.stderr.write(result.stderr ?? '');
		}
		throw new Error(`${command} ${commandArgs.join(' ')} exited with code ${result.status}`);
	}
}

/** The trimmed stdout of a command that is expected to succeed and say something. */
export function capture(command, commandArgs, cwd) {
	const result = spawnSync(command, commandArgs, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
	if (result.error) {
		throw new Error(`${command} failed to start: ${result.error.message}`);
	}
	if (result.status !== 0) {
		throw new Error(`${command} ${commandArgs.join(' ')} exited with code ${result.status}: ${result.stderr ?? ''}`);
	}
	return result.stdout ?? '';
}
