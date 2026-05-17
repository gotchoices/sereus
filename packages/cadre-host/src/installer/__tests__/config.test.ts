import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHostConfig, writeHostConfig, type HostConfigFile } from '../config.js';

describe('host.config.json round-trip', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cadre-host-cfg-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeCfg(overrides: Partial<HostConfigFile> = {}): HostConfigFile {
    return {
      version: 2,
      installId: 'abc123',
      uiPort: 8765,
      libp2pPort: 4001,
      dataDir: tmp,
      identityPath: join(tmp, 'identity.key'),
      upnpEnabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
      installerVersion: '0.6.0',
      updates: { autoApply: false },
      ...overrides,
    };
  }

  it('writes and reads the same shape', () => {
    const cfg = makeCfg();
    const path = join(tmp, 'host.config.json');
    writeHostConfig(path, cfg);
    expect(readHostConfig(path)).toEqual(cfg);
  });

  it('upgrades v1 files in place on read', () => {
    const path = join(tmp, 'host.config.json');
    const v1 = {
      version: 1,
      installId: 'abc123',
      uiPort: 8765,
      libp2pPort: 4001,
      dataDir: tmp,
      identityPath: join(tmp, 'identity.key'),
      upnpEnabled: true,
      installedAt: '2026-01-01T00:00:00.000Z',
      installerVersion: '0.6.0',
    };
    writeFileSync(path, JSON.stringify(v1));
    const upgraded = readHostConfig(path);
    expect(upgraded.version).toBe(2);
    expect(upgraded.updates).toEqual({ autoApply: false });
    // Reading again should be idempotent and stay v2.
    const reRead = readHostConfig(path);
    expect(reRead.version).toBe(2);
  });

  it('rejects unknown versions', () => {
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, JSON.stringify({ ...makeCfg(), version: 99 }));
    expect(() => readHostConfig(path)).toThrow(/unsupported version=99/);
  });

  it('rejects malformed JSON', () => {
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, 'not json');
    expect(() => readHostConfig(path)).toThrow(/Failed to parse/);
  });

  it('rejects missing required fields', () => {
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, JSON.stringify({ version: 2, uiPort: 1234 }));
    expect(() => readHostConfig(path)).toThrow(/missing required fields/);
  });

  it('refuses to write the wrong version', () => {
    const path = join(tmp, 'host.config.json');
    expect(() => writeHostConfig(path, { ...makeCfg(), version: 3 as never })).toThrow(/version=3/);
  });
});
