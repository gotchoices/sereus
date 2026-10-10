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
  upnpEnabled: boolean;
  /** Values a command-line flag already supplied: the wizard does not ask for them again. */
  given?: { dataDir?: boolean; uiPort?: boolean; upnpEnabled?: boolean };
  /**
   * The public IPv4 an interface holds (`publicInterfaceAddress`), when one does: the machine is
   * reached directly (a VPS), so there is no router to ask about UPnP.
   */
  publicInterfaceIp?: string | null;
}

export interface WizardAnswers {
  dataDir: string;
  uiPort: number;
  upnpEnabled: boolean;
}

export const DEFAULT_UI_PORT = 8765;

export function defaultsForPlatform(platform: SupportedPlatform): WizardDefaults {
  return {
    dataDir: defaultDataDir(platform),
    uiPort: DEFAULT_UI_PORT,
    upnpEnabled: true,
  };
}

/**
 * Drive the wizard with a function that returns the next user answer for
 * a prompt. Used both by the readline-backed `runWizard` and by tests.
 */
export async function runWizardWith(
  defaults: WizardDefaults,
  ask: (label: string, fallback: string) => Promise<string>,
  say: (line: string) => void = () => {},
): Promise<WizardAnswers> {
  const given = defaults.given ?? {};
  const dataDir = given.dataDir ? defaults.dataDir : (await ask('Data directory', defaults.dataDir)).trim() || defaults.dataDir;
  const uiPort = given.uiPort
    ? defaults.uiPort
    : parsePort(await ask('UI port (localhost only)', String(defaults.uiPort)), defaults.uiPort);
  let upnpEnabled = defaults.upnpEnabled;
  if (defaults.publicInterfaceIp) {
    say(`This machine has a public IP address (${defaults.publicInterfaceIp}), so it is reached directly: no router, no UPnP.`);
  } else if (!given.upnpEnabled) {
    upnpEnabled = parseBool(
      await ask('This machine is behind a router. Ask it to map ports automatically (UPnP)? [Y/n]', defaults.upnpEnabled ? 'Y' : 'n'),
      defaults.upnpEnabled,
    );
  }
  return { dataDir, uiPort, upnpEnabled };
}

/** Production entrypoint — drives the wizard over stdin/stdout. */
export async function runWizard(defaults: WizardDefaults): Promise<WizardAnswers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runWizardWith(defaults, async (label, fallback) => prompt(rl, label, fallback), (line) => console.log(line));
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
