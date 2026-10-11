import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaimSecret } from '@serfab/cadre-core';
import { initNode, publicMultiaddr, INIT_FILES } from '../src/commands/init.js';
import { loadValidatedConfig, resolveConfig } from '../src/config/index.js';

/**
 * `cadre init` sets up a folder whose `cadre start` waits to be claimed: these pin the files it
 * writes, that the config it writes passes the strict validator and resolves the secret file,
 * the `--public` forms, and that it never overwrites a node.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-init-spec-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('publicMultiaddr', () => {
  it('turns host and host:port into the WebSocket address a phone dials', () => {
    expect(publicMultiaddr('node.example.com', 4002)).toBe('/dns4/node.example.com/tcp/4002/ws');
    expect(publicMultiaddr('node.example.com:51234', 4002)).toBe('/dns4/node.example.com/tcp/51234/ws');
    expect(publicMultiaddr('203.0.113.7:9000', 4002)).toBe('/ip4/203.0.113.7/tcp/9000/ws');
    expect(publicMultiaddr('[2001:db8::1]:9000', 4002)).toBe('/ip6/2001:db8::1/tcp/9000/ws');
  });

  it('takes a multiaddr as written, and refuses malformed entries naming them', () => {
    expect(publicMultiaddr('/dns4/node.example.com/tcp/443/wss', 4002)).toBe('/dns4/node.example.com/tcp/443/wss');
    expect(() => publicMultiaddr('/not-a-protocol/x', 4002)).toThrow('--public /not-a-protocol/x is not a valid multiaddr');
    expect(() => publicMultiaddr('host:99999', 4002)).toThrow('outside 1-65535');
    expect(() => publicMultiaddr('a b', 4002)).toThrow('must be host, host:port');
  });
});

describe('initNode', () => {
  it('writes identity, a private claim secret and a config that waits to be claimed', async () => {
    const result = await initNode({ dir, port: 5001, wsPort: 5002, publicAddrs: ['node.example.com'] });

    expect(fs.readFileSync(result.files.id, 'utf-8')).toBe(result.peerId);
    expect(parseClaimSecret(fs.readFileSync(result.files.secret, 'utf-8'))).toHaveLength(32);
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.files.secret).mode & 0o777).toBe(0o600);
      expect(fs.statSync(result.files.key).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(path.join(dir, 'state'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(true);

    const config = await loadValidatedConfig(result.files.config, {});
    expect(config.controlNetwork).toEqual({ partyId: 'unclaimed', bootstrapNodes: [] });
    expect(config.network?.listenAddrs).toEqual(['/ip4/0.0.0.0/tcp/5001', '/ip4/0.0.0.0/tcp/5002/ws']);
    expect(config.network?.appendAnnounceAddrs).toEqual(['/dns4/node.example.com/tcp/5002/ws']);
    expect(config.claim?.secretFile).toBe(path.join(dir, INIT_FILES.secret));
  });

  it('resolves to a node config with the secret file apart from the node-facing keys', async () => {
    const result = await initNode({ dir });
    const resolved = await resolveConfig(result.files.config, {});
    expect(resolved.claimSecretFile).toBe(result.files.secret);
    expect('claim' in resolved).toBe(false); // CadreNodeConfig.claim is the node's claim policy, not this
    expect(resolved.privateKey).toBeDefined();
  });

  it('omits appendAnnounceAddrs without --public', async () => {
    const result = await initNode({ dir });
    expect((await loadValidatedConfig(result.files.config, {})).network?.appendAnnounceAddrs).toBeUndefined();
  });

  it('refuses, writing nothing, when the folder already holds a node', async () => {
    const first = await initNode({ dir });
    const key = fs.readFileSync(first.files.key);
    await expect(initNode({ dir })).rejects.toThrow('Refusing to overwrite');
    expect(fs.readFileSync(first.files.key)).toEqual(key);
  });

  it('refuses equal TCP and WebSocket ports', async () => {
    await expect(initNode({ dir, port: 4001, wsPort: 4001 })).rejects.toThrow('--port and --ws-port must differ');
    expect(fs.existsSync(path.join(dir, INIT_FILES.key))).toBe(false);
  });

  it('adds start and code scripts to an existing package.json without replacing any', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'n', scripts: { code: 'mine' } }));
    const result = await initNode({ dir });
    expect(result.scriptsAdded).toEqual(['start']);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    expect(pkg.scripts).toEqual({ code: 'mine', start: 'cadre start' });
    expect(pkg.name).toBe('n');
  });
});
