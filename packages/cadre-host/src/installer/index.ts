/**
 * Public installer surface for cadre-host.
 *
 * Orchestrates the install / uninstall flow described in
 * `tickets/implement/6.4.1-cadre-host-installer.md`.
 *
 * The class is purposefully thin — heavy lifting lives in the focused
 * subsystem modules (wizard.ts, config.ts, service-host/{systemd,launchd,nssm}.ts,
 * browser.ts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import debug from 'debug';

import { NatStore } from '../nat/index.js';

import { openBrowser } from './browser.js';
import { writeHostConfig, type HostConfigFile } from './config.js';
import {
  configPath,
  defaultHostJs,
  defaultServiceDir,
  logsDir,
} from './paths.js';
import {
  detectPlatform,
  type SupportedPlatform,
} from './platform.js';
import { createServiceHost, type ServiceHost, type ServiceHostContext } from './service-host/index.js';
import {
  defaultsForPlatform,
  runWizard,
  runWizardWith,
  DEFAULT_UI_PORT,
  type WizardAnswers,
  type WizardDefaults,
} from './wizard.js';

export type { HostConfigFile, PushSettings } from './config.js';
export { readHostConfig, updateHostConfig, writeHostConfig } from './config.js';
export type { WizardAnswers, WizardDefaults } from './wizard.js';
export type { ServiceHost, ServiceHostContext, ServiceHostStatus } from './service-host/index.js';

const log = debug('cadre:host:installer');

export interface InstallOptions {
  /** If true, all prompts use defaults; CLI flags override individual values. */
  nonInteractive: boolean;
  /** Override the data dir. */
  dataDir?: string;
  /** Override the UI port. */
  uiPort?: number;
  /** Disable UPnP probing on first run. */
  noUpnp?: boolean;
  /** Open browser at end (default true; suppressed by --no-browser or non-TTY). */
  openBrowser?: boolean;
  /** System-wide install — v1 emits a not-yet-supported error. */
  system?: boolean;
  /** Path to node.exe / node binary used by the service-host unit. */
  nodePath?: string;
  /**
   * Write the data dir (config, NAT seed) but register no OS service.
   * The host is then run by hand with `cadre-host start`. Nothing is listening
   * after such an install, so the browser-open step is skipped too.
   */
  noService?: boolean;
  /** Test-only: stub the service-host registration. */
  serviceHost?: ServiceHost;
  /** Test-only: stub the interactive wizard. Production callers leave unset. */
  wizard?: (defaults: WizardDefaults) => Promise<WizardAnswers>;
}

export interface InstallResult {
  dataDir: string;
  uiUrl: string;
  /** The registered service's name; absent when `noService` skipped registration. */
  serviceName?: string;
  /** Path to the rendered config file. */
  configPath: string;
}

export interface UninstallOptions {
  /** Also remove the data dir (default false — preserve hosted-node records, node identities and NAT state). */
  removeData: boolean;
  /** Skip the confirmation prompt (for scripts). */
  yes: boolean;
  /** Override the data dir to remove (defaults to platform default). */
  dataDir?: string;
  /** Test-only: stub the service-host registration. */
  serviceHost?: ServiceHost;
}

export interface InstallerOptions {
  platform?: SupportedPlatform;
  /** Installer version string written into host.config.json. */
  installerVersion?: string;
}

export class Installer {
  private readonly platform: SupportedPlatform;
  private readonly installerVersion: string;

