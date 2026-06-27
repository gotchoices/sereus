import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { loadProtobufPrivateKey, resolveConfig } from '../src/config/loader.js';

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

describe('resolveConfig identity.keyFile', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  /** Write a minimal valid config that points `identity.keyFile` at `keyFile`. */
  function writeConfig(dir: string, keyFile: string): string {
    const configPath = join(dir, 'cadre.json');
    writeFileSync(configPath, JSON.stringify({
      identity: { keyFile },
      controlNetwork: { partyId: 'test-party', bootstrapNodes: [] },
      profile: 'storage',
      storage: { type: 'memory' },
    }));
    return configPath;
  }

  // Regression: `cadre enroll create` writes the *protobuf* private key as hex
  // (uint8ArrayToString(privateKeyToProtobuf(pk), 'hex')). The keyFile loader
  // previously fed those bytes straight to privateKeyFromRaw, which threw
  // "No decoder for tag 8" — so a freshly-enrolled identity could not start a node.
  it("loads a keyFile written by 'cadre enroll create' (hex-encoded protobuf)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-enroll-'));
    tmpDirs.push(dir);

    const original = await generateKeyPair('Ed25519');
    const keyFile = join(dir, 'node.key');
    writeFileSync(keyFile, uint8ArrayToString(privateKeyToProtobuf(original), 'hex'));

    const resolved = await resolveConfig(writeConfig(dir, keyFile));

    expect(resolved.privateKey).toBeDefined();
    expect(peerIdFromPrivateKey(resolved.privateKey!).toString())
      .toBe(peerIdFromPrivateKey(original).toString());
  });

  // Backward-compat: a bare raw key (hex) still loads via the fallback decoder.
  it('loads a keyFile holding a raw key as hex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-raw-'));
    tmpDirs.push(dir);

    const original = await generateKeyPair('Ed25519');
    const keyFile = join(dir, 'node.key');
    writeFileSync(keyFile, uint8ArrayToString(original.raw, 'hex'));

    const resolved = await resolveConfig(writeConfig(dir, keyFile));

    expect(resolved.privateKey).toBeDefined();
    expect(peerIdFromPrivateKey(resolved.privateKey!).toString())
      .toBe(peerIdFromPrivateKey(original).toString());
  });
});
