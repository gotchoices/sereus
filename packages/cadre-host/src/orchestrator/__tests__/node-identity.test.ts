import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureNodeIdentity, nodeIdentityPath } from '../node-identity.js';

describe('ensureNodeIdentity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-node-id-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('generates an identity inside the workdir on first call', async () => {
    const { path, peerId } = await ensureNodeIdentity(tmp);
    expect(path).toBe(nodeIdentityPath(tmp));
    expect(path).toBe(join(tmp, 'identity.key'));
    expect(peerId).toMatch(/^12D3Koo/);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  // Reuse — not rotation — is the load-bearing property: a re-spawn of the same
  // container must land on the same peer id or the cadre that admitted it sees a
  // stranger.
  it('reuses the existing key on a second call', async () => {
    const first = await ensureNodeIdentity(tmp);
    const bytesBefore = readFileSync(first.path);

    const second = await ensureNodeIdentity(tmp);
    expect(second.peerId).toBe(first.peerId);
    expect(readFileSync(second.path).equals(bytesBefore)).toBe(true);
  });

  it('creates the workdir when it does not exist yet', async () => {
    const workdir = join(tmp, 'nested', 'donated-1');
    const { path, peerId } = await ensureNodeIdentity(workdir);
    expect(path).toBe(join(workdir, 'identity.key'));
    expect(peerId).toMatch(/^12D3Koo/);
  });

  // A key that is present but unreadable must FAIL the spawn, not fall through
  // to `generateIdentity`. Regenerating would hand the cadre a stranger under
  // the same containerId — silently reproducing the bug this module exists to
  // fix — where a throw surfaces the damaged file to the operator.
  it('throws rather than re-keying when the existing file does not decode', async () => {
    const path = nodeIdentityPath(tmp);
    writeFileSync(path, 'not a protobuf private key', 'utf8');

    await expect(ensureNodeIdentity(tmp)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('not a protobuf private key');
  });

  it.runIf(process.platform !== 'win32')('persists with mode 0600 on POSIX', async () => {
    const { path } = await ensureNodeIdentity(tmp);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
