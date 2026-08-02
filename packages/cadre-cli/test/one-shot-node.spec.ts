/**
 * The one-shot commands against a REAL node, spawned as a real child process.
 *
 * Every one-shot `cadre` command (`strand list|remove`, `validation-key add|remove|list`) runs
 * the same three steps: resolve the config file, start a `CadreNode` and wait for
 * `control:connected`, then perform one control-database operation and shut down. That middle
 * step is `withConnectedNode`, and every other spec in this package replaces it with a stub —
 * so a defect in config resolution, node construction, or the shutdown path passes the whole
 * repo's suites and surfaces only for an operator, on the commands that perform the party's
 * destructive control-plane writes.
 *
 * Two things make a deterministic test of that possible:
 *
 *  - `CadreNode.start()` emits `control:connected` unconditionally at the end of start,
 *    reachable peers or not, so a SOLO node (`bootstrapNodes: []`, `listenAddrs: []`) satisfies
 *    the wait. A one-shot command needs no network at all. (This is also why `strands.ts`
 *    carries its "read without waiting for sync" caveat.)
 *  - the control database survives across processes on the same file storage, so a seed node
 *    built in this process can hand a real, owner-signed `Strand` row to a spawned CLI.
 *
 * Why a spawned child rather than `parseAsync` in-process: the real exit code is observed
 * instead of inferred from a stubbed `process.exit` (a stub lets execution continue past the
 * call — exactly the fidelity gap this spec closes, and exit codes are the security-relevant
 * surface here); stdout and stderr are genuinely separate, which the `--json` assertions
 * depend on; `bin/cadre.js`'s own wiring is covered; and no libp2p node owned by
 * `withConnectedNode` can leak into the vitest process.
 *
 * The branches a real node cannot produce — the connect timeout, a `start()` that outlives the
 * timer, a failing `stop()` — are covered against a fake `CadreNode` in
 * `node-session-branches.spec.ts`. A small `timeoutMs` does NOT reach the timeout branch
 * against a real node: `start()` completes without the event loop returning to the timers
 * phase, so `timeoutMs` of 0 still runs the action.
 *
 * Every config here sets `network: { listenAddrs: [] }`, so no node binds a port and this file
 * stays safe to run in parallel with the rest of the suite. A future test that needs a
 * listening node needs a port strategy first.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey } from '@libp2p/interface';
import { CadreNode, type CadreNodeConfig } from '@serfab/cadre-core';
import { resolveStorageConfig } from '../src/commands/node-session.js';

/** The compiled entry the `cadre` bin points at — what an operator actually runs. */
const CLI_ENTRY = fileURLToPath(new URL('../dist/bin/cadre.js', import.meta.url));

/** A child that has not exited by now is hung; kill it and fail by name. */
const CHILD_TIMEOUT_MS = 90_000;

/** vitest's default is 5s and this package sets no `testTimeout`; booting a node needs more. */
const NODE_TEST_TIMEOUT_MS = 120_000;

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the real `cadre` bin as a child process and collect everything it produced.
 *
 * Both streams are decoded as utf8 explicitly — the assertions match on `✓` and `⚠`. A hung
 * child is SIGKILLed and REJECTS, so it fails this test by name rather than by burning the
 * suite's wall clock somewhere else.
 */
function runCli(args: string[], cwd: string): Promise<CliRun> {
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(
        `cadre ${args.join(' ')} did not exit within ${CHILD_TIMEOUT_MS}ms\n` +
        `stdout: ${stdout}\nstderr: ${stderr}`,
      ));
    }, CHILD_TIMEOUT_MS);

    child.on('error', (error: Error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A per-test temp directory; the caller removes it in a `finally`. */
function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `cadre-oneshot-${tag}-`));
}

/**
 * A party id no other test (or run) shares. Control state is keyed by party, so a shared id
 * would make these tests order-dependent against each other's leftovers.
 */
function freshPartyId(tag: string): string {
  return `cli-oneshot-${tag}-${Math.random().toString(36).slice(2)}`;
}

