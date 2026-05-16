/**
 * CLI smoke test for the `invite` subcommand. Spawns a stub HTTP server
 * playing the role of cadre-host's management API and asserts the CLI:
 *   - POSTs the expected body to /auth/invites
 *   - Prints the encodedInvite on stdout
 *   - Exits 0 on success / non-zero on connect failure
 *
 * Relies on `yarn build` having produced dist/bin/host.js.
 */

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '../../dist/bin/host.js');

interface StubServer {
  server: Server;
  port: number;
  requests: Array<{ method: string; url: string; body: string }>;
  setResponse(handler: (req: IncomingMessage, res: ServerResponse) => void): void;
}

async function startStub(): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      encodedInvite: 'fake-encoded-invite',
      token: 'fake-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      handler(req, res);
    });
  });

  await new Promise<void>((resolveStart) => server.listen(0, '127.0.0.1', () => resolveStart()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server,
    port,
    requests,
    setResponse: (h) => { handler = h; },
  };
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [binPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolveRun({ code: code ?? -1, stdout, stderr }));
  });
}

let stub: StubServer;

beforeEach(async () => {
  if (!existsSync(binPath)) {
    throw new Error(`cadre-host bin not built at ${binPath}; run \`yarn build\` first`);
  }
  stub = await startStub();
});

afterEach(async () => {
  await new Promise<void>((resolveClose) => stub.server.close(() => resolveClose()));
});

describe('cadre-host invite CLI', () => {
  it('POSTs to /auth/invites with label + ttlMs and prints encoded invite', async () => {
    const result = await runCli(['invite', "Mom's phone", '--ttl', '12h', '--port', String(stub.port)]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('fake-encoded-invite');
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.method).toBe('POST');
    expect(stub.requests[0]!.url).toBe('/auth/invites');
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.label).toBe("Mom's phone");
    expect(body.ttlMs).toBe(12 * 60 * 60 * 1000);
  });

  it('exits non-zero when cadre-host returns an error', async () => {
    stub.setResponse((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const result = await runCli(['invite', 'Test', '--port', String(stub.port)]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('500');
  });

  it('exits 2 (no service) when cadre-host is not reachable', async () => {
    // Use a port the stub server occupied; close it first so connections fail.
    const port = stub.port;
    await new Promise<void>((resolveClose) => stub.server.close(() => resolveClose()));
    const result = await runCli(['invite', 'Test', '--port', String(port)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cadre-host start|Failed to reach/);
  });

  it('rejects invalid --ttl', async () => {
    const result = await runCli(['invite', 'Test', '--ttl', 'eternity', '--port', String(stub.port)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid --ttl/);
  });
});

describe('cadre-host trust list CLI', () => {
  it('renders members and pending invites', async () => {
    stub.setResponse((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        members: [
          { peerId: '12D3KooWAlice', label: 'Alice', addedAt: 't1' },
          { peerId: '12D3KooWHost', label: 'Host', addedAt: 't2', self: true },
        ],
        pending: [
          { token: 'tok1', label: 'Mom', createdAt: 't3', expiresAt: 't4' },
        ],
      }));
    });

    const result = await runCli(['trust', 'list', '--port', String(stub.port)]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('12D3KooWAlice');
    expect(result.stdout).toContain('Alice');
    expect(result.stdout).toContain('[self]');
    expect(result.stdout).toContain('tok1');
    expect(result.stdout).toContain('Mom');
  });
});

describe('cadre-host trust revoke CLI', () => {
  it('DELETEs /auth/invites/<token> by default', async () => {
    stub.setResponse((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const result = await runCli(['trust', 'revoke', 'some-token', '--port', String(stub.port)]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(stub.requests[0]!.url).toBe('/auth/invites/some-token');
  });

  it('DELETEs /auth/members/<peerId> when id looks like a peerId', async () => {
    stub.setResponse((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    const result = await runCli(['trust', 'revoke', '12D3KooWAlice', '--port', String(stub.port)]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]!.url).toBe('/auth/members/12D3KooWAlice');
  });
});
