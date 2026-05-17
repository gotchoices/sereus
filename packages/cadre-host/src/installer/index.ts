/**
 * Public installer surface for cadre-host.
 *
 * Orchestrates the install / uninstall flow described in
 * `tickets/implement/6.4.1-cadre-host-installer.md`.
 *
 * The class is purposefully thin — heavy lifting lives in the focused
 * subsystem modules (wizard.ts, identity.ts, config.ts,
 * service-host/{systemd,launchd,nssm}.ts, browser.ts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import debug from 'debug';

import { NatStore } from '../nat/index.js';

import { openBrowser } from './browser.js';
import { writeHostConfig, type HostConfigFile } from './config.js';
import { generateIdentity } from './identity.js';
import {
  configPath,
  defaultHostJs,
  defaultServiceDir,
  identityPath,
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
  DEFAULT_LIBP2P_PORT,
  type WizardAnswers,
} from './wizard.js';

export type { HostConfigFile } from './config.js';
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
  /** Override the libp2p port. */
  libp2pPort?: number;
  /** Disable UPnP probing on first run. */
  noUpnp?: boolean;
  /** Open browser at end (default true; suppressed by --no-browser or non-TTY). */
  openBrowser?: boolean;
  /** Skip the enrollment-invite step (no QR printed). */
  noInvite?: boolean;
  /** System-wide install — v1 emits a not-yet-supported error. */
  system?: boolean;
  /** Path to node.exe / node binary used by the service-host unit. */
  nodePath?: string;
  /** Test-only: stub the service-host registration. */
  serviceHost?: ServiceHost;
}

export interface InstallResult {
  dataDir: string;
  uiUrl: string;
  serviceName: string;
  /** Path to the rendered config file. */
  configPath: string;
  /** Generated enrollment invite, unless --no-invite. */
  enrollmentInvite?: {
    encodedInvite: string;
    expiresAt?: string;
  };
}

export interface UninstallOptions {
  /** Also remove the data dir (default false — preserve trust circle + identity). */
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

    // 3. Identity + config. Don't overwrite an existing key — re-running
    //    install on a populated data dir must preserve the host's peer ID.
    const idPath = identityPath(answers.dataDir);
    if (existsSync(idPath)) {
      log('identity already exists at %s — leaving it', idPath);
    } else {
      await generateIdentity(idPath);
    }

    const cfg: HostConfigFile = {
      version: 1,
      installId: randomInstallId(),
      uiPort: answers.uiPort,
      libp2pPort: answers.libp2pPort,
      dataDir: answers.dataDir,
      identityPath: idPath,
      upnpEnabled: answers.upnpEnabled,
      installedAt: new Date().toISOString(),
      installerVersion: this.installerVersion,
    };
    const cfgPath = configPath(answers.dataDir);
    writeHostConfig(cfgPath, cfg);

    // 4. Seed nat.json with the chosen libp2p port + UPnP flag so the
    //    NatService picks them up on first start.
    seedNatSettings(answers.dataDir, answers.libp2pPort, answers.upnpEnabled);

    // 5. Service-host registration.
    const serviceHost = opts.serviceHost ?? createServiceHost(this.platform);
    const ctx: ServiceHostContext = {
      nodePath: opts.nodePath ?? process.execPath,
      hostJs: defaultHostJs(),
      dataDir: answers.dataDir,
      serviceDir: defaultServiceDir(),
    };
    await serviceHost.install(ctx);

    // 6. Browser open (best-effort).
    const uiUrl = `http://127.0.0.1:${answers.uiPort}/`;
    const shouldOpenBrowser = opts.openBrowser !== false && !opts.nonInteractive && process.stdout.isTTY;
    if (shouldOpenBrowser) {
      openBrowser(uiUrl);
    }

    // 7. Enrollment invite (best-effort — the listener may not be up yet).
    let invite: InstallResult['enrollmentInvite'];
    if (!opts.noInvite && !opts.nonInteractive) {
      invite = await fetchEnrollmentInvite(answers.uiPort).catch((err) => {
        log('enrollment-invite fetch failed: %s', (err as Error).message);
        return undefined;
      });
    }

    return {
      dataDir: answers.dataDir,
      uiUrl,
      serviceName: serviceHost.name,
      configPath: cfgPath,
      ...(invite ? { enrollmentInvite: invite } : {}),
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
      libp2pPort: opts.libp2pPort ?? defaults.libp2pPort,
      upnpEnabled: opts.noUpnp ? false : defaults.upnpEnabled,
      configureDdns: false,
    };
  }

  private async resolveAnswers(opts: InstallOptions): Promise<WizardAnswers> {
    if (opts.nonInteractive) {
      return this.resolveAnswersFromOptions(opts);
    }
    const defaults = defaultsForPlatform(this.platform);
    const answers = await runWizard(defaults);
    // CLI flags still take precedence over wizard input — useful when the
    // user passes `--ui-port 9000` but accepts defaults at the prompts.
    return {
      dataDir: opts.dataDir ?? answers.dataDir,
      uiPort: opts.uiPort ?? answers.uiPort,
      libp2pPort: opts.libp2pPort ?? answers.libp2pPort,
      upnpEnabled: opts.noUpnp ? false : answers.upnpEnabled,
      configureDdns: answers.configureDdns,
    };
  }
}

export { runWizardWith, defaultsForPlatform, DEFAULT_UI_PORT, DEFAULT_LIBP2P_PORT };

function seedNatSettings(dataDir: string, libp2pPort: number, upnpEnabled: boolean): void {
  const store = new NatStore(dataDir);
  // `update()` merges + persists.
  store.update({
    externalPort: libp2pPort,
    internalPort: libp2pPort,
    upnpEnabled,
  });
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

async function fetchEnrollmentInvite(uiPort: number): Promise<InstallResult['enrollmentInvite']> {
  const url = `http://127.0.0.1:${uiPort}/auth/invites`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Install — first device', ttlMs: 24 * 60 * 60 * 1000 }),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { encodedInvite?: string; expiresAt?: string };
  if (!body.encodedInvite) return undefined;
  return {
    encodedInvite: body.encodedInvite,
    ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
  };
}

// Exposed for tests that drive the wizard with a custom prompt fn.
export { runWizard };
