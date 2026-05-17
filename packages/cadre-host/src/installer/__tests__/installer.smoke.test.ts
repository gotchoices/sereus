import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Installer } from '../index.js';
import type { ServiceHost, ServiceHostContext, ServiceHostStatus } from '../service-host/types.js';

class FakeServiceHost implements ServiceHost {
  readonly name = 'cadre-host';
  installCalls: ServiceHostContext[] = [];
  uninstallCalls: ServiceHostContext[] = [];
  installed = false;
  running = false;

  async install(ctx: ServiceHostContext): Promise<void> {
    this.installCalls.push(ctx);
    this.installed = true;
    this.running = true;
  }
  async uninstall(ctx: ServiceHostContext): Promise<void> {
    this.uninstallCalls.push(ctx);
    this.installed = false;
    this.running = false;
  }
  async status(_ctx: ServiceHostContext): Promise<ServiceHostStatus> {
    return { installed: this.installed, running: this.running };
  }
  renderUnit(_ctx: ServiceHostContext): string | null {
    return 'rendered-unit';
  }
}

describe('Installer smoke', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-host-installer-smoke-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('install creates config + identity + invokes service-host', async () => {
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux', installerVersion: 'test-1.0.0' });
    const result = await installer.install({
      nonInteractive: true,
      dataDir: tmp,
      uiPort: 19999,
      libp2pPort: 14001,
      openBrowser: false,
      noInvite: true,
      serviceHost: fake,
    });

    expect(result.dataDir).toBe(tmp);
    expect(result.uiUrl).toBe('http://127.0.0.1:19999/');
    expect(result.serviceName).toBe('cadre-host');
    expect(result.configPath).toBe(join(tmp, 'host.config.json'));

    expect(existsSync(join(tmp, 'host.config.json'))).toBe(true);
    expect(existsSync(join(tmp, 'identity.key'))).toBe(true);
    expect(existsSync(join(tmp, 'nat.json'))).toBe(true);
    expect(existsSync(join(tmp, 'logs'))).toBe(true);

    expect(fake.installCalls).toHaveLength(1);
    expect(fake.installCalls[0]!.dataDir).toBe(tmp);
  });

  it('uninstall removes data only when --remove-data is set', async () => {
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux' });
    await installer.install({
      nonInteractive: true,
      dataDir: tmp,
      uiPort: 19998,
      libp2pPort: 14002,
      openBrowser: false,
      noInvite: true,
      serviceHost: fake,
    });
    expect(existsSync(join(tmp, 'host.config.json'))).toBe(true);

    await installer.uninstall({ yes: true, removeData: false, dataDir: tmp, serviceHost: fake });
    expect(fake.uninstallCalls).toHaveLength(1);
    expect(existsSync(join(tmp, 'host.config.json'))).toBe(true);

    await installer.uninstall({ yes: true, removeData: true, dataDir: tmp, serviceHost: fake });
    expect(existsSync(tmp)).toBe(false);
  });

  it('rejects --system in v1', async () => {
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux' });
    await expect(installer.install({
      nonInteractive: true,
      dataDir: tmp,
      system: true,
      serviceHost: fake,
      openBrowser: false,
      noInvite: true,
    })).rejects.toThrow(/system.*not yet supported/);
    expect(fake.installCalls).toHaveLength(0);
  });

  it('re-running install preserves the existing identity', async () => {
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux' });
    await installer.install({
      nonInteractive: true, dataDir: tmp, openBrowser: false, noInvite: true, serviceHost: fake,
    });
    const idBefore = (await import('node:fs')).readFileSync(join(tmp, 'identity.key'));
    await installer.install({
      nonInteractive: true, dataDir: tmp, openBrowser: false, noInvite: true, serviceHost: fake,
    });
    const idAfter = (await import('node:fs')).readFileSync(join(tmp, 'identity.key'));
    expect(Buffer.from(idBefore).equals(Buffer.from(idAfter))).toBe(true);
  });
});
