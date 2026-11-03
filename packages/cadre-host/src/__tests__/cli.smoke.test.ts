/**
 * Smoke test: invokes the compiled CLI with --help and asserts the expected
 * subcommands are listed. Relies on `yarn build` having produced dist/bin/host.js.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '../../dist/bin/host.js');

// These smoke tests cold-start the built CLI as a child process (Node boot +,
// for some, an HTTP server). That comfortably exceeds vitest's 5s default under
// heavy parallel load, so give the subprocess generous headroom.
vi.setConfig({ testTimeout: 30000 });

describe('cadre-host CLI smoke test', () => {
  it('prints help with all subcommands', () => {
    if (!existsSync(binPath)) {
      throw new Error(`cadre-host bin not built at ${binPath}; run \`yarn build\` first`);
    }

    const stdout = execFileSync(process.execPath, [binPath, '--help'], {
      encoding: 'utf8',
    });

    expect(stdout.length).toBeGreaterThan(0);
    for (const cmd of ['install', 'start', 'status', 'uninstall']) {
      expect(stdout).toContain(cmd);
    }
  });

  it('prints the version from package.json', () => {
    if (!existsSync(binPath)) {
      throw new Error(`cadre-host bin not built at ${binPath}; run \`yarn build\` first`);
    }

    const stdout = execFileSync(process.execPath, [binPath, '--version'], {
      encoding: 'utf8',
    });
    // The built CLI reads package.json at runtime, so this holds even against a
    // stale dist — it catches dist/package-version.js resolving the wrong path.
    const pkg = JSON.parse(
      readFileSync(resolve(here, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(stdout.trim()).toBe(pkg.version);
  });

  it.runIf(process.platform !== 'win32')('start narrows the data dir to 0700 on POSIX', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cadre-host-cli-smoke-'));
    let host: ChildProcess | undefined;
    try {
      execFileSync(process.execPath, [
        binPath, 'install', '--non-interactive', '--no-service', '--no-upnp', '--no-browser', '--data-dir', dataDir,
      ]);
      chmodSync(dataDir, 0o755);

      host = spawn(process.execPath, [binPath, 'start', '--data-dir', dataDir], { stdio: ['ignore', 'pipe', 'inherit'] });
      await uiLine(host);

      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      await stop(host);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/** Resolves once the host prints its local-UI line, which it does only after every store is built. */
function uiLine(host: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let out = '';
    host.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('cadre-host local UI:')) resolvePromise();
    });
    host.once('exit', (code) => reject(new Error(`host exited (${code}) before its UI came up:\n${out}`)));
  });
}

async function stop(host: ChildProcess | undefined): Promise<void> {
  if (!host || host.exitCode !== null || host.signalCode !== null) return;
  const exited = once(host, 'exit');
  host.kill();
  await exited;
}
