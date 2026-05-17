/**
 * systemd `--user` unit registration.
 *
 * Renders the template into `~/.config/systemd/user/cadre-host.service`,
 * runs `systemctl --user daemon-reload`, `enable --now cadre-host`, and
 * `loginctl enable-linger <user>` so the unit survives logout / reboot.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import debug from 'debug';

import { renderTemplate } from './template.js';
import { serviceInstallPath } from '../paths.js';
import type { ServiceHost, ServiceHostContext, ServiceHostStatus } from './types.js';

const log = debug('cadre:host:installer:systemd');

const SERVICE_NAME = 'cadre-host';

export class SystemdServiceHost implements ServiceHost {
  readonly name = SERVICE_NAME;

  renderUnit(ctx: ServiceHostContext): string {
    const tmpl = readFileSync(`${ctx.serviceDir}/cadre-host.service.tmpl`, 'utf8');
    return renderTemplate(tmpl, {
      NODE_PATH: ctx.nodePath,
      HOST_JS: ctx.hostJs,
      DATA_DIR: ctx.dataDir,
    });
  }

  async install(ctx: ServiceHostContext): Promise<void> {
    const unitPath = serviceInstallPath('linux');
    const unit = this.renderUnit(ctx);

    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit, { mode: 0o644 });
    log('wrote %s', unitPath);

    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    // enable-linger is opportunistic — it requires `loginctl` and may
    // fail in containers / minimal images. Don't kill the install for it.
    const user = userInfo().username;
    const linger = spawnSync('loginctl', ['enable-linger', user], { stdio: 'inherit' });
    if (linger.status !== 0) {
      log('loginctl enable-linger %s failed (status=%s) — service may not run after logout', user, linger.status);
    }
  }

  async uninstall(ctx: ServiceHostContext): Promise<void> {
    const unitPath = serviceInstallPath('linux');
    // Stop + disable even if the unit file is missing — covers manual cleanup.
    spawnSync('systemctl', ['--user', 'stop', SERVICE_NAME], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'inherit' });
    if (existsSync(unitPath)) {
      rmSync(unitPath, { force: true });
      log('removed %s', unitPath);
    }
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    void ctx;
  }

  async status(ctx: ServiceHostContext): Promise<ServiceHostStatus> {
    void ctx;
    const unitPath = serviceInstallPath('linux');
    const installed = existsSync(unitPath);
    const result = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], { encoding: 'utf8' });
    const running = result.status === 0 && result.stdout.trim() === 'active';
    return { installed, running };
  }
}

function run(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${(err as Error).message}`);
  }
}
