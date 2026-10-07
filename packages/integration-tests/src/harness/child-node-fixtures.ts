/**
 * Fixtures for scenarios that drive real `cadre-cli` CHILD PROCESSES (via
 * `HostProcessOrchestrator` / `ProviderProcessOrchestrator`, or spawned
 * directly) rather than in-process `CadreNode`s — the installer-style identity
 * file a child is launched with, the bootstrap multiaddrs it is handed, the
 * node-local stores it writes into its volume, and the spawn basics: the
 * scrubbed environment, the cli bin, a free port.
 *
 * Distinct from `node-fixtures.ts`, which builds `CadreNode` instances in this
 * process.
 */

import type { ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import type { PrivateKey } from '@libp2p/interface';

/** Write a protobuf identity key (the format cadre-host gives each node) and return the libp2p key. */
export async function writeIdentity(path: string): Promise<{ key: PrivateKey; peerId: string }> {
  const key = await generateKeyPair('Ed25519');
  writeFileSync(path, privateKeyToProtobuf(key));
  return { key, peerId: peerIdFromPrivateKey(key).toString() };
}

/** Ensure a control-bootstrap multiaddr carries the peer id needed to dial it. */
export function withPeerId(addr: string, peerId: string): string {
  return addr.includes('/p2p/') ? addr : `${addr}/p2p/${peerId}`;
}

/** A node-local store envelope as `@serfab/cadre-core` snapshot-writes it. */
export interface NodeLocalEnvelope {
  version: number;
  partyId: string;
  owners?: Record<string, unknown>;
  peers?: Record<string, unknown>;
}

/**
 * The single `<name>.<encoded party>.json` node-local store in `dir`, parsed —
 * or undefined while it has not been written yet. The party component is
 * filename-encoded by cadre-core, so match on the name prefix and check the
 * envelope's own `partyId` instead of rebuilding the encoding here.
 *
 * NOTE: takes the first prefix match; a child node serves exactly one party
 * today. If a workdir ever holds several parties' stores, select by encoded
 * party rather than by prefix.
 */
export function readNodeLocalStore(dir: string, name: string): NodeLocalEnvelope | undefined {
  const file = readdirSync(dir).find((f) => f.startsWith(`${name}.`) && f.endsWith('.json'));
  return file ? (JSON.parse(readFileSync(join(dir, file), 'utf8')) as NodeLocalEnvelope) : undefined;
}

/**
 * This process's `process.env` with every `CADRE_*` key removed, as the base of a child's
 * environment. cadre-cli treats inherited `CADRE_*` vars as config overrides, so an inherited
 * `CADRE_PARTY_ID` on the developer's shell would silently reconfigure the child. Scrubbing the
 * whole prefix rather than a list of known keys means a new cli env var can't reintroduce the
 * leak by being forgotten here. A copy of cadre-host's `HostProcessOrchestrator` helper, which
 * is module-private there.
 */
export function scrubbedParentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CADRE_')) delete env[key];
  }
  return env;
}

/** A spawned child that has neither exited nor been signalled is still up. */
export function isChildUp(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

/**
 * SIGTERM `child` and wait for it to exit, escalating to SIGKILL after `timeoutMs`. A child
 * that is already down is left alone.
 */
export async function stopChildProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (!isChildUp(child)) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timeout = new Promise<'timeout'>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    if (typeof t.unref === 'function') t.unref();
  });
  if (await Promise.race([exited, timeout]) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

/** Ask the OS for a free TCP port (bind 0, read back, close). */
export function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') {
        srv.close(() => reject(new Error('failed to allocate a free port')));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve the real cadre-cli bin from THIS package's own dependency. */
export function resolveCadreCliBin(): string {
  const req = createRequire(import.meta.url);
  try {
    return req.resolve('@serfab/cadre-cli/bin/cadre.js');
  } catch (err) {
    throw new Error(
      'Unable to resolve @serfab/cadre-cli bin from integration-tests. ' +
      'Ensure cadre-cli is built (yarn workspace @serfab/cadre-cli build) ' +
      `and listed as a dependency. Underlying error: ${(err as Error).message}`,
      { cause: err },
    );
  }
}