/** Write `body` as `<dir>/<name>` — `.json` so `loadConfigFile` takes its JSON branch. */
function writeConfig(dir: string, body: object, name = 'cadre.json'): string {
  const configPath = join(dir, name);
  writeFileSync(configPath, JSON.stringify(body, null, 2), 'utf8');
  return configPath;
}

/**
 * Write a protobuf identity key for the config to point at, and hand the same key back.
 *
 * Same key ⇒ same PeerId ⇒ the owner a seed node enrols at genesis is the owner the spawned
 * CLI runs as, which is what lets the CLI's owner-signed removal be authorized at all.
 */
async function writeIdentity(dir: string): Promise<{ keyPath: string; privateKey: PrivateKey }> {
  const privateKey = await generateKeyPair('Ed25519');
  const keyPath = join(dir, 'identity.key');
  writeFileSync(keyPath, privateKeyToProtobuf(privateKey));
  return { keyPath, privateKey };
}

/**
 * The seed node's config: the same party, identity and storage the spawned CLI resolves for
 * itself, built in this process so the test can perform genesis and publish a row.
 *
 * Storage goes through the CLI's own {@link resolveStorageConfig} rather than being hand-rolled:
 * that helper composes the per-strand directory as `` `${path}/${strandId}` `` — a
 * forward-slash template, not `path.join` — so restating it here would risk a Windows-only
 * mismatch, and would drift the moment the template changes.
 */
function seedNodeConfig(partyId: string, blocksDir: string, privateKey: PrivateKey): CadreNodeConfig {
  return {
    privateKey,
    controlNetwork: { partyId, bootstrapNodes: [] },
    profile: 'storage',
    strandFilter: { mode: 'none' },
    storage: resolveStorageConfig({ type: 'file', path: blocksDir }),
    network: { listenAddrs: [] },
  };
}