  constructor(opts: InstallerOptions = {}) {
    this.platform = opts.platform ?? detectPlatform();
    this.installerVersion = opts.installerVersion ?? readPackageVersion();
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    if (opts.system) {
      throw new Error(
        'cadre-host install --system is not yet supported. Run without --system ' +
          'for a per-user install; see packages/cadre-host/service/README.md.',
      );
    }

    // 1. Resolve answers — wizard for interactive, defaults+overrides otherwise.
    const answers = await this.resolveAnswers(opts);

    // 2. Make sure the data dir exists.
    mkdirSync(answers.dataDir, { recursive: true });
    mkdirSync(logsDir(answers.dataDir), { recursive: true });

    // 3. Config.
    const cfg: HostConfigFile = {
      version: 3,
      installId: randomInstallId(),
      uiPort: answers.uiPort,
      dataDir: answers.dataDir,
      upnpEnabled: answers.upnpEnabled,
      installedAt: new Date().toISOString(),
      installerVersion: this.installerVersion,
      updates: { autoApply: false },
    };
    const cfgPath = configPath(answers.dataDir);
    writeHostConfig(cfgPath, cfg);

    // 4. Seed nat.json with the UPnP flag so the NatService picks it up on
    //    first start. Ports are not seeded: the service maps every hosted
    //    node's ports from the orchestrator's allocations.
    seedNatSettings(answers.dataDir, answers.upnpEnabled);

    const uiUrl = `http://127.0.0.1:${answers.uiPort}/`;

    // 5. Service-host registration.
    if (opts.noService) {
      log('--no-service: skipping service registration and browser open');
      return { dataDir: answers.dataDir, uiUrl, configPath: cfgPath };
    }
    const serviceHost = opts.serviceHost ?? createServiceHost(this.platform);
    const ctx: ServiceHostContext = {
      nodePath: opts.nodePath ?? process.execPath,
      hostJs: defaultHostJs(),
      dataDir: answers.dataDir,
      serviceDir: defaultServiceDir(),
    };
    await serviceHost.install(ctx);

    // 6. Browser open (best-effort).
    const shouldOpenBrowser = opts.openBrowser !== false && !opts.nonInteractive && process.stdout.isTTY;
    if (shouldOpenBrowser) {
      openBrowser(uiUrl);
    }

    return {
      dataDir: answers.dataDir,
      uiUrl,
      serviceName: serviceHost.name,
      configPath: cfgPath,
    };
  }

  async uninstall(opts: UninstallOptions): Promise<void> {
    const dataDir = opts.dataDir ?? defaultsForPlatform(this.platform).dataDir;
    const serviceHost = opts.serviceHost ?? createServiceHost(this.platform);
    const ctx: ServiceHostContext = {
      nodePath: process.execPath,
      hostJs: defaultHostJs(),
      dataDir,
      serviceDir: defaultServiceDir(),
    };
    await serviceHost.uninstall(ctx);

    if (opts.removeData) {
      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true });
        log('removed data dir %s', dataDir);
      }
    }
  }

  async status(opts: { serviceHost?: ServiceHost } = {}): Promise<{ installed: boolean; running: boolean }> {
    const serviceHost = opts.serviceHost ?? createServiceHost(this.platform);
    const ctx: ServiceHostContext = {
      nodePath: process.execPath,
      hostJs: defaultHostJs(),
      dataDir: defaultsForPlatform(this.platform).dataDir,
      serviceDir: defaultServiceDir(),
    };
    return await serviceHost.status(ctx);
  }

  /** Exposed for tests / unattended CI. Resolves the wizard answers without running prompts. */
  resolveAnswersFromOptions(opts: InstallOptions): WizardAnswers {
    const defaults = defaultsForPlatform(this.platform);
    return {
      dataDir: opts.dataDir ?? defaults.dataDir,
      uiPort: opts.uiPort ?? defaults.uiPort,
      upnpEnabled: opts.noUpnp ? false : defaults.upnpEnabled,
      configureDdns: false,
    };
  }

  private async resolveAnswers(opts: InstallOptions): Promise<WizardAnswers> {
    if (opts.nonInteractive) {
      return this.resolveAnswersFromOptions(opts);
    }
    // CLI flags overlay the platform defaults so the wizard's `[...]` hint
    // shows the user's chosen value. Pressing Enter accepts it; typing a new
    // value also works (and now actually has an effect — the previous
    // implementation showed the platform default in the prompt and silently
    // discarded user input because the CLI flag won post-hoc).
    const platformDefaults = defaultsForPlatform(this.platform);
    const defaults: WizardDefaults = {
      dataDir: opts.dataDir ?? platformDefaults.dataDir,
      uiPort: opts.uiPort ?? platformDefaults.uiPort,
      upnpEnabled: opts.noUpnp ? false : platformDefaults.upnpEnabled,
    };
    const wizard = opts.wizard ?? runWizard;
    return await wizard(defaults);
  }
}

export { runWizardWith, defaultsForPlatform, DEFAULT_UI_PORT };

function seedNatSettings(dataDir: string, upnpEnabled: boolean): void {
  const store = new NatStore(dataDir);
  // `update()` merges + persists.
  store.update({ upnpEnabled });
}

function randomInstallId(): string {
  return randomBytes(16).toString('hex');
}

function readPackageVersion(): string {
  // Best-effort: read the package.json next to dist/ at runtime.
  try {
    const here = new URL('../../package.json', import.meta.url);
    const raw = readFileSync(here, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

// Exposed for tests that drive the wizard with a custom prompt fn.
export { runWizard };
