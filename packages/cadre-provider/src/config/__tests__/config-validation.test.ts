import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../loader.js';

/**
 * The config file and the environment are checked strictly at start: an unknown or ill-typed
 * key stops the provider naming the key and where it came from. These pin the ticket's two
 * reproductions (a typo that used to apply the default, and a stray key under `push` that used
 * to be forwarded to every tenant node), the attribution of a bad value to the variable that
 * wrote it, a variable applied on its own (they used to be read in groups), and that the
 * provider accepts its own shipped example. Per-field type checks are not tested: the field
 * tables are compile-checked against the config type and the checkers are one-liners.
 */

const EXAMPLE_CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../../../example.provider.yaml');

const FCM = { projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: 'FCM-PRIVATE-KEY-PEM' };
const APNS_KEY_PASTED_AS_BLOCK = '-----BEGIN PRIVATE KEY-----\nP8-SECRET-BODY\n-----END PRIVATE KEY-----';

/** The message a rejected config throws with; fails the test when the config is accepted. */
function rejection(load: () => unknown): string {
  try {
    load();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the config to be rejected');
}

describe('provider config validation', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  /** Write `body` as a JSON config in a fresh temp dir and hand back its path. */
  function writeConfig(body: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'provider-cfg-validate-'));
    tmpDirs.push(dir);
    const configPath = join(dir, 'provider.json');
    writeFileSync(configPath, JSON.stringify(body), 'utf8');
    return configPath;
  }

  // The typo used to be ignored and the default port applied. The variable writes the sibling
  // key `server.port`, so the problem is still the file's, not the variable's.
  it('rejects a misspelled key, naming it, the file, and the key it probably meant', () => {
    const configPath = writeConfig({ server: { prot: 3000 } });

    const message = rejection(() => loadConfig({ configFile: configPath, env: { PROVIDER_PORT: '4000' } }));

    expect(message).toContain(`Config ${configPath}: unknown key server.prot (did you mean 'port'?)`);
  });

  // The cross-package defect: this key used to be forwarded verbatim in CADRE_PUSH, and every
  // node of the tenant refused to boot. Nothing under `push` is echoed, so a private key pasted
  // where a mapping belongs stays out of the error too.
  it('rejects an unknown key inside a tenant push block without echoing any secret', () => {
    const configPath = writeConfig({
      push: { tenants: { acme: { fcm: { ...FCM, projectID: 'proj' }, apns: APNS_KEY_PASTED_AS_BLOCK } } },
    });

    const message = rejection(() => loadConfig({ configFile: configPath, env: {} }));

    expect(message).toContain("unknown key push.tenants.acme.fcm.projectID (did you mean 'projectId'?)");
    expect(message).toContain('push.tenants.acme.apns must be a mapping of keys, got a string');
    expect(message).not.toContain(FCM.privateKey);
    expect(message).not.toContain('P8-SECRET-BODY');
  });

  it('attributes a bad value to the variable that wrote it', () => {
    const message = rejection(() => loadConfig({ env: { PROVIDER_AUTH_MODE: 'apikey' } }));

    expect(message).toContain(
      "Environment variable PROVIDER_AUTH_MODE: auth.mode must be one of 'none', 'api-key', 'oauth', got \"apikey\"",
    );
  });

  // The acknowledgement variable used to be read only when PROVIDER_AUTH_MODE was also set,
  // so the mode-none error's own advice ("or PROVIDER_ALLOW_INSECURE_NO_AUTH=true") did nothing.
  it('applies a variable on its own over a file that sets a sibling key', () => {
    const configPath = writeConfig({ auth: { mode: 'none' } });

    const config = loadConfig({ configFile: configPath, env: { PROVIDER_ALLOW_INSECURE_NO_AUTH: 'true' } });

    expect(config.auth.mode).toBe('none');
    expect(config.auth.allowInsecureNoAuth).toBe(true);
  });

  it('accepts the shipped example config', () => {
    const config = loadConfig({ configFile: EXAMPLE_CONFIG, env: {} });

    expect(config.storage).toEqual({ type: 'file', path: '/data/provider' });
  });
});
