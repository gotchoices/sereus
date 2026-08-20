import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { loadIdentityKey, resolveConfig } from '../src/config/loader.js';
import { enrollCommand } from '../src/commands/enroll.js';

/**
 * There is ONE on-disk identity format: a libp2p protobuf-encoded private key, written by
 * `cadre enroll create` and by cadre-host's installer. These tests pin both halves of that
 * claim — that the format loads, and that every *other* shape is rejected rather than guessed
 * at. The rejection half is the point: `privateKeyFromRaw` accepts any 64 bytes as an Ed25519
 * key without validating them, so the fallback decoder this spec used to assert turned a
 * truncated key file into a different, working identity and the node came up under a PeerId
 * nobody expected.
 */

/** The bytes `cadre enroll create` and cadre-host's installer both write. */
async function protobufKey() {
  const key = await generateKeyPair('Ed25519');
  return { key, bytes: privateKeyToProtobuf(key) };
}

describe('loadIdentityKey', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  function tmpDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `cadre-id-${tag}-`));
    tmpDirs.push(dir);
    return dir;
  }

  /** Write `bytes` as `<dir>/identity.key` and hand back the path. */
  function writeKeyFile(dir: string, bytes: Uint8Array | string): string {
    const keyPath = join(dir, 'identity.key');
    writeFileSync(keyPath, bytes);
    return keyPath;
  }

  it('loads a protobuf identity key and round-trips the peer id', async () => {
    const { key, bytes } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('ok'), bytes);

    expect(peerIdFromPrivateKey(loadIdentityKey(keyPath)).toString())
      .toBe(peerIdFromPrivateKey(key).toString());
  });

  it('throws a clear error when the file is missing', () => {
    expect(() => loadIdentityKey(join(tmpdir(), 'does-not-exist-cadre.key')))
      .toThrow(/not found/);
  });

  // THE regression test for this whole collapse. A bare raw key is exactly what the deleted
  // `privateKeyFromRaw` fallback used to accept — and it accepts ANY 64 bytes, so keeping the
  // fallback meant damaged files silently became different identities.
  it('rejects a bare raw 64-byte key (binary)', async () => {
    const { key } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('raw-bin'), key.raw);

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  it('rejects a bare raw 64-byte key written as hex text', async () => {
    const { key } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('raw-hex'), uint8ArrayToString(key.raw, 'hex'));

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  // 64 bytes is precisely the length `privateKeyFromRaw` would have taken, so this is the shape
  // that used to start a node under the WRONG peer id rather than failing it.
  it('rejects a protobuf truncated to 64 bytes', async () => {
    const { bytes } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('trunc64'), bytes.subarray(0, 64));

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  it('rejects a protobuf truncated mid-payload', async () => {
    const { bytes } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('trunc30'), bytes.subarray(0, 30));

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  // What `cadre enroll create` wrote BEFORE this change. An operator upgrading a container whose
  // key file predates it gets this error rather than a silently different identity.
  it('rejects hex text of a protobuf key', async () => {
    const { bytes } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('pb-hex'), uint8ArrayToString(bytes, 'hex'));

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  // A container killed part-way through `enroll create` can leave one of these behind.
  it('rejects an empty key file', () => {
    const keyPath = writeKeyFile(tmpDir('empty'), new Uint8Array(0));

    expect(() => loadIdentityKey(keyPath))
      .toThrow(/not a libp2p protobuf-encoded private key/);
  });

  // The libp2p detail is worth keeping for `--debug`, just not as the operator's first line.
  it('keeps the underlying decoder error as the cause', async () => {
    const { bytes } = await protobufKey();
    const keyPath = writeKeyFile(tmpDir('cause'), bytes.subarray(0, 64));

    expect(() => loadIdentityKey(keyPath)).toThrow(
      expect.objectContaining({ cause: expect.any(Error) }) as unknown as Error,
    );
  });
});

describe('enroll create → loadIdentityKey', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  // Closes the writer/reader loop: the two used to disagree on encoding (the writer emitted hex,
  // the protobuf reader wanted binary), which is the split this ticket collapsed. Asserting the
  // printed PeerId — not merely that the file decodes — also pins that the key on disk is the
  // key the operator was told to authorize.
  it('writes a key file that loads back to the peer id it printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-enroll-'));
    tmpDirs.push(dir);

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    await enrollCommand.parseAsync(['create', '--output', dir, '--name', 'node'], { from: 'user' });

    const printed = lines
      .map((line) => /^\s*Peer ID:\s+(\S+)$/.exec(line)?.[1])
      .find((id): id is string => id !== undefined);
    expect(printed, `no peer id in output: ${lines.join('\n')}`).toBeDefined();

    const keyPath = join(dir, 'node.key');
    expect(peerIdFromPrivateKey(loadIdentityKey(keyPath)).toString()).toBe(printed);
    // Binary, not hex text: byte-identical in format to cadre-host's installer `identity.key`.
    expect(readFileSync(keyPath)[0]).toBe(0x08);
  });
});

