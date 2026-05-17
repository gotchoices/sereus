/**
 * NSSM-backed Windows service.
 *
 * Delegates to the bundled PowerShell scripts (`install-service.ps1` /
 * `uninstall-service.ps1`) which encapsulate the NSSM CLI dance and the
 * stdout/stderr log redirection.
 *
 * Bundling NSSM itself with the npm package is out of scope for v1 — the
 * standalone-binary distribution will ship it (see backlog).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import debug from 'debug';

import type { ServiceHost, ServiceHostContext, ServiceHostStatus } from './types.js';

const log = debug('cadre:host:installer:nssm');

const SERVICE_NAME = 'CadreHost';

export class NssmServiceHost implements ServiceHost {
  readonly name = SERVICE_NAME;

  /** No template to render — NSSM stores its config in the registry. */
  renderUnit(ctx: ServiceHostContext): string | null {
    void ctx;
    return null;
  }

  async install(ctx: ServiceHostContext): Promise<void> {
    requireNssmAvailable();
    const script = join(ctx.serviceDir, 'install-service.ps1');
    if (!existsSync(script)) {
      throw new Error(`install-service.ps1 not found at ${script}`);
    }
    runPwsh([
      '-ExecutionPolicy', 'Bypass',
      '-NoProfile',
      '-File', script,
      '-NodePath', ctx.nodePath,
      '-HostJs', ctx.hostJs,
      '-DataDir', ctx.dataDir,
    ]);
    // Start the service after install — install-service.ps1 sets
    // SERVICE_AUTO_START but doesn't run it immediately.
    runPwsh(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', `nssm.exe start ${SERVICE_NAME}`]);
  }

  async uninstall(ctx: ServiceHostContext): Promise<void> {
    requireNssmAvailable();
    const script = join(ctx.serviceDir, 'uninstall-service.ps1');
    if (!existsSync(script)) {
      // Fall back to a direct nssm remove if the script isn't there.
      runPwsh(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', `nssm.exe stop ${SERVICE_NAME} confirm; nssm.exe remove ${SERVICE_NAME} confirm`]);
      return;
    }
    runPwsh(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', script]);
  }

  async restart(ctx: ServiceHostContext): Promise<void> {
    void ctx;
    requireNssmAvailable();
    runPwsh(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-Command', `nssm.exe restart ${SERVICE_NAME}`]);
  }

  async status(ctx: ServiceHostContext): Promise<ServiceHostStatus> {
    void ctx;
    const statusResult = spawnSync('nssm.exe', ['status', SERVICE_NAME], { encoding: 'utf8' });
    if (statusResult.error || statusResult.status !== 0) {
      return { installed: false, running: false };
    }
    const stateLine = statusResult.stdout.trim();
    return { installed: true, running: /SERVICE_RUNNING/i.test(stateLine) };
  }
}

function requireNssmAvailable(): void {
  const probe = spawnSync('nssm.exe', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'nssm.exe not found on PATH. Install NSSM from https://nssm.cc/download ' +
        'and add it to PATH, then re-run `cadre-host install`.',
    );
  }
}

function runPwsh(args: string[]): void {
  // powershell.exe is the in-box Windows PowerShell 5.1 — present on every
  // supported Windows version. pwsh.exe (PowerShell 7) is an optional install.
  const result = spawnSync('powershell.exe', args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`powershell.exe failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    log('powershell.exe exit %s for args %j', result.status, args);
    throw new Error(`powershell.exe exited with status ${result.status}`);
  }
}
