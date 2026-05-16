#!/usr/bin/env node

/**
 * CLI entrypoint for cadre-host — the self-hosted cadre node manager.
 *
 * Most subcommands are still stubs at this stage (real implementations land
 * in the sibling tickets cadre-host-nat, cadre-host-installer,
 * cadre-host-local-ui).
 *
 * The `invite` and `trust` commands talk to the running cadre-host
 * management API over loopback. They are thin HTTP clients — they don't
 * spin up an inline service, so cadre-host must be running.
 */

import { Command } from 'commander';

import { parseDuration } from '../auth/duration.js';

const DEFAULT_PORT = Number(process.env.CADRE_HOST_PORT ?? '8765');

/** libp2p peer-ID prefixes by key type: Ed25519, secp256k1, legacy RSA. */
const PEER_ID_PREFIXES = ['12D3Koo', '16Uiu2HAm', 'Qm'] as const;

function looksLikePeerId(id: string): boolean {
  return PEER_ID_PREFIXES.some((p) => id.startsWith(p));
}

function resolvePort(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    // eslint-disable-next-line no-console
    console.error(`Invalid --port: ${raw}`);
    process.exit(1);
  }
  return n;
}

const program = new Command();

program
  .name('cadre-host')
  .description('Sereus cadre node manager for self-hosted basement-PC deployments')
  .version('0.6.0');

const stubs: ReadonlyArray<readonly [string, string]> = [
  ['install', 'Install cadre-host as a system service and run first-run setup'],
  ['start', 'Start cadre-host in the foreground'],
  ['status', 'Show running status of cadre-host and the cadre nodes it manages'],
  ['uninstall', 'Stop and uninstall the cadre-host service'],
];

for (const [name, summary] of stubs) {
  program
    .command(name)
    .description(summary)
    .action(() => {
      // eslint-disable-next-line no-console
      console.log(`cadre-host ${name}: not yet implemented`);
      process.exit(0);
    });
}

program
  .command('invite')
  .description('Generate an invite to add a member to the trust circle')
  .argument('<label>', 'Display label for the new member (e.g. "Mom\'s phone")')
  .option('--ttl <duration>', 'Invite lifetime (e.g. 24h, 7d, 30m)', '24h')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (label: string, opts: { ttl: string; port: string; host: string }) => {
    let ttlMs: number;
    try {
      ttlMs = parseDuration(opts.ttl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Invalid --ttl: ${(err as Error).message}`);
      process.exit(1);
      return;
    }

    const port = resolvePort(opts.port);

    const url = `http://${opts.host}:${port}/auth/invites`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, ttlMs }),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
        `Hint: is cadre-host running? Try \`cadre-host start\`.`,
      );
      process.exit(2);
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }

    const body = await response.json() as { encodedInvite?: string; expiresAt?: string; token?: string };
    if (!body.encodedInvite) {
      // eslint-disable-next-line no-console
      console.error('cadre-host returned malformed response (missing encodedInvite)');
      process.exit(1);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(body.encodedInvite);
    if (body.expiresAt) {
      // eslint-disable-next-line no-console
      console.error(`(expires at ${body.expiresAt})`);
    }
    process.exit(0);
  });

const trust = program
  .command('trust')
  .description('Manage the trust circle (list members, revoke invites/members)');

