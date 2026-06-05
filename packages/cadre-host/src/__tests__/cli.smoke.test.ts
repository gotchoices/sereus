/**
 * Smoke test: invokes the compiled CLI with --help and asserts the expected
 * subcommands are listed. Relies on `yarn build` having produced dist/bin/host.js.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '../../dist/bin/host.js');

// These smoke tests cold-start the built CLI as a child process (Node boot +,
// for some, an HTTP server). That comfortably exceeds vitest's 5s default under
// heavy parallel load, so give the subprocess generous headroom.
vi.setConfig({ testTimeout: 30000 });

describe('cadre-host CLI smoke test', () => {
  it('prints help with all subcommands', () => {
    if (!existsSync(binPath)) {
      throw new Error(`cadre-host bin not built at ${binPath}; run \`yarn build\` first`);
    }

    const stdout = execFileSync(process.execPath, [binPath, '--help'], {
      encoding: 'utf8',
    });

    expect(stdout.length).toBeGreaterThan(0);
    for (const cmd of ['install', 'start', 'status', 'invite', 'uninstall']) {
      expect(stdout).toContain(cmd);
    }
  });

  it('prints version', () => {
    if (!existsSync(binPath)) {
      throw new Error(`cadre-host bin not built at ${binPath}; run \`yarn build\` first`);
    }

    const stdout = execFileSync(process.execPath, [binPath, '--version'], {
      encoding: 'utf8',
    });
    expect(stdout.trim().length).toBeGreaterThan(0);
  });
});
