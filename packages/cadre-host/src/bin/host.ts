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

    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      // eslint-disable-next-line no-console
      console.error(`Invalid --port: ${opts.port}`);
      process.exit(1);
      return;
    }

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
    const url = `http://${opts.host}:${Number(opts.port)}/auth/trust-circle`;
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
    const base = `http://${opts.host}:${Number(opts.port)}`;
    const kind = opts.kind === 'auto'
      ? (id.startsWith('12D3Koo') || id.startsWith('Qm') ? 'member' : 'invite')
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

program.parseAsync();
