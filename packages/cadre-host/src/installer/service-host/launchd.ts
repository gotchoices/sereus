/**
 * launchd LaunchAgent registration.
 *
 * Renders the .plist into `~/Library/LaunchAgents/com.serfab.cadre-host.plist`,
 * `launchctl bootstrap`s it into the gui session, then `kickstart -k` to
 * start (or restart) it. Uninstall uses `bootout` (the modern unload).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import debug from 'debug';

import { renderTemplate } from './template.js';
import { logsDir, serviceInstallPath } from '../paths.js';
import type { ServiceHost, ServiceHostContext, ServiceHostStatus } from './types.js';

const log = debug('cadre:host:installer:launchd');

const SERVICE_NAME = 'cadre-host';
const LABEL = 'com.serfab.cadre-host';

export class LaunchdServiceHost implements ServiceHost {
  readonly name = SERVICE_NAME;

  renderUnit(ctx: ServiceHostContext): string {
    const tmpl = readFileSync(`${ctx.serviceDir}/com.serfab.cadre-host.plist.tmpl`, 'utf8');
    return renderTemplate(tmpl, {
      NODE_PATH: ctx.nodePath,
      HOST_JS: ctx.hostJs,
      DATA_DIR: ctx.dataDir,
    });
  }

  async install(ctx: ServiceHostContext): Promise<void> {
    const unitPath = serviceInstallPath('darwin');
    const unit = this.renderUnit(ctx);

    mkdirSync(logsDir(ctx.dataDir), { recursive: true });
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, { mode: 0o644 });
    log('wrote %s', unitPath);

    const target = guiTarget();
    // bootout first to make install idempotent. May fail if it wasn't
    // loaded — that's fine.
    spawnSync('launchctl', ['bootout', target, unitPath], { stdio: 'ignore' });
    run('launchctl', ['bootstrap', target, unitPath]);
    run('launchctl', ['kickstart', '-k', `${target}/${LABEL}`]);
  }

  async uninstall(ctx: ServiceHostContext): Promise<void> {
    const unitPath = serviceInstallPath('darwin');
    if (existsSync(unitPath)) {
      const target = guiTarget();
      spawnSync('launchctl', ['bootout', target, unitPath], { stdio: 'inherit' });
      rmSync(unitPath, { force: true });
      log('removed %s', unitPath);
    }
    void ctx;
  }

  async restart(ctx: ServiceHostContext): Promise<void> {
    void ctx;
    const target = guiTarget();
    run('launchctl', ['kickstart', '-k', `${target}/${LABEL}`]);
  }

  async status(ctx: ServiceHostContext): Promise<ServiceHostStatus> {
    void ctx;
    const unitPath = serviceInstallPath('darwin');
    const installed = existsSync(unitPath);
    const target = guiTarget();
    const result = spawnSync('launchctl', ['print', `${target}/${LABEL}`], { encoding: 'utf8' });
    const running = result.status === 0 && /state\s*=\s*running/i.test(result.stdout);
    return { installed, running };
  }
}

function guiTarget(): string {
  return `gui/${process.getuid?.() ?? ''}`;
}

function run(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(err as Error).message}`, { cause: err });
  }
}
