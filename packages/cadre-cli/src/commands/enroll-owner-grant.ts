import { Command } from 'commander';
import debug from 'debug';
import type { CreateOwnerGrantOptions } from '@serfab/cadre-core';
import {
  adminRequest, resolveAdminConnection, describeAdminFailure, DEFAULT_ADMIN_TIMEOUT_MS,
  type AdminConnectionOptions, type AdminFetch
} from './admin-client.js';
import { parseDuration, parseUses } from './enroll-invite.js';
import type { AdminOwnerGrant } from '../server/admin-server.js';

const log = debug('cadre:cli:enroll-owner-grant');

/**
 * `cadre enroll owner-grant`: ask the RUNNING owner node, over its loopback admin channel, to mint
 * an owner grant, and print the encoded grant. Whoever holds it becomes an owner of the cadre
 * with a key of their own, through any member machine (`docs/architecture.md` → Owner grants):
 * another server (`cadre start --owner-grant`), or a reference app. It is how a server is made an
 * owner without copying an existing owner key onto it.
 *
 * It goes through the admin channel for the reason `cadre enroll invite` does: the grant's row is
 * an owner write the running node must make and replicate.
 */

interface EnrollOwnerGrantOptions extends AdminConnectionOptions {
  label?: string;
  ttl?: string;
  uses?: string;
  json?: boolean;
}

/** `--ttl`: a duration as `cadre enroll invite` takes one, or `never` for a backup (`expiresInMs: null`). */
function parseGrantTtl(raw: string): number | null {
  return raw.trim().toLowerCase() === 'never' ? null : parseDuration(raw);
}

/** The mint request, validated before anything is sent; the node's defaults (15 minutes, one use) apply to what is left out. */
export function buildOwnerGrantRequest(options: EnrollOwnerGrantOptions): CreateOwnerGrantOptions {
  return {
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.ttl !== undefined ? { expiresInMs: parseGrantTtl(options.ttl) } : {}),
    ...(options.uses !== undefined ? { uses: parseUses(options.uses) } : {}),
  };
}

/** The human-mode stderr text: everything about the grant but the grant itself, the warnings last so they are read. */
export function formatEnrollOwnerGrantReport(report: AdminOwnerGrant): string {
  const { grant, members, partyId } = report.grant;
  return [
    `✓ Minted an owner grant for party ${partyId}`,
    `  Key:      ${grant.key}`,
    `  Label:    ${grant.label ?? '(none)'}`,
    `  Uses:     ${grant.totalUses ?? 'unlimited'}`,
    `  Expires:  ${grant.expiresAt === null ? 'never (a backup grant)' : `${grant.expiresAt} (UTC)`}`,
    '  Member addresses the holder can redeem it at:',
    ...members.map((addr) => `    - ${addr}`),
    'On the server to make an owner (its config must set controlNetwork.partyId: ' + partyId + '):',
    '  CADRE_OWNER_GRANT=<this grant> cadre start -c cadre.yaml --identity-file <its key>',
    '  (--owner-grant <this grant> works too, but shows in the process list)',
    'In a reference app: Owner keys → Redeem an owner grant.',
    ...report.warnings.map((warning) => `⚠ ${warning}`),
  ].join('\n');
}

/**
 * The grant alone on stdout, so `> file` and `$(…)` capture exactly what `--owner-grant` takes; the
 * rest, warnings included, on stderr. `process.stdout.write`, never followed by `process.exit`, as
 * `cadre enroll invite` writes its bundle.
 */
function printReport(report: AdminOwnerGrant, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.encoded}\n`);
  process.stderr.write(`${formatEnrollOwnerGrantReport(report)}\n`);
}

function fail(message: string, err: unknown): void {
  console.error(`✗ ${message}`);
  log('Error details: %o', err);
  process.exitCode = 1;
}

async function runEnrollOwnerGrant(options: EnrollOwnerGrantOptions, fetchImpl: AdminFetch): Promise<void> {
  let request: CreateOwnerGrantOptions;
  let resolved: ReturnType<typeof resolveAdminConnection>;
  try {
    request = buildOwnerGrantRequest(options);
    resolved = resolveAdminConnection(options, process.env, fetchImpl);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err);
    return;
  }
  try {
    const minted = await adminRequest<AdminOwnerGrant>(resolved.connection, 'POST', '/admin/owner-grants', request);
    printReport(minted, Boolean(options.json));
  } catch (err) {
    fail(describeAdminFailure(err, resolved.port), err);
  }
}

export const enrollOwnerGrantCommand = new Command('owner-grant')
  .description('Have the running owner node mint an owner grant, and print it: whoever holds it can become an owner of the cadre through any member, until it is used, expires or is withdrawn')
  .option('--label <text>', 'The label every key the grant seats carries (at most 64 characters)')
  .option('--ttl <duration>', 'Lifetime from now, e.g. 15m, 24h, 7d; `never` makes a backup grant with no expiry (default 15m)')
  .option('--uses <n>', 'How many keys it may make owners (default 1)')
  .option('--admin-port <port>', 'The owner node\'s admin port (env: CADRE_ADMIN_PORT)')
  .option('--token-file <path>', 'File holding the admin token, as `cadre start --startup-token-file` writes it (env: CADRE_STARTUP_TOKEN)')
  .option('--timeout <ms>', 'Per-request timeout in milliseconds', DEFAULT_ADMIN_TIMEOUT_MS)
  .option('--json', 'Print { grant, encoded, reach, warnings } on stdout instead of the bare grant')
  .action(async (options: EnrollOwnerGrantOptions) => {
    await runEnrollOwnerGrant(options, fetch);
  });