trust
  .command('list')
  .description('List trust-circle members and pending invites')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: { port: string; host: string }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/auth/trust-circle`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to reach cadre-host at ${url}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${response.statusText}`);
      process.exit(1);
      return;
    }
    const body = await response.json() as {
      members: Array<{ peerId: string; label: string; addedAt: string; self?: boolean }>;
      pending: Array<{ token: string; label: string; createdAt: string; expiresAt?: string }>;
    };
    // eslint-disable-next-line no-console
    console.log('Members:');
    if (body.members.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  (none)');
    } else {
      for (const m of body.members) {
        const self = m.self ? ' [self]' : '';
        // eslint-disable-next-line no-console
        console.log(`  ${m.peerId}  ${m.label}${self}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log('\nPending invites:');
    if (body.pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log('  (none)');
    } else {
      for (const p of body.pending) {
        const expires = p.expiresAt ? ` (expires ${p.expiresAt})` : '';
        // eslint-disable-next-line no-console
        console.log(`  ${p.token}  ${p.label}${expires}`);
      }
    }
    process.exit(0);
  });

trust
  .command('revoke')
  .description('Revoke a pending invite (by token) or remove a member (by peerId)')
  .argument('<id>', 'Token (pending invite) or peerId (existing member) to remove')
  .option('--kind <kind>', 'Force interpretation: "invite" | "member" (default: auto)', 'auto')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (id: string, opts: { kind: string; port: string; host: string }) => {
    const base = `http://${opts.host}:${resolvePort(opts.port)}`;
    const kind = opts.kind === 'auto'
      ? (looksLikePeerId(id) ? 'member' : 'invite')
      : opts.kind;
    const path = kind === 'member'
      ? `/auth/members/${encodeURIComponent(id)}`
      : `/auth/invites/${encodeURIComponent(id)}`;

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, { method: 'DELETE' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Failed to reach cadre-host at ${base}: ${(err as Error).message}`);
      process.exit(2);
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // eslint-disable-next-line no-console
      console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
      process.exit(1);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(`revoked ${kind}: ${id}`);
    process.exit(0);
  });

// ============================================================================
// nat subcommands
// ============================================================================

const nat = program
  .command('nat')
  .description('Manage NAT traversal, port forwarding, and dynamic DNS');

nat
  .command('status')
  .description('Show NAT, external-IP, and DDNS status')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .option('--json', 'Output raw JSON instead of a human-readable summary')
  .action(async (opts: { port: string; host: string; json?: boolean }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/status`;
    const body = await getJson(url);
    if (opts.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(body, null, 2));
    } else {
      printNatStatus(body);
    }
    process.exit(0);
  });

nat
  .command('test')
  .description('Re-run reachability probes and print the result')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .option('--json', 'Output raw JSON instead of a human-readable summary')
  .action(async (opts: { port: string; host: string; json?: boolean }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/test`;
    const body = await postJson(url, {});
    if (opts.json) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(body, null, 2));
    } else {
      printNatStatus(body);
    }
    process.exit(0);
  });

nat
  .command('settings')
  .description('Update NAT settings (external port, UPnP toggle)')
  .option('--external-port <port>', 'External port to map')
  .option('--internal-port <port>', 'Internal libp2p port (defaults to external)')
  .option('--no-upnp', 'Disable UPnP/NAT-PMP port mapping')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: {
    externalPort?: string;
    internalPort?: string;
    upnp?: boolean;
    port: string;
    host: string;
  }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/settings`;
    const patch: Record<string, unknown> = {};
    if (opts.externalPort) patch.externalPort = resolvePort(opts.externalPort);
    if (opts.internalPort) patch.internalPort = resolvePort(opts.internalPort);
    // Commander assigns `upnp: false` when `--no-upnp` is passed.
    if (opts.upnp === false) patch.upnpEnabled = false;
    if (opts.upnp === true) patch.upnpEnabled = true;

    const body = await putJson(url, patch);
    printNatStatus(body);
    process.exit(0);
  });

const ddns = nat
  .command('ddns')
  .description('Configure dynamic DNS');

ddns
  .command('set')
  .description('Configure a DDNS provider (and store credentials in the keychain)')
  .argument('<provider>', 'Provider ID (e.g. "duckdns")')
  .option('--hostname <hostname>', 'Hostname to publish (e.g. foo.duckdns.org)')
  .option('--token <token>', 'Provider token (a secret value; prompts if omitted)')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (provider: string, opts: {
    hostname?: string;
    token?: string;
    port: string;
    host: string;
  }) => {
    if (!opts.hostname) {
      // eslint-disable-next-line no-console
      console.error('--hostname is required');
      process.exit(1);
      return;
    }
    const config: Record<string, string> = {};
    if (opts.token) config.token = opts.token;

    if (!config.token) {
      if (!process.stdin.isTTY) {
        // eslint-disable-next-line no-console
        console.error(
          'Missing --token for provider "' + provider + '" and stdin is not a TTY. ' +
          'Re-run with --token <secret>.',
        );
        process.exit(1);
        return;
      }
      try {
        config.token = await readSecretLine('DDNS token: ');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to read token: ' + (err as Error).message);
        process.exit(1);
        return;
      }
    }

    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/ddns`;
    const body = await putJson(url, {
      providerId: provider,
      hostname: opts.hostname,
      config,
      externallyManaged: false,
    });
    printNatStatus(body);
    process.exit(0);
  });

ddns
  .command('external')
  .description('Declare an externally-managed DDNS hostname (cadre-host does not update it)')
  .requiredOption('--hostname <hostname>', 'Hostname (no provider; cadre-host will not push updates)')
  .option('--port <port>', 'cadre-host management API port', String(DEFAULT_PORT))
  .option('--host <host>', 'cadre-host management API host', '127.0.0.1')
  .action(async (opts: { hostname: string; port: string; host: string }) => {
    const url = `http://${opts.host}:${resolvePort(opts.port)}/nat/settings`;
    const body = await putJson(url, {
      ddns: {
        providerId: 'external',
        hostname: opts.hostname,
        externallyManaged: true,
      },
    });
    printNatStatus(body);
    process.exit(0);
  });

