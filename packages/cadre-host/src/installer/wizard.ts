/**
 * Interactive install wizard.
 *
 * Pure readline — no extra deps. Each prompt is decomposed into a small
 * `Prompt` so the test can drive the wizard with a scripted Iterable of
 * answers. Production code wires the prompts to stdin.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import { defaultDataDir } from './paths.js';
import type { SupportedPlatform } from './platform.js';

export interface WizardDefaults {
  dataDir: string;
  uiPort: number;
  libp2pPort: number;
  upnpEnabled: boolean;
  /** Also run the host's own personal cadre here (founder persona). Default false. */
  ownCadre: boolean;
}

export interface WizardAnswers {
  dataDir: string;
  uiPort: number;
  libp2pPort: number;
  upnpEnabled: boolean;
  configureDdns: boolean;
  /** Also run the host's own personal cadre here (founder persona). */
  ownCadre: boolean;
}

export const DEFAULT_UI_PORT = 8765;
export const DEFAULT_LIBP2P_PORT = 4001;

export function defaultsForPlatform(platform: SupportedPlatform): WizardDefaults {
  return {
    dataDir: defaultDataDir(platform),
    uiPort: DEFAULT_UI_PORT,
    libp2pPort: DEFAULT_LIBP2P_PORT,
    upnpEnabled: true,
    ownCadre: false,
  };
}

/**
 * Drive the wizard with a function that returns the next user answer for
 * a prompt. Used both by the readline-backed `runWizard` and by tests.
 */
export async function runWizardWith(
  defaults: WizardDefaults,
  ask: (label: string, fallback: string) => Promise<string>,
): Promise<WizardAnswers> {
  const dataDir = (await ask('Data directory', defaults.dataDir)).trim() || defaults.dataDir;
  const uiPort = parsePort(await ask('UI port (localhost only)', String(defaults.uiPort)), defaults.uiPort);
  const libp2pPort = parsePort(await ask('Cadre libp2p port', String(defaults.libp2pPort)), defaults.libp2pPort);
  const upnpEnabled = parseBool(
    await ask('Attempt UPnP port mapping on this network? [Y/n]', defaults.upnpEnabled ? 'Y' : 'n'),
    defaults.upnpEnabled,
  );
  const configureDdns = parseBool(await ask('Configure DDNS now? [y/N]', 'N'), false);
  // Founder persona (opt-in). Most installs just donate nodes to friends and
  // answer no — a no leaves cadre-host donor-only (no owner node, no /auth+/nat).
  const ownCadre = parseBool(
    await ask('Also run your own personal cadre on this machine? (most people just donating nodes to friends say no) [y/N]', defaults.ownCadre ? 'Y' : 'N'),
    defaults.ownCadre,
  );
  return { dataDir, uiPort, libp2pPort, upnpEnabled, configureDdns, ownCadre };
}

/** Production entrypoint — drives the wizard over stdin/stdout. */
export async function runWizard(defaults: WizardDefaults): Promise<WizardAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runWizardWith(defaults, async (label, fallback) => prompt(rl, label, fallback));
  } finally {
    rl.close();
  }
}

function prompt(rl: ReadlineInterface, label: string, fallback: string): Promise<string> {
  return new Promise<string>((resolve) => {
    rl.question(`${label} [${fallback}]: `, (answer) => resolve(answer));
  });
}

function parsePort(input: string, fallback: number): number {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid port: ${input}`);
  }
  return n;
}

function parseBool(input: string, fallback: boolean): boolean {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return fallback;
  if (['y', 'yes', 'true', '1'].includes(trimmed)) return true;
  if (['n', 'no', 'false', '0'].includes(trimmed)) return false;
  throw new Error(`Invalid yes/no answer: ${input}`);
}
