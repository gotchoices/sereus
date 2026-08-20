/**
 * `host.config.json` schema + I/O.
 *
 * This file captures the wizard's output. Subsystems (trust-circle, NAT,
 * orchestrator) each own their own files under `<dataDir>/`; this is NOT
 * an umbrella config.
 *
 * Schema version: 2. `version` is a forward guard — a file whose version
 * does not match `CURRENT_VERSION` is rejected on read rather than
 * reinterpreted, so a future incompatible layout fails loudly instead of
 * being silently misread.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UpdatesConfig {
  /** When true, the daily-check timer auto-applies updates. Default false. */
  autoApply: boolean;
  /** Optional override for the manifest URL (env var still wins). */
  manifestUrl?: string;
}

/**
 * Whether this host also runs its own personal cadre (the opt-in "founder"
 * persona), on top of the always-on node-donor role.
 *
 * Default (absent or `enabled: false`) is donor-only: `cadre-host start` brings
 * up the donation surface but spawns **no** owner node, so the trust-circle and
 * NAT surfaces stay inactive. Set `enabled: true` (install-time choice) to also
 * spawn the host's own owner node and enable `/auth` + `/nat`. See
 * docs/cadre-host.md § Two roles: donor and founder.
 */
export interface OwnCadreConfig {
  /** When true, `start` spawns the host-owned owner node + trust-circle + NAT. */
  enabled: boolean;
}

/**
 * Non-secret push (FCM/APNs) settings. The actual private keys (and the FCM
 * service-account / APNs key identifiers) live in the secret store — see
 * `src/push/`. Only these app-config bits, which are safe to keep in plaintext
 * `host.config.json`, are stored here. Absent ⇒ push is not configured.
 */
export interface PushSettings {
  /** APNs app-config (the `.p8` private key + key/team ids stay in the secret store). */
  apns?: {
    /** App bundle id → APNs `apns-topic` header. */
    bundleId: string;
    /** `true` → production APNs host; false/undefined → sandbox (dev/TestFlight). */
    production?: boolean;
  };
  /** Per-(peer,strand) anti-spam cooldown (ms) forwarded into the node's push block. */
  cooldownMs?: number;
  /** Per-strand burst-coalescing window (ms) forwarded into the node's push block. */
  debounceMs?: number;
}

export interface HostConfigFile {
  version: 2;
  /** A stable per-install id; useful for log correlation and the control-network partyId. */
  installId: string;
  /** Localhost-only management UI + API listener port. */
  uiPort: number;
  /** External cadre libp2p port (NAT will map to this). */
  libp2pPort: number;
  /** Self-reference (convenient for service-host ExecStart). */
  dataDir: string;
  /** Absolute path to the Ed25519 protobuf identity. */
  identityPath: string;
  /** Whether UPnP/NAT-PMP should be attempted at start time. */
  upnpEnabled: boolean;
  /** ISO timestamp the wizard wrote this file. */
  installedAt: string;
  /** Installer (= package) version that wrote this file. */
  installerVersion: string;
  /** Update-flow settings; defaults: { autoApply: false }. */
  updates: UpdatesConfig;
  /**
   * Host-own-cadre (founder persona) opt-in. Optional — absent is treated as
   * `{ enabled: false }` (donor-only). Written by the installer; read via
   * `hostOwnsCadre()`. Not editable through /api/settings (install-time only).
   */
  ownCadre?: OwnCadreConfig;
  /**
   * Non-secret push settings (bundle id, sandbox/prod toggle, cooldown/debounce).
   * Optional — absent when push is not configured. Private keys never live here;
   * they are read from the secret store at node-spawn time (`src/push/`).
   */
  push?: PushSettings;
}

/**
 * Whether this host runs its own personal cadre (founder persona). Absent
 * `ownCadre` ⇒ donor-only (false). The single source of truth for the
 * founder/donor gate in `bin/host.ts start`.
 */
export function hostOwnsCadre(cfg: HostConfigFile): boolean {
  return cfg.ownCadre?.enabled === true;
}

const CURRENT_VERSION = 2;

export function writeHostConfig(filePath: string, cfg: HostConfigFile): void {
  if (cfg.version !== CURRENT_VERSION) {
    throw new Error(`Refusing to write host.config.json with version=${cfg.version} (current: ${CURRENT_VERSION})`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** Apply a partial patch to the persisted config (read-modify-write). */
export function updateHostConfig(
  filePath: string,
  patch: Partial<Omit<HostConfigFile, 'version'>>,
): HostConfigFile {
  const current = readHostConfig(filePath);
  const next: HostConfigFile = {
    ...current,
    ...patch,
    updates: { ...current.updates, ...(patch.updates ?? {}) },
    version: CURRENT_VERSION,
  };
  writeHostConfig(filePath, next);
  return next;
}

export function readHostConfig(filePath: string): HostConfigFile {
  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse host.config.json at ${filePath}: ${(err as Error).message}`, { cause: err });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`host.config.json at ${filePath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== CURRENT_VERSION) {
    throw new Error(
      `host.config.json at ${filePath} has unsupported version=${obj.version} (this build expects ${CURRENT_VERSION})`,
    );
  }
  if (!isHostConfigShape(obj)) {
    throw new Error(`host.config.json at ${filePath} is missing required fields`);
  }
  return obj;
}

function isHostConfigShape(v: unknown): v is HostConfigFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.installId !== 'string' ||
    typeof o.uiPort !== 'number' ||
    typeof o.libp2pPort !== 'number' ||
    typeof o.dataDir !== 'string' ||
    typeof o.identityPath !== 'string' ||
    typeof o.upnpEnabled !== 'boolean' ||
    typeof o.installedAt !== 'string' ||
    typeof o.installerVersion !== 'string'
  ) {
    return false;
  }
  const updates = o.updates as Record<string, unknown> | undefined;
  if (!updates || typeof updates !== 'object') return false;
  if (typeof updates.autoApply !== 'boolean') return false;
  if (updates.manifestUrl !== undefined && typeof updates.manifestUrl !== 'string') return false;
  if (o.ownCadre !== undefined) {
    const own = o.ownCadre as Record<string, unknown>;
    if (!own || typeof own !== 'object' || typeof own.enabled !== 'boolean') return false;
  }
  return true;
}
