import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnvironmentOverrides, checkEnvNames } from '../src/config/index.js';

/**
 * A `CADRE_*` variable the node does not recognise fails start, and recognised ones are parsed
 * strictly. These pin the name check's branches, strict value parsing, and — the one that keeps a
 * launcher from shipping a node that refuses to start — that every variable the repo's own
 * launchers set is recognised.
 */

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files that set or document variables for a cadre-cli node process. */
const LAUNCHER_FILES = [
  'docker/Dockerfile',
  'docker/docker-compose.yml',
  'docker/entrypoint.sh',
  'docker/env.example',
  'contrib/cadre-node.service',
  'contrib/cadre-install.sh',
  '../cadre-provider/src/service/container-env.ts',
];

describe('CADRE_* variable names', () => {
  it('rejects every unknown variable in one error, suggesting the nearest name', () => {
    const env = {
      CADRE_LISTEN_ADDR: '/ip4/0.0.0.0/tcp/1',
      CADRE_ENROLLMENT_TOKEN: 'abc',
      // Skipped: cadre-host's own settings, and a set-but-empty value (compose's `${X:-}`).
      CADRE_HOST_DATA_DIR: '/var/lib/cadre-host',
      CADRE_UNSET_TYPO: '',
    };

    expect(() => checkEnvNames(env)).toThrow(
      'Unknown environment variable CADRE_LISTEN_ADDR (did you mean CADRE_LISTEN_ADDRS?)\n'
      + 'Unknown environment variable CADRE_ENROLLMENT_TOKEN',
    );
  });

  it('recognises every CADRE_* variable the repo\'s launchers set', () => {
    const names = new Set(
      LAUNCHER_FILES.flatMap((file) => readFileSync(resolve(PACKAGE_DIR, file), 'utf8').match(/\bCADRE_[A-Z0-9_]+\b/g) ?? []),
    );
    // Guards against a vacuous pass if the files move.
    expect(names.size).toBeGreaterThan(20);

    expect(() => checkEnvNames(Object.fromEntries([...names].map((name) => [name, 'x'])))).not.toThrow();
  });
});

describe('CADRE_* value parsing', () => {
  it.each([
    ['CADRE_ENABLE_RELAY', 'yes', /Invalid CADRE_ENABLE_RELAY "yes": expected true, false, 1 or 0/],
    ['CADRE_STORAGE_QUOTA', '10G', /Invalid CADRE_STORAGE_QUOTA "10G": expected a number/],
  ])('rejects %s=%s rather than guessing', (name, value, message) => {
    expect(() => applyEnvironmentOverrides({}, { [name]: value })).toThrow(message);
  });
});
