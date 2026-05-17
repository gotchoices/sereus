/**
 * `host.config.json` schema + I/O.
 *
 * This file captures the wizard's output. Subsystems (trust-circle, NAT,
 * orchestrator) each own their own files under `<dataDir>/`; this is NOT
 * an umbrella config.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HostConfigFile {
  version: 1;
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
}

const CURRENT_VERSION = 1;

export function writeHostConfig(filePath: string, cfg: HostConfigFile): void {
  if (cfg.version !== CURRENT_VERSION) {
    throw new Error(`Refusing to write host.config.json with version=${cfg.version} (current: ${CURRENT_VERSION})`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function readHostConfig(filePath: string): HostConfigFile {
  const raw = readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse host.config.json at ${filePath}: ${(err as Error).message}`);
  }
  if (!isHostConfigShape(parsed)) {
    throw new Error(`host.config.json at ${filePath} is missing required fields`);
  }
  if (parsed.version !== CURRENT_VERSION) {
    throw new Error(
      `host.config.json at ${filePath} has unsupported version=${parsed.version} (this build expects ${CURRENT_VERSION})`,
    );
  }
  return parsed;
}

function isHostConfigShape(v: unknown): v is HostConfigFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === 'number' &&
    typeof o.installId === 'string' &&
    typeof o.uiPort === 'number' &&
    typeof o.libp2pPort === 'number' &&
    typeof o.dataDir === 'string' &&
    typeof o.identityPath === 'string' &&
    typeof o.upnpEnabled === 'boolean' &&
    typeof o.installedAt === 'string' &&
    typeof o.installerVersion === 'string'
  );
}