describe('resolveConfig identity block', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    delete process.env.CADRE_KEY_FILE;
    delete process.env.CADRE_IDENTITY_PROTOBUF;
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  function tmpDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `cadre-cfg-${tag}-`));
    tmpDirs.push(dir);
    return dir;
  }

  /** Write a minimal valid config carrying `identity` verbatim (so retired keys can be tested). */
  function writeConfig(dir: string, identity?: Record<string, unknown>): string {
    const configPath = join(dir, 'cadre.json');
    writeFileSync(configPath, JSON.stringify({
      ...(identity ? { identity } : {}),
      controlNetwork: { partyId: 'test-party', bootstrapNodes: [] },
      profile: 'storage',
      storage: { type: 'memory' },
    }));
    return configPath;
  }

  /** Write the key file `cadre enroll create` really emits: binary protobuf. */
  async function writeEnrolledKey(dir: string, name: string) {
    const { key, bytes } = await protobufKey();
    const keyFile = join(dir, name);
    writeFileSync(keyFile, bytes);
    return { key, keyFile };
  }

  it('loads the identity a keyFile names', async () => {
    const dir = tmpDir('keyfile');
    const { key, keyFile } = await writeEnrolledKey(dir, 'node.key');

    const resolved = await resolveConfig(writeConfig(dir, { keyFile }));

    expect(peerIdFromPrivateKey(resolved.privateKey!).toString())
      .toBe(peerIdFromPrivateKey(key).toString());
  });

  // Regression: node-local stores (bootstrap-peer store, trusted-owner anchor) need a directory
  // whether or not an identity is configured — they must not ride on the identity resolution.
  it('yields a nodeStateDir for a keyFile-identity config', async () => {
    const dir = tmpDir('statedir');
    const { keyFile } = await writeEnrolledKey(dir, 'node.key');

    const resolved = await resolveConfig(writeConfig(dir, { keyFile }));

    expect(resolved.nodeStateDir).toBe(resolve(dir));
  });

  // `loadConfigFile` is a bare `yaml.load(...) as CliConfigFile` cast, so without the allowlist a
  // config still naming the retired key would resolve to NO identity and the node would generate a
  // fresh keypair — the same wrong-identity outcome by a quieter door.
  it('rejects the retired identity.protobufKeyFile, naming keyFile', async () => {
    const dir = tmpDir('retired-pb');
    const { keyFile } = await writeEnrolledKey(dir, 'node.key');

    await expect(resolveConfig(writeConfig(dir, { protobufKeyFile: keyFile })))
      .rejects.toThrow(/protobufKeyFile[\s\S]*keyFile/);
  });

  it('rejects the retired identity.privateKeyHex, naming keyFile', async () => {
    const dir = tmpDir('retired-hex');

    await expect(resolveConfig(writeConfig(dir, { privateKeyHex: 'deadbeef' })))
      .rejects.toThrow(/privateKeyHex[\s\S]*keyFile/);
  });

  // The typo guard, and the reason the allowlist is permanent rather than transitional: a
  // misspelling costs a node its identity just as silently as a retired name does.
  it('rejects a misspelled identity key', async () => {
    const dir = tmpDir('typo');
    const { keyFile } = await writeEnrolledKey(dir, 'node.key');

    await expect(resolveConfig(writeConfig(dir, { keyfile: keyFile })))
      .rejects.toThrow(/unknown key identity\.keyfile/);
  });

  it('rejects the retired CADRE_IDENTITY_PROTOBUF env var, naming CADRE_KEY_FILE', async () => {
    const dir = tmpDir('retired-env');
    const { keyFile } = await writeEnrolledKey(dir, 'node.key');
    process.env.CADRE_IDENTITY_PROTOBUF = keyFile;

    await expect(resolveConfig(writeConfig(dir)))
      .rejects.toThrow(/CADRE_IDENTITY_PROTOBUF[\s\S]*CADRE_KEY_FILE/);
  });

  // The docker entrypoint exports CADRE_KEY_FILE on every start precisely so a container whose
  // cadre.yaml predates the identity wiring still comes up on its durable key instead of silently
  // generating a fresh one. That repair only works if the env var supplies an identity the config
  // file never mentions.
  it('adopts CADRE_KEY_FILE when the config file has no identity block', async () => {
    const dir = tmpDir('env-only');
    const { key, keyFile } = await writeEnrolledKey(dir, 'cadre-peer.key');
    process.env.CADRE_KEY_FILE = keyFile;

    const resolved = await resolveConfig(writeConfig(dir));

    expect(peerIdFromPrivateKey(resolved.privateKey!).toString())
      .toBe(peerIdFromPrivateKey(key).toString());
  });

  // ...and the env value must WIN over a file value, not merely fill a gap. This is also the
  // regression guard for `cadre start --identity-file` (which sets CADRE_KEY_FILE) still
  // outranking a child config's own identity.keyFile — how cadre-host hands its spawned nodes
  // their identity.
  it('lets CADRE_KEY_FILE override an explicit identity.keyFile', async () => {
    const dir = tmpDir('env-both');
    const fromFile = await writeEnrolledKey(dir, 'from-file.key');
    const fromEnv = await writeEnrolledKey(dir, 'from-env.key');
    process.env.CADRE_KEY_FILE = fromEnv.keyFile;

    const resolved = await resolveConfig(writeConfig(dir, { keyFile: fromFile.keyFile }));

    expect(peerIdFromPrivateKey(resolved.privateKey!).toString())
      .toBe(peerIdFromPrivateKey(fromEnv.key).toString());
  });
});

