import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { loadProtobufPrivateKey } from '../src/config/loader.js';

describe('loadProtobufPrivateKey', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  it("loads the installer's protobuf identity.key and round-trips the peer id", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-id-'));
    tmpDirs.push(dir);

    // Mimic cadre-host's installer: write a libp2p protobuf-encoded Ed25519 key.
    const original = await generateKeyPair('Ed25519');
    const keyPath = join(dir, 'identity.key');
    writeFileSync(keyPath, privateKeyToProtobuf(original));

    const loaded = loadProtobufPrivateKey(keyPath);

    expect(peerIdFromPrivateKey(loaded).toString()).toBe(peerIdFromPrivateKey(original).toString());
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => loadProtobufPrivateKey(join(tmpdir(), 'does-not-exist-cadre.key')))
      .toThrow(/not found/);
  });
});
