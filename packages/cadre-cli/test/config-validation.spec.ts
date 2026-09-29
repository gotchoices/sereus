import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedConfig } from '../src/config/index.js';

/**
 * The config file is checked strictly at start: an unknown, retired or ill-typed key stops the
 * node naming the key and where it came from. These pin the ticket's reproduction (a typo that
 * used to be ignored), the case that used to yield a node with no storage, the attribution of a
 * bad value to the variable that wrote it, the one-run report of every problem, and that the CLI
 * accepts its own shipped example. Per-field type checks are not tested: the field tables are
 * compile-checked against the config type and the checkers are one-liners.
 */

const EXAMPLE_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../example.cadre.yaml');

const VALID = {
  controlNetwork: { partyId: 'party-1', bootstrapNodes: [] },
  profile: 'storage',
  storage: { type: 'memory' },
};

/** The message a rejected config throws with; fails the test when the config is accepted. */
async function rejection(loading: Promise<unknown>): Promise<string> {
  try {
    await loading;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the config to be rejected');
}

describe('config file validation', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  /** Write `body` as a JSON config in a fresh temp dir and hand back its path. */
  function writeConfig(body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-cfg-validate-'));
    tmpDirs.push(dir);
    const configPath = join(dir, 'cadre.json');
    writeFileSync(configPath, JSON.stringify(body), 'utf8');
    return configPath;
  }

  // The ticket's reproduction: this key was never read, so the node silently listened on defaults.
  it('rejects a misspelled key, naming it, the file, and the key it probably meant', async () => {
    const configPath = writeConfig({ ...VALID, network: { listenAddr: ['/ip4/0.0.0.0/tcp/4001'] } });

    const message = await rejection(loadValidatedConfig(configPath, {}));

    expect(message).toContain(`Config ${configPath}:`);
    expect(message).toContain("unknown key network.listenAddr (did you mean 'listenAddrs'?)");
  });

  // Used to fall through `resolveStorageConfig` and start the node with no storage at all.
  it('rejects a value outside the accepted set, naming the key and the accepted values', async () => {
    const message = await rejection(loadValidatedConfig(writeConfig({ ...VALID, storage: { type: 'fs' } }), {}));

    expect(message).toContain(`storage.type must be one of 'memory', 'file', got "fs"`);
  });

  it('attributes a bad value to the environment variable that wrote it, not to the file', async () => {
    const configPath = writeConfig(VALID);

    const message = await rejection(loadValidatedConfig(configPath, { CADRE_STORAGE_TYPE: 'fs' }));

    expect(message).toContain("Environment variable CADRE_STORAGE_TYPE: storage.type must be one of 'memory', 'file'");
    expect(message).not.toContain(configPath);
  });

  it('reports every problem in one error rather than stopping at the first', async () => {
    const configPath = writeConfig({ ...VALID, hibernation: { enabled: 'yes' }, network: { listenAddr: [] } });

    const message = await rejection(loadValidatedConfig(configPath, {}));

    expect(message).toContain('hibernation.enabled must be a boolean (true or false), got "yes"');
    expect(message).toContain('unknown key network.listenAddr');
  });

  // The CLI must never reject its own shipped configs.
  it('accepts the shipped example.cadre.yaml with no environment', async () => {
    await expect(loadValidatedConfig(EXAMPLE_CONFIG, {})).resolves.toMatchObject({ profile: 'storage' });
  });
});
