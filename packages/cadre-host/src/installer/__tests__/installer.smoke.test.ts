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
  async restart(_ctx: ServiceHostContext): Promise<void> {
    this.running = true;
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

  it('passes CLI overrides to the wizard as suggested defaults', async () => {
    // Regression: the interactive wizard previously showed the platform
    // default (`~/.local/share/cadre-host`) in the prompt even when the
    // caller passed `--data-dir <path>`. Whatever the user typed was then
    // silently discarded because the CLI flag won post-hoc. The fix: CLI
    // overrides become the wizard's suggested defaults, and the wizard's
    // returned answers stand on their own.
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux' });
    let seenDefaults: { dataDir: string; uiPort: number; libp2pPort: number; upnpEnabled: boolean } | undefined;
    await installer.install({
      nonInteractive: false,
      dataDir: tmp,
      uiPort: 19997,
      libp2pPort: 14003,
      noUpnp: true,
      openBrowser: false,
      noInvite: true,
      serviceHost: fake,
      wizard: async (defaults) => {
        seenDefaults = { ...defaults };
        // Simulate the user pressing Enter at every prompt.
        return {
          dataDir: defaults.dataDir,
          uiPort: defaults.uiPort,
          libp2pPort: defaults.libp2pPort,
          upnpEnabled: defaults.upnpEnabled,
          configureDdns: false,
        };
      },
    });

    expect(seenDefaults).toEqual({
      dataDir: tmp,
      uiPort: 19997,
      libp2pPort: 14003,
      upnpEnabled: false,
    });
    expect(fake.installCalls).toHaveLength(1);
    expect(fake.installCalls[0]!.dataDir).toBe(tmp);
  });

  it('honors wizard-typed input when no CLI override is passed', async () => {
    // Mirror of the previous test: with no `--data-dir`, the wizard's
    // returned value is what the installer uses.
    const fake = new FakeServiceHost();
    const installer = new Installer({ platform: 'linux' });
    await installer.install({
      nonInteractive: false,
      openBrowser: false,
      noInvite: true,
      serviceHost: fake,
      wizard: async () => ({
        dataDir: tmp,
        uiPort: 19996,
        libp2pPort: 14004,
        upnpEnabled: true,
        configureDdns: false,
      }),
    });
    expect(fake.installCalls).toHaveLength(1);
    expect(fake.installCalls[0]!.dataDir).toBe(tmp);
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
