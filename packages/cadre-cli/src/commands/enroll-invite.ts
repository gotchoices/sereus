import { Command } from 'commander';
import debug from 'debug';
import type { CreateCadreInvitationOptions, CreateCadreInvitationResult } from '@serfab/cadre-core';
import {
  adminRequest, resolveAdminConnection, describeAdminFailure, AdminOptionError, DEFAULT_ADMIN_TIMEOUT_MS,
  type AdminConnection, type AdminConnectionOptions, type AdminFetch
} from './admin-client.js';
import { parseTargetPeerId } from './enroll-add.js';

const log = debug('cadre:cli:enroll-invite');

/**
 * `cadre enroll invite`: ask the RUNNING owner node, over its loopback admin channel, to mint a
 * cadre invitation, and print the encoded bundle a device redeems at any member of the cadre
 * (`cadre start --invitation`, or a reference app's "Paste cadre invitation" field). The owner
 * can be offline when the device redeems: any member holding the invitation's row admits it
 * (`docs/architecture.md` → "Enrollment Flow: Invitation Redeemed at Any Member").
 *
 * It goes through the admin channel for the same reason `cadre enroll add` does: the owner is
 * already running, and the invitation's row is a control write its running gate must see.
 */

interface EnrollInviteOptions extends AdminConnectionOptions {
  peerId?: string;
  owner?: boolean;
  ttl?: string;
  uses?: string;
  json?: boolean;
}

/** What the command reports; the `--json` body verbatim. */
export interface EnrollInviteReport extends CreateCadreInvitationResult {
  warnings: string[];
}

// NOTE: listing and withdrawing have no CLI command yet, so this warning names the admin
// route. If operators withdraw often, add `cadre enroll invite --list` / `--withdraw <key>`
// over the same admin client rather than a second command family.
const UNTARGETED_OWNER_WARNING =
  'This invitation makes WHOEVER redeems it an owner of the cadre: a bearer credential for admin rights. '
  + 'Hand it over directly and withdraw it (DELETE /admin/invites/<key>) if it goes astray; it expires in 15 minutes '
  + 'unless --ttl says otherwise.';

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;

/** A `--ttl` such as `30m`, `24h`, `7d` or `90s` in milliseconds; a bare number is milliseconds. */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input.trim());
  if (!match) {
    throw new AdminOptionError(`Invalid --ttl: ${input} (expected e.g. 30m, 24h, 7d)`);
  }
  const ms = Math.round(parseFloat(match[1]!) * UNIT_MS[match[2] ?? 'ms']!);
  if (ms <= 0) {
    throw new AdminOptionError(`Invalid --ttl: ${input} (must be a positive duration)`);
  }
  return ms;
}

function parseUses(raw: string): number {
  const uses = Number(raw);
  if (!Number.isInteger(uses) || uses < 1) {
    throw new AdminOptionError(`Invalid --uses: ${raw} (a positive whole number)`);
  }
  return uses;
}

/** The mint request, validated before anything is sent. */
export function buildInvitationRequest(options: EnrollInviteOptions): CreateCadreInvitationOptions {
  return {
    grantsOwner: Boolean(options.owner),
    ...(options.peerId !== undefined ? { peerId: parseTargetPeerId(options.peerId) } : {}),
    ...(options.ttl !== undefined ? { expiresInMs: parseDuration(options.ttl) } : {}),
    ...(options.uses !== undefined ? { uses: parseUses(options.uses) } : {}),
  };
}

export async function mintInvitation(
  connection: AdminConnection,
  request: CreateCadreInvitationOptions
): Promise<EnrollInviteReport> {
  const minted = await adminRequest<CreateCadreInvitationResult>(connection, 'POST', '/admin/invites', request);
  const untargetedOwner = minted.invitation.invite.grantsOwner && minted.invitation.invite.peerId === null;
  return { ...minted, warnings: untargetedOwner ? [UNTARGETED_OWNER_WARNING] : [] };
}

/** The human-mode stderr text: everything the operator carries to the device but the bundle. */
export function formatEnrollInviteReport(report: EnrollInviteReport): string {
  const { invite, members, partyId } = report.invitation;
  const addrs = members.map((addr) => `    - ${addr}`);
  return [
    `✓ Minted a cadre invitation for party ${partyId}`,
    `  Key:      ${invite.key}`,
    `  Admits:   ${invite.peerId === null ? 'any device' : `device ${invite.peerId}`}`,
    `  Grants:   ${invite.grantsOwner ? 'membership and ownership' : 'membership'}`,
    `  Uses:     ${invite.totalUses ?? 'unlimited'}`,
    `  Expires:  ${invite.expiresAt === null ? 'never' : `${invite.expiresAt} (UTC)`}`,
    '  Member addresses the device can redeem at:',
    ...addrs,
    'On the device (its config must set controlNetwork.partyId: ' + partyId + '):',
    '  cadre start -c cadre.yaml --identity-file <its key> --invitation <this invitation>',
    'or paste it into a reference app\'s "Paste cadre invitation" field. The owner may be offline.',
    ...report.warnings.map((warning) => `⚠ ${warning}`),
  ].join('\n');
}

/**
 * The bundle alone on stdout, so `> file` and `$(…)` capture exactly what `--invitation`
 * takes; the rest on stderr. `process.stdout.write`, never followed by `process.exit`: a pipe
 * write is asynchronous on Windows and macOS, and exiting straight after it can cut the
 * bundle short.
 */
function printReport(report: EnrollInviteReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.encoded}\n`);
  process.stderr.write(`${formatEnrollInviteReport(report)}\n`);
}

function fail(message: string, err: unknown): void {
  console.error(`✗ ${message}`);
  log('Error details: %o', err);
  process.exitCode = 1;
}

async function runEnrollInvite(options: EnrollInviteOptions, fetchImpl: AdminFetch): Promise<void> {
  let request: CreateCadreInvitationOptions;
  let resolved: ReturnType<typeof resolveAdminConnection>;
  try {
    request = buildInvitationRequest(options);
    resolved = resolveAdminConnection(options, process.env, fetchImpl);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), err);
    return;
  }
  try {
    printReport(await mintInvitation(resolved.connection, request), Boolean(options.json));
  } catch (err) {
    fail(describeAdminFailure(err, resolved.port), err);
  }
}

export const enrollInviteCommand = new Command('invite')
  .description('Have the running owner node mint a cadre invitation, and print the bundle a device redeems at any member (the owner may be offline by then)')
  .option('--peer-id <id>', 'Admit only this device (its peer ID, printed by `cadre enroll create`); omit to admit whichever device redeems first')
  .option('--owner', 'Also make the device an owner. Without --peer-id this is a bearer credential for admin rights — whoever holds the bundle becomes an owner — so it expires in 15 minutes unless --ttl says otherwise')
  .option('--ttl <duration>', 'Lifetime from now, e.g. 30m, 24h, 7d (default: 15m for an untargeted --owner invitation, 24h otherwise)')
  .option('--uses <n>', 'How many devices may redeem it (default 1)')
  .option('--admin-port <port>', 'The owner node\'s admin port (env: CADRE_ADMIN_PORT)')
  .option('--token-file <path>', 'File holding the admin token, as `cadre start --startup-token-file` writes it (env: CADRE_STARTUP_TOKEN)')
  .option('--timeout <ms>', 'Per-request timeout in milliseconds', DEFAULT_ADMIN_TIMEOUT_MS)
  .option('--json', 'Print { invitation, encoded, warnings } on stdout instead of the bare bundle')
  .action(async (options: EnrollInviteOptions) => {
    await runEnrollInvite(options, fetch);
  });