describe('resolveConfig nodeStateDir', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    delete process.env.CADRE_NODE_STATE_DIR;
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs.length = 0;
  });

  /** Write a minimal valid config, optionally with a `nodeState.dir` entry, into `dir`. */
  function writeConfig(dir: string, nodeStateDir?: string): string {
    const configPath = join(dir, 'cadre.json');
    writeFileSync(configPath, JSON.stringify({
      controlNetwork: { partyId: 'test-party', bootstrapNodes: [] },
      profile: 'storage',
      storage: { type: 'memory' },
      ...(nodeStateDir ? { nodeState: { dir: nodeStateDir } } : {}),
    }));
    return configPath;
  }

  it('defaults to the directory containing the config file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-state-default-'));
    tmpDirs.push(dir);

    const resolved = await resolveConfig(writeConfig(dir));

    expect(resolved.nodeStateDir).toBe(resolve(dir));
  });

  it('honors an explicit nodeState.dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-state-explicit-'));
    tmpDirs.push(dir);
    const stateDir = join(dir, 'state');

    const resolved = await resolveConfig(writeConfig(dir, stateDir));

    expect(resolved.nodeStateDir).toBe(resolve(stateDir));
  });

  it('honors the CADRE_NODE_STATE_DIR env override', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-state-env-'));
    tmpDirs.push(dir);
    const stateDir = join(dir, 'env-state');
    process.env.CADRE_NODE_STATE_DIR = stateDir;

    const resolved = await resolveConfig(writeConfig(dir));

    expect(resolved.nodeStateDir).toBe(resolve(stateDir));
  });

  // The env var must beat a file value, not merely fill in for a missing one —
  // that is what lets an orchestrator (or the systemd unit, whose /etc/cadre is
  // read-only) relocate a child's state without rewriting its config file.
  it('lets CADRE_NODE_STATE_DIR override an explicit nodeState.dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cadre-state-both-'));
    tmpDirs.push(dir);
    const fileStateDir = join(dir, 'from-file');
    const envStateDir = join(dir, 'from-env');
    process.env.CADRE_NODE_STATE_DIR = envStateDir;

    const resolved = await resolveConfig(writeConfig(dir, fileStateDir));

    expect(resolved.nodeStateDir).toBe(resolve(envStateDir));
  });
});
