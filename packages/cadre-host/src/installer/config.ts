/**
 * `host.config.json` schema + I/O.
 *
 * This file captures the wizard's output. Subsystems (hosted nodes, NAT,
 * orchestrator) each own their own files under `<dataDir>/`; this is NOT
 * an umbrella config.
 *
 * Schema version: 3. `version` is a forward guard — a file whose version
 * does not match `CURRENT_VERSION` is rejected on read rather than
 * reinterpreted, so a future incompatible layout fails loudly instead of
 * being silently misread.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';

export interface UpdatesConfig {
  /** When true, the daily-check timer auto-applies updates. Default false. */
  autoApply: boolean;
  /** Optional override for the manifest URL (env var still wins). */
  manifestUrl?: string;
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

/**
 * Which addresses a hosted node's QR code carries (cadre-core's `selectNodeClaimAddresses`).
 * Absent ⇒ `{ lan: 'auto' }`. Read on every claim-code request, so an edit applies to the
 * next code shown.
 */
export interface ClaimAddressSettings {
  /**
   * The LAN address a phone at home dials: `'auto'` (the address on the router's subnet, else
   * the machine's primary one), `'none'` (public addresses only), or an IP address. Other
   * private addresses (Docker bridges, VPNs) are left out either way.
   */
  lan?: string;
  /**
   * Exact addresses to put in every code instead (each without `/p2p/`; the node's peer id is
   * appended), for an operator who knows better than the rule, such as one name behind a proxy.
   */
  addrs?: string[];
}

/** Why a `claimAddresses` value is unacceptable, naming the field; undefined when it is fine. */
export function claimAddressSettingsProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '"claimAddresses" must be an object';
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'lan' && key !== 'addrs') return `Unknown setting "claimAddresses.${key}"`;
  }
  if (o.lan !== undefined) {
    if (typeof o.lan !== 'string' || (o.lan !== 'auto' && o.lan !== 'none' && isIP(o.lan) === 0)) {
      return '"claimAddresses.lan" must be "auto", "none" or an IP address';
    }
  }
  if (o.addrs !== undefined) {
    if (!Array.isArray(o.addrs) || !o.addrs.every((a) => typeof a === 'string')) {
      return '"claimAddresses.addrs" must be a list of multiaddr strings';
    }
    for (const addr of o.addrs as string[]) {
      try {
        multiaddr(addr.trim());
      } catch {
        return `"claimAddresses.addrs" entry "${addr}" is not a valid multiaddr`;
      }
    }
  }
  return undefined;
}

export interface HostConfigFile {
  version: 3;
  /** A stable per-install id, for log correlation. */
  installId: string;
  /** Localhost-only management UI + API listener port. */
  uiPort: number;
  /** Self-reference (convenient for service-host ExecStart). */
  dataDir: string;
  /** Whether UPnP/NAT-PMP should be attempted at start time. */
  upnpEnabled: boolean;
  /** ISO timestamp the wizard wrote this file. */
  installedAt: string;
  /** Installer (= package) version that wrote this file. */
  installerVersion: string;
  /** Update-flow settings; defaults: { autoApply: false }. */
  updates: UpdatesConfig;
  /**
   * Non-secret push settings (bundle id, sandbox/prod toggle, cooldown/debounce).
   * Optional — absent when push is not configured. Private keys never live here;
   * they are read from the secret store at node-spawn time (`src/push/`).
   */
  push?: PushSettings;
  /** Which addresses claim codes carry; absent ⇒ automatic. */
  claimAddresses?: ClaimAddressSettings;
}

const CURRENT_VERSION = 3;

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
    typeof o.dataDir !== 'string' ||
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
  return true;
}
