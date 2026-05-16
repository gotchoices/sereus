/**
 * CLI smoke test for the `nat` subcommand. Spawns a stub HTTP server playing
 * the role of cadre-host's management API and asserts the CLI:
 *   - GETs /nat/status
 *   - POSTs /nat/test
 *   - PUTs /nat/ddns with the expected body
 *   - PUTs /nat/settings
 *   - Exits non-zero when the host is not reachable
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

const DEFAULT_STATUS = {
  portMode: 'auto-upnp',
  externalPort: 4001,
  internalPort: 4001,
  routerExternalIp: '203.0.113.5',
  mappingLeaseExpiresAt: null,
  externalIp: '203.0.113.5',
  externalIpDetectedAt: new Date().toISOString(),
  cgnatDetected: false,
  directReachability: 'reachable',
  lastTestedAt: null,
  ddns: {
    providerId: 'duckdns',
    hostname: 'foo.duckdns.org',
    externallyManaged: false,
    lastUpdateAt: null,
    lastUpdateOk: null,
    lastError: null,
  },
};

async function startStub(): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(DEFAULT_STATUS));
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

describe('cadre-host nat status', () => {
  it('GETs /nat/status and renders the snapshot', async () => {
    const result = await runCli(['nat', 'status', '--port', String(stub.port)]);
    expect(result.code).toBe(0);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.method).toBe('GET');
    expect(stub.requests[0]!.url).toBe('/nat/status');
    expect(result.stdout).toContain('auto-upnp');
    expect(result.stdout).toContain('203.0.113.5');
    expect(result.stdout).toContain('foo.duckdns.org');
  });

  it('--json prints raw JSON', async () => {
    const result = await runCli(['nat', 'status', '--port', String(stub.port), '--json']);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.portMode).toBe('auto-upnp');
  });

  it('exits 2 when cadre-host is unreachable', async () => {
    const port = stub.port;
    await new Promise<void>((resolveClose) => stub.server.close(() => resolveClose()));
    const result = await runCli(['nat', 'status', '--port', String(port)]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cadre-host start|Failed to reach/);
  });
});

describe('cadre-host nat test', () => {
  it('POSTs /nat/test', async () => {
    const result = await runCli(['nat', 'test', '--port', String(stub.port)]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]!.method).toBe('POST');
    expect(stub.requests[0]!.url).toBe('/nat/test');
  });
});

describe('cadre-host nat ddns set', () => {
  it('PUTs /nat/ddns with provider + hostname + token', async () => {
    const result = await runCli([
      'nat', 'ddns', 'set', 'duckdns',
      '--hostname', 'foo.duckdns.org',
      '--token', 'TOK',
      '--port', String(stub.port),
    ]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]!.method).toBe('PUT');
    expect(stub.requests[0]!.url).toBe('/nat/ddns');
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.providerId).toBe('duckdns');
    expect(body.hostname).toBe('foo.duckdns.org');
    expect(body.config).toEqual({ token: 'TOK' });
  });

  it('exits 1 when --hostname is missing', async () => {
    const result = await runCli([
      'nat', 'ddns', 'set', 'duckdns',
      '--token', 'TOK',
      '--port', String(stub.port),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--hostname/);
  });

  it('exits 1 when --token is missing on a non-TTY stdin', async () => {
    const result = await runCli([
      'nat', 'ddns', 'set', 'duckdns',
      '--hostname', 'foo.duckdns.org',
      '--port', String(stub.port),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--token/);
  });
});

describe('cadre-host nat ddns external', () => {
  it('PUTs /nat/settings with externallyManaged=true', async () => {
    const result = await runCli([
      'nat', 'ddns', 'external',
      '--hostname', 'mydomain.example.com',
      '--port', String(stub.port),
    ]);
    expect(result.code).toBe(0);
    expect(stub.requests[0]!.method).toBe('PUT');
    expect(stub.requests[0]!.url).toBe('/nat/settings');
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.ddns.hostname).toBe('mydomain.example.com');
    expect(body.ddns.externallyManaged).toBe(true);
  });
});

describe('cadre-host nat settings', () => {
  it('PUTs /nat/settings with --external-port and --no-upnp', async () => {
    const result = await runCli([
      'nat', 'settings',
      '--external-port', '4002',
      '--no-upnp',
      '--port', String(stub.port),
    ]);
    expect(result.code).toBe(0);
    const body = JSON.parse(stub.requests[0]!.body);
    expect(body.externalPort).toBe(4002);
    expect(body.upnpEnabled).toBe(false);
  });
});
