/**
 * Per-platform default paths for the installer.
 *
 * Linux:   XDG_DATA_HOME / ~/.local/share/cadre-host
 * macOS:   ~/Library/Application Support/CadreHost
 * Windows: %LocalAppData%\CadreHost
 *
 * The package root (where the installed `dist/bin/host.js` and `service/`
 * directory live) is resolved at runtime relative to this module. The
 * installer needs both: the data dir is per-user state, while the package
 * root is what the service-host unit's `ExecStart` line points at.
 */

import { homedir } from 'node:os';
import { posix, win32, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SupportedPlatform } from './platform.js';

/** Use the path joiner the *target* platform would use, not the runtime's. */
function joinFor(platform: SupportedPlatform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

export interface InstallerEnv {
  HOME?: string;
  XDG_DATA_HOME?: string;
  XDG_CONFIG_HOME?: string;
  LocalAppData?: string;
}

/** Default data dir for the given platform. Honors XDG_DATA_HOME / LocalAppData. */
export function defaultDataDir(
  platform: SupportedPlatform,
  env: InstallerEnv = process.env as InstallerEnv,
  home: string = homedir(),
): string {
  switch (platform) {
    case 'linux': {
      const base = env.XDG_DATA_HOME?.trim() || joinFor(platform, env.HOME?.trim() || home, '.local', 'share');
      return joinFor(platform, base, 'cadre-host');
    }
    case 'darwin': {
      return joinFor(platform, env.HOME?.trim() || home, 'Library', 'Application Support', 'CadreHost');
    }
    case 'win32': {
      // %LocalAppData% is the canonical per-user, non-roaming app data dir.
      const base = env.LocalAppData?.trim();
      if (!base) {
        // Fallback: derive from HOME (works under cygwin/MSYS test envs too).
        return joinFor(platform, home, 'AppData', 'Local', 'CadreHost');
      }
      return joinFor(platform, base, 'CadreHost');
    }
  }
}

/** Path on disk for the installed cadre-host CLI entrypoint. */
export function defaultHostJs(): string {
  // dist/installer/paths.js -> ../../dist/bin/host.js
  // src/installer/paths.ts  -> ../bin/host.ts (only used by tests; build emits dist)
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'bin', 'host.js');
}

/** Directory containing service templates (cadre-host.service.tmpl etc.). */
export function defaultServiceDir(): string {
  // dist/installer/paths.js -> ../../service/
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'service');
}

/** Where the wizard writes the JSON config. */
export function configPath(dataDir: string): string {
  return join(dataDir, 'host.config.json');
}

/** Where the wizard writes the Ed25519 identity. */
export function identityPath(dataDir: string): string {
  return join(dataDir, 'identity.key');
}

/** Logs directory (used by launchd / NSSM unit templates). */
export function logsDir(dataDir: string): string {
  return join(dataDir, 'logs');
}

/** Per-platform install dir for the rendered service unit file. */
export function serviceInstallPath(
  platform: SupportedPlatform,
  env: InstallerEnv = process.env as InstallerEnv,
  home: string = homedir(),
): string {
  const hd = env.HOME?.trim() || home;
  switch (platform) {
    case 'linux': {
      const base = env.XDG_CONFIG_HOME?.trim() || joinFor(platform, hd, '.config');
      return joinFor(platform, base, 'systemd', 'user', 'cadre-host.service');
    }
    case 'darwin': {
      return joinFor(platform, hd, 'Library', 'LaunchAgents', 'com.serfab.cadre-host.plist');
    }
    case 'win32': {
      // NSSM stores service config in the registry; this path is unused
      // on Windows but returned for symmetry / logging.
      return 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CadreHost';
    }
  }
}