async function getJson(url: string): Promise<NatStatusLike> {
  return await callJson(url, 'GET');
}

async function postJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson(url, 'POST', body);
}

async function putJson(url: string, body: unknown): Promise<NatStatusLike> {
  return await callJson(url, 'PUT', body);
}

interface NatStatusLike {
  portMode?: string;
  externalPort?: number;
  internalPort?: number;
  externalIp?: string | null;
  routerExternalIp?: string | null;
  cgnatDetected?: boolean;
  directReachability?: string;
  lastTestedAt?: string | null;
  mappingLeaseExpiresAt?: string | null;
  ddns?: {
    providerId?: string | null;
    hostname?: string | null;
    externallyManaged?: boolean;
    lastUpdateAt?: string | null;
    lastUpdateOk?: boolean | null;
    lastError?: string | null;
  };
}

async function callJson(url: string, method: string, body?: unknown): Promise<NatStatusLike> {
  let response: Response;
  try {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    response = await fetch(url, init);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to reach cadre-host at ${url}: ${(err as Error).message}\n` +
      `Hint: is cadre-host running? Try \`cadre-host start\`.`,
    );
    process.exit(2);
    throw err;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`cadre-host returned ${response.status}: ${text || response.statusText}`);
    process.exit(1);
    throw new Error('non-ok');
  }
  if (response.status === 204) return {} as NatStatusLike;
  return await response.json() as NatStatusLike;
}

function printNatStatus(s: NatStatusLike): void {
  // eslint-disable-next-line no-console
  console.log(`Port mapping: ${s.portMode ?? '?'} (external ${s.externalPort ?? '?'} → internal ${s.internalPort ?? '?'})`);
  if (s.routerExternalIp) {
    // eslint-disable-next-line no-console
    console.log(`Router IP:    ${s.routerExternalIp}`);
  }
  // eslint-disable-next-line no-console
  console.log(`External IP:  ${s.externalIp ?? '(unknown)'}${s.cgnatDetected ? '  [CGNAT detected]' : ''}`);
  // eslint-disable-next-line no-console
  console.log(`Reachability: ${s.directReachability ?? 'unknown'}${s.lastTestedAt ? `  (tested ${s.lastTestedAt})` : ''}`);
  if (s.mappingLeaseExpiresAt) {
    // eslint-disable-next-line no-console
    console.log(`Lease expires: ${s.mappingLeaseExpiresAt}`);
  }
  const ddns = s.ddns ?? {};
  if (ddns.providerId || ddns.hostname) {
    // eslint-disable-next-line no-console
    console.log(`\nDDNS:`);
    // eslint-disable-next-line no-console
    console.log(`  Provider:   ${ddns.providerId ?? '(none)'}${ddns.externallyManaged ? '  [externally managed]' : ''}`);
    // eslint-disable-next-line no-console
    console.log(`  Hostname:   ${ddns.hostname ?? '(unset)'}`);
    if (ddns.lastUpdateAt) {
      const ok = ddns.lastUpdateOk ? 'OK' : 'FAIL';
      // eslint-disable-next-line no-console
      console.log(`  Last update: ${ok} at ${ddns.lastUpdateAt}${ddns.lastError ? `  — ${ddns.lastError}` : ''}`);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log('\nDDNS: not configured');
  }
}

/** Read a single line from stdin with echo suppressed (TTY only). */
function readSecretLine(prompt: string): Promise<string> {
  return new Promise<string>((resolveLine, rejectLine) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    const wasRaw = stdin.isRaw;
    try {
      stdout.write(prompt);
      stdin.setRawMode(true);
    } catch (err) {
      rejectLine(err);
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');

    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '') {
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
          stdin.pause();
          stdout.write('\n');
          resolveLine(buf);
          return;
        }
        if (ch === '') {
          // Ctrl-C
          stdin.removeListener('data', onData);
          try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
          stdin.pause();
          stdout.write('\n');
          rejectLine(new Error('cancelled'));
          return;
        }
        if (ch === '' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

program.parseAsync();