describe('one-shot commands against a real solo node', () => {
  it('lists strands as a parseable JSON array, with the progress line on stderr', async () => {
    const dir = tempDir('list');
    try {
      const { keyPath } = await writeIdentity(dir);
      const configPath = writeConfig(dir, {
        identity: { protobufKeyFile: keyPath },
        controlNetwork: { partyId: freshPartyId('list'), bootstrapNodes: [] },
        profile: 'transaction',
        storage: { type: 'memory' },
        network: { listenAddrs: [] },
      });

      const result = await runCli(['strand', 'list', '--json', '-c', configPath], dir);

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      // The stream split is the contract, not a detail: `cadre strand list --json` has to pipe
      // straight into a JSON parser, so stdout carries nothing but the payload and the
      // "Connecting..." progress goes to stderr.
      expect(JSON.parse(result.stdout)).toEqual([]);
      expect(result.stderr).toContain('Connecting to control network...');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, NODE_TEST_TIMEOUT_MS);

  // The destructive shape, and the reason this spec exists: `strand remove` is an operator's
  // only route to a party-wide control-plane delete.
  //
  // Genesis has to be done here because a bare CLI node is not an owner — an unseeded
  // `strand remove` would fail authorization rather than exercise the write — and there is no
  // CLI command that performs genesis (`enroll register` is an offline signature check;
  // genesis lives in `start --owner`).
  it('removes a seeded strand, and the row is gone from the control database afterwards', async () => {
    const dir = tempDir('remove');
    try {
      const { keyPath, privateKey } = await writeIdentity(dir);
      const partyId = freshPartyId('remove');
      const blocksDir = join(dir, 'blocks');
      const strandId = 'cli-oneshot-strand';

      const configPath = writeConfig(dir, {
        identity: { protobufKeyFile: keyPath },
        controlNetwork: { partyId, bootstrapNodes: [] },
        profile: 'storage',
        // `none` keeps the one-shot node from trying to LAUNCH an instance for the seeded row —
        // there is no strand network behind it. Nothing under test is weakened: `strand remove`
        // reads the row through `db.queryStrand(id)` directly, never through the filter.
        strandFilter: 'none',
        storage: { type: 'file', path: blocksDir },
        network: { listenAddrs: [] },
      });

      const seed = new CadreNode(seedNodeConfig(partyId, blocksDir, privateKey));
      try {
        await seed.start();
        const owner = seed.getIdentityOwnerKey();
        const db = seed.getControlDatabase();
        expect(db).not.toBeNull();
        expect(await db!.ensureOwnerKey(owner.publicKeyB64)).toBe(true);
        seed.initializeSeedBootstrap(owner.privateKeyB64);
        await seed.publishStrand(strandId, 'o');
        // Pin the seed before spawning: without this, a publish that silently did nothing would
        // let the removal "succeed" over an absent row and the test would pass vacuously.
        expect((await db!.queryStrands()).map((row) => row.Id)).toContain(strandId);
      } finally {
        await seed.stop();
      }

      const result = await runCli(['strand', 'remove', strandId, '--yes', '-c', configPath], dir);

      expect(result.code, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(`✓ Strand removed: ${strandId}`);
      expect(result.stderr).toContain('Removal is party-wide');

      // Proved at the database, not from the CLI's own success line — that line is printed from
      // the plan, so it would read the same over a write that never landed.
      const verifier = new CadreNode(seedNodeConfig(partyId, blocksDir, privateKey));
      try {
        await verifier.start();
        const db = verifier.getControlDatabase();
        expect(db).not.toBeNull();
        expect((await db!.queryStrands()).map((row) => row.Id)).not.toContain(strandId);
      } finally {
        await verifier.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, NODE_TEST_TIMEOUT_MS);
});

/**
 * Config resolution failures, as the operator meets them: a `failure:` line on stderr and a
 * non-zero exit. None of these boots a node — every one throws inside `withConnectedNode`
 * before (or at) `new CadreNode(...)` — so they are cheap, but they still pay a child-process
 * start-up, hence the explicit timeout.
 */
describe('one-shot command config failures', () => {
  const CONFIG_TEST_TIMEOUT_MS = 60_000;

  it('exits 1 naming the missing config file', async () => {
    const dir = tempDir('no-config');
    try {
      const result = await runCli(['strand', 'list', '-c', join(dir, 'absent.json')], dir);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Failed to list strands: Config file not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CONFIG_TEST_TIMEOUT_MS);

  it('exits 1 on a config file that does not parse', async () => {
    const dir = tempDir('bad-yaml');
    try {
      const configPath = join(dir, 'cadre.yaml');
      writeFileSync(configPath, '{ unclosed', 'utf8');

      const result = await runCli(['strand', 'list', '-c', configPath], dir);

      expect(result.code).toBe(1);
      // The parser's own wording is js-yaml's, not ours — pin the prefix the CLI owns.
      expect(result.stderr).toContain('Failed to list strands:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CONFIG_TEST_TIMEOUT_MS);

  it('exits 1 on a strandFilter it cannot interpret', async () => {
    const dir = tempDir('bad-filter');
    try {
      const configPath = writeConfig(dir, {
        controlNetwork: { partyId: freshPartyId('bad-filter'), bootstrapNodes: [] },
        profile: 'transaction',
        strandFilter: {},
        storage: { type: 'memory' },
        network: { listenAddrs: [] },
      });

      const result = await runCli(['strand', 'list', '-c', configPath], dir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid strandFilter');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CONFIG_TEST_TIMEOUT_MS);

  it('exits 1 on file storage with no path', async () => {
    const dir = tempDir('no-path');
    try {
      const configPath = writeConfig(dir, {
        controlNetwork: { partyId: freshPartyId('no-path'), bootstrapNodes: [] },
        profile: 'storage',
        storage: { type: 'file' },
        network: { listenAddrs: [] },
      });

      const result = await runCli(['strand', 'list', '-c', configPath], dir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Storage path is required for file storage type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, CONFIG_TEST_TIMEOUT_MS);
});
