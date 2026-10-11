import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { decodeNodeClaimPayload, encodeNodeClaimPayload } from '@serfab/cadre-core';
import { claimAddressesFor, nodeCodeLink, openerFor } from '../src/commands/code.js';
import { resolveClaimSecret } from '../src/commands/claim-secret.js';

/**
 * `cadre code`'s pure parts: which addresses a node code carries and in what order, the link
 * form, the desktop opener, and where the claim secret comes from.
 */

const PEER = '12D3KooWQqAJCA3dguWYHWGzwSrVnsxTcPmL68TPqw4or6SLVkUS';
const REPORTED = [
  `/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`,
  `/ip4/192.168.2.27/tcp/4001/p2p/${PEER}`,
  `/ip4/127.0.0.1/tcp/4002/ws/p2p/${PEER}`,
  `/ip4/192.168.2.27/tcp/4002/ws/p2p/${PEER}`,
  `/dns4/node.example.com/tcp/4002/ws/p2p/${PEER}`,
];

describe('claimAddressesFor', () => {
  const LAN = async () => '192.168.2.27';
  const withLan = [...REPORTED, `/ip4/172.20.0.1/tcp/4002/ws/p2p/${PEER}`];

  it('keeps the public name and the auto-detected LAN address (the rule itself is cadre-core\'s)', async () => {
    expect(await claimAddressesFor(withLan, PEER, {}, LAN)).toEqual([
      `/dns4/node.example.com/tcp/4002/ws/p2p/${PEER}`,
      `/ip4/192.168.2.27/tcp/4002/ws/p2p/${PEER}`,
    ]);
  });

  it('takes --lan as given, and --no-lan as none', async () => {
    const reported = [...withLan, `/ip4/10.9.9.1/tcp/4002/ws/p2p/${PEER}`];
    expect(await claimAddressesFor(reported, PEER, { lan: '10.9.9.1' }, LAN)).toEqual([
      `/dns4/node.example.com/tcp/4002/ws/p2p/${PEER}`,
      `/ip4/10.9.9.1/tcp/4002/ws/p2p/${PEER}`,
    ]);
    expect(await claimAddressesFor(reported, PEER, { lan: false }, LAN)).toEqual([`/dns4/node.example.com/tcp/4002/ws/p2p/${PEER}`]);
  });

  it('uses an --addr list exactly, appending /p2p once', async () => {
    expect(await claimAddressesFor(withLan, PEER, { addr: ['/dns4/a.example/tcp/1/ws', `/dns4/b.example/tcp/2/ws/p2p/${PEER}`] }, LAN))
      .toEqual([`/dns4/a.example/tcp/1/ws/p2p/${PEER}`, `/dns4/b.example/tcp/2/ws/p2p/${PEER}`]);
  });

  it('keeps everything, TCP included, with --all', async () => {
    expect(await claimAddressesFor(withLan, PEER, { all: true }, LAN)).toHaveLength(4);
  });

  it('yields a list encodeNodeClaimPayload accepts and decodes back', async () => {
    const secret = randomBytes(32).toString('base64url');
    const multiaddrs = await claimAddressesFor(REPORTED, PEER, {}, LAN);
    const code = encodeNodeClaimPayload({ peerId: PEER, multiaddrs, secret });
    expect(decodeNodeClaimPayload(code)).toEqual({ peerId: PEER, multiaddrs, secret });
  });
});

describe('nodeCodeLink', () => {
  it('puts the code in the fragment', () => {
    expect(nodeCodeLink('https://sereus.org/join/health', 'sereus-join:1.abc')).toBe('https://sereus.org/join/health#sereus-join:1.abc');
  });

  it('refuses a relative URL or one that already has a fragment', () => {
    expect(() => nodeCodeLink('sereus.org/join', 'c')).toThrow('not an absolute URL');
    expect(() => nodeCodeLink('https://sereus.org/join#x', 'c')).toThrow('already has a #fragment');
  });
});

describe('openerFor', () => {
  it('uses the platform viewer, and on Linux only with a display', () => {
    expect(openerFor('darwin', {})).toMatchObject({ command: 'open' });
    expect(openerFor('win32', {})).toMatchObject({ command: 'cmd' });
    expect(openerFor('linux', { DISPLAY: ':0' })).toMatchObject({ command: 'xdg-open' });
    expect(openerFor('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toMatchObject({ command: 'xdg-open' });
    expect(openerFor('linux', {})).toHaveProperty('none');
  });
});

describe('resolveClaimSecret', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadre-secret-spec-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const secret = randomBytes(32).toString('base64url');

  it('reads a file-held secret, trimmed, and names its source', () => {
    const file = path.join(dir, 'claim.secret');
    fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    expect(resolveClaimSecret(undefined, file)).toEqual({ secret, source: `claim.secretFile (${file})`, warnings: [] });
  });

  it('takes the environment secret when no file is configured, and none when neither is', () => {
    expect(resolveClaimSecret(` ${secret} `, undefined)).toEqual({ secret, source: 'CADRE_CLAIM_SECRET', warnings: [] });
    expect(resolveClaimSecret(undefined, undefined)).toEqual({ warnings: [] });
  });

  it('refuses both sources at once', () => {
    expect(() => resolveClaimSecret(secret, path.join(dir, 'x'))).toThrow('are both set');
  });

  it('refuses a missing file and an invalid secret without echoing it', () => {
    expect(() => resolveClaimSecret(undefined, path.join(dir, 'missing'))).toThrow('Cannot read the claim secret');
    const bad = path.join(dir, 'bad.secret');
    fs.writeFileSync(bad, 'not-a-secret', { mode: 0o600 });
    expect(() => resolveClaimSecret(undefined, bad)).toThrow(/does not hold a valid claim secret/);
    try { resolveClaimSecret(undefined, bad); } catch (err) { expect(String(err)).not.toContain('not-a-secret'); }
  });

  it.skipIf(process.platform === 'win32')('warns when other accounts can read the file', () => {
    const file = path.join(dir, 'open.secret');
    fs.writeFileSync(file, secret);
    fs.chmodSync(file, 0o644);
    expect(resolveClaimSecret(undefined, file).warnings[0]).toContain('chmod 600');
  });
});
