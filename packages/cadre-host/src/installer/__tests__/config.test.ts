import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHostConfig, updateHostConfig, writeHostConfig, hostOwnsCadre, type HostConfigFile } from '../config.js';

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

  it('rejects v1 files without rewriting them', () => {
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
    const raw = JSON.stringify(v1);
    writeFileSync(path, raw);
    expect(() => readHostConfig(path)).toThrow(/unsupported version=1/);
    expect(readFileSync(path, 'utf8')).toBe(raw);
  });

  it('rejects unknown versions', () => {
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, JSON.stringify({ ...makeCfg(), version: 99 }));
    expect(() => readHostConfig(path)).toThrow(/unsupported version=99/);
  });

  it('rejects a file with no version field', () => {
    const { version: _version, ...noVersion } = makeCfg();
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, JSON.stringify(noVersion));
    expect(() => readHostConfig(path)).toThrow(/unsupported version=undefined/);
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

  it('update patches fields and re-stamps the current version', () => {
    const path = join(tmp, 'host.config.json');
    writeHostConfig(path, makeCfg());
    const next = updateHostConfig(path, { updates: { autoApply: true } });
    expect(next.version).toBe(2);
    expect(next.updates).toEqual({ autoApply: true });
    expect(next.installId).toBe('abc123');
    expect(readHostConfig(path)).toEqual(next);
  });

  it('update never lets a patch downgrade the version', () => {
    const path = join(tmp, 'host.config.json');
    writeHostConfig(path, makeCfg());
    const patch = { version: 1 } as unknown as Partial<Omit<HostConfigFile, 'version'>>;
    expect(updateHostConfig(path, patch).version).toBe(2);
    expect(readHostConfig(path).version).toBe(2);
  });

  it('round-trips ownCadre and hostOwnsCadre reflects it', () => {
    const path = join(tmp, 'host.config.json');
    const cfg = makeCfg({ ownCadre: { enabled: true } });
    writeHostConfig(path, cfg);
    const read = readHostConfig(path);
    expect(read.ownCadre).toEqual({ enabled: true });
    expect(hostOwnsCadre(read)).toBe(true);
  });

  it('treats an absent ownCadre as donor-only (hostOwnsCadre false)', () => {
    // A pre-ownCadre v2 config (field absent) must read back cleanly and be
    // donor-only — no migration, field stays absent.
    const path = join(tmp, 'host.config.json');
    const cfg = makeCfg();
    writeHostConfig(path, cfg);
    const read = readHostConfig(path);
    expect(read.ownCadre).toBeUndefined();
    expect(hostOwnsCadre(read)).toBe(false);
  });

  it('rejects a malformed ownCadre shape', () => {
    const path = join(tmp, 'host.config.json');
    writeFileSync(path, JSON.stringify({ ...makeCfg(), ownCadre: { enabled: 'yes' } }));
    expect(() => readHostConfig(path)).toThrow(/missing required fields/);
  });
});
