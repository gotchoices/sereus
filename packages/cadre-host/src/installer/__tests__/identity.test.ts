import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateIdentity, loadIdentity } from '../identity.js';

describe('installer identity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-host-id-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips an Ed25519 keypair through the file', async () => {
    const path = join(tmp, 'identity.key');
    const generated = await generateIdentity(path);
    expect(generated.peerId).toMatch(/^12D3Koo/);

    const loaded = loadIdentity(path);
    expect(loaded.peerId).toBe(generated.peerId);
  });

  it.runIf(process.platform !== 'win32')('persists with mode 0600 on POSIX', async () => {
    const path = join(tmp, 'identity.key');
    await generateIdentity(path);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
