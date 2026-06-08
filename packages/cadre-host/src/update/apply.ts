/**
 * Apply an update.
 *
 * Apply == reinstall the package globally via `npm install -g <pkg>@<ver>`.
 * Rollback == reinstall the previously-recorded version. Both are dispatched
 * through an injectable `NpmExecutor` so tests don't shell out.
 *
 * Service-host restart is best-effort: the binary swap succeeded even if
 * `systemctl/launchctl/nssm restart` returned non-zero, so the state stays
 * successful and the caller surfaces a warning. (User can restart by hand.)
 */

import { spawn } from 'node:child_process';
import debug from 'debug';

import {
  UpdateErrorException,
  type UpdateApplyResult,
} from './types.js';

const log = debug('cadre:host:update-apply');

const DEFAULT_NPM_TIMEOUT_MS = 5 * 60 * 1000;

export interface NpmResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Pluggable npm runner — replaced in tests. */
export type NpmExecutor = (args: string[]) => Promise<NpmResult>;

/** Optional service-host restart hook. Returns undefined on success, an error message on failure. */
export type ServiceRestarter = () => Promise<string | undefined>;

export interface ApplyOptions {
  npmPackage: string;
  fromVersion: string;
  toVersion: string;
  npmExecutor?: NpmExecutor;
  restart?: ServiceRestarter;
  timeoutMs?: number;
}

/**
 * Drive the install + restart. Throws `UpdateErrorException('apply_failed')`
 * if the install itself fails (after attempting rollback). On install
 * success but restart failure, returns a result with the restart error set.
 */
export async function applyUpdate(opts: ApplyOptions): Promise<UpdateApplyResult> {
  const executor = opts.npmExecutor ?? defaultNpmExecutor(opts.timeoutMs ?? DEFAULT_NPM_TIMEOUT_MS);

  const installArgs = ['install', '-g', `${opts.npmPackage}@${opts.toVersion}`];
  let installResult: NpmResult;
  try {
    installResult = await executor(installArgs);
  } catch (err) {
    await tryRollback(opts.npmPackage, opts.fromVersion, executor);
    throw new UpdateErrorException(
      'apply_failed',
      `npm install threw: ${(err as Error).message}`,
    );
  }
  if (installResult.exitCode !== 0) {
    const stderrTail = tail(installResult.stderr || installResult.stdout, 400);
    const rollbackErr = await tryRollback(opts.npmPackage, opts.fromVersion, executor);
    if (rollbackErr) {
      throw new UpdateErrorException(
        'rollback_failed',
        `npm install failed (exit ${installResult.exitCode}); rollback also failed: ${rollbackErr}. Original error: ${stderrTail}`,
      );
    }
    throw new UpdateErrorException(
      'apply_failed',
      `npm install failed (exit ${installResult.exitCode}): ${stderrTail}`,
    );
  }
  log('npm install -g %s@%s succeeded', opts.npmPackage, opts.toVersion);

  let restartError: string | undefined;
  if (opts.restart) {
    try {
      restartError = await opts.restart();
    } catch (err) {
      restartError = (err as Error).message;
    }
    if (restartError) {
      log('service restart failed: %s', restartError);
    }
  }

  return {
    fromVersion: opts.fromVersion,
    toVersion: opts.toVersion,
    restarted: opts.restart !== undefined && restartError === undefined,
    ...(restartError ? { restartError } : {}),
  };
}

/** Best-effort rollback. Returns an error string if the rollback itself failed. */
async function tryRollback(
  pkg: string,
  fromVersion: string,
  executor: NpmExecutor,
): Promise<string | undefined> {
  log('rolling back to %s@%s', pkg, fromVersion);
  try {
    const rollback = await executor(['install', '-g', `${pkg}@${fromVersion}`]);
    if (rollback.exitCode !== 0) {
      return `npm install exit ${rollback.exitCode}: ${tail(rollback.stderr || rollback.stdout, 400)}`;
    }
    return undefined;
  } catch (err) {
    return `npm install threw: ${(err as Error).message}`;
  }
}

/**
 * Default executor: spawn `npm` with the given args. Adds a hard timeout.
 *
 * On Windows, npm ships as `npm.cmd` (a batch file). CreateProcess can't run
 * batch files directly, so a shell is required — but Node's DEP0190 warns
 * against `spawn(cmd, args, { shell: true })` because args are concatenated
 * (not escaped) into the resulting command line. To dodge the deprecation we
 * pre-quote each arg ourselves and pass the result as a single command string
 * with an empty args array. Inputs come from a signed manifest after
 * regex-validated package + semver checks, so injection surface is minimal;
 * quoting is defense in depth.
 */
export function defaultNpmExecutor(timeoutMs: number): NpmExecutor {
  return (args: string[]) => new Promise<NpmResult>((resolveExec) => {
    const spawnSpec = buildNpmSpawnSpec(args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      shell: spawnSpec.shell,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });

    const timer = setTimeout(() => {
      stderr += `\n[cadre-host] npm install timed out after ${timeoutMs}ms, killing`;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolveExec({ exitCode: 127, stdout, stderr: stderr + `\nspawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveExec({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Build the `(command, args, shell)` triple passed to `spawn`. Exported for
 * tests — the spawn shape differs per platform and the quoting matters.
 */
export function buildNpmSpawnSpec(args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32') {
    const commandLine = ['npm', ...args.map(quoteWindowsArg)].join(' ');
    return { command: commandLine, args: [], shell: true };
  }
  return { command: 'npm', args, shell: false };
}

/** cmd.exe quoting — wrap args containing whitespace or shell metachars. */
export function quoteWindowsArg(arg: string): string {
  // \x00 is an intentional security guard: reject NUL/CR/LF in args before they
  // reach the cmd.exe command line. The control char is the point of the check.
  // eslint-disable-next-line no-control-regex
  if (/[\x00\r\n]/.test(arg)) {
    throw new Error('refusing to spawn npm with control character in argument');
  }
  if (arg.length === 0) return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  // Escape backslashes preceding a quote per MSVCRT/cmd rules, then double the
  // quote itself (the cmd-friendly form rather than backslash-quote).
  const escaped = arg.replace(/(\\*)"/g, (_m, slashes: string) => slashes + slashes + '\\"');
  const trailing = escaped.replace(/(\\*)$/, (_m, slashes: string) => slashes + slashes);
  return `"${trailing}"`;
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : '…' + s.slice(-n);
}
