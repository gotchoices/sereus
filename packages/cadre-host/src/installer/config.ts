/**
 * `host.config.json` schema + I/O.
 *
 * This file captures the wizard's output. Subsystems (trust-circle, NAT,
 * orchestrator) each own their own files under `<dataDir>/`; this is NOT
 * an umbrella config.
 *
 * Schema versions:
 *   v1 — initial layout from 6.4.1.
 *   v2 — adds `updates: { autoApply, manifestUrl? }` for the update-flow
 *        (6.4.2). v1 files are silently upgraded on read with autoApply=false.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface UpdatesConfig {
  /** When true, the daily-check timer auto-applies updates. Default false. */
  autoApply: boolean;
  /** Optional override for the manifest URL (env var still wins). */
  manifestUrl?: string;
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
    version: 2,
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
    throw new Error(`Failed to parse host.config.json at ${filePath}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`host.config.json at ${filePath} is not a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version === 1) {
    // Silent in-place upgrade. v1 lacks `updates`; default to notify-only.
    const upgraded = upgradeV1(obj, filePath);
    writeHostConfig(filePath, upgraded);
    return upgraded;
  }
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

/** v1 → v2 migration: stamp `updates: { autoApply: false }` and bump version. */
function upgradeV1(obj: Record<string, unknown>, filePath: string): HostConfigFile {
  if (!isV1Shape(obj)) {
    throw new Error(`host.config.json at ${filePath} is missing required v1 fields`);
  }
  return {
    version: 2,
    installId: obj.installId as string,
    uiPort: obj.uiPort as number,
    libp2pPort: obj.libp2pPort as number,
    dataDir: obj.dataDir as string,
    identityPath: obj.identityPath as string,
    upnpEnabled: obj.upnpEnabled as boolean,
    installedAt: obj.installedAt as string,
    installerVersion: obj.installerVersion as string,
    updates: { autoApply: false },
  };
}

function isV1Shape(v: Record<string, unknown>): boolean {
  return (
    typeof v.installId === 'string' &&
    typeof v.uiPort === 'number' &&
    typeof v.libp2pPort === 'number' &&
    typeof v.dataDir === 'string' &&
    typeof v.identityPath === 'string' &&
    typeof v.upnpEnabled === 'boolean' &&
    typeof v.installedAt === 'string' &&
    typeof v.installerVersion === 'string'
  );
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
  return true;
}
