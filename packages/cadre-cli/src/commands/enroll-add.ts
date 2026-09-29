import fs from 'node:fs';
import { Command } from 'commander';
import debug from 'debug';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import type { PeerId } from '@libp2p/interface';
import { withTrailingPeerId, type DroneInitResult } from '@serfab/cadre-core';
import { commandEnv } from '../config/env.js';
import { adminRequest, AdminRequestError, type AdminConnection, type AdminFetch } from './admin-client.js';

const log = debug('cadre:cli:enroll-add');

/**
 * `cadre enroll add <peerId>`: ask the RUNNING owner node, over its loopback admin channel, to
 * admit a new machine, and print the seed that machine starts with.
 *
 * It goes through the admin channel rather than opening the node's state itself because the
 * owner is, by definition, already running: a second process writing the new `CadrePeer` row
 * into the shared files would leave the running owner's membership gate unaware of it, and the
 * owner would refuse the new machine when it dials in. Through the channel, the owner makes the
 * insert itself and its gate admits the peer before the seed comes back.
 */

/** The admin channel binds loopback only, so there is no host to choose. */
const ADMIN_HOST = '127.0.0.1';

const DEFAULT_TIMEOUT_MS = '30000';

const UNREACHABLE_WARNING =
  'No owner in this seed has an address and no --addr was given, so neither machine can dial the other. '
  + 'Make the owner reachable (set network.appendAnnounceAddrs to a forwarded address, or network.relayAddrs '
  + 'to a relay) and restart it before re-running, or re-run with --addr <the new machine\'s dialable address> '
  + 'so the owner dials it.';

/** A refusal whose message is already written for the operator. */
export class EnrollAddError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollAddError';
  }
}

interface EnrollAddOptions {
  addr: string[];
  adminPort?: string;
  tokenFile?: string;
  timeout: string;
  json?: boolean;
}

/** Everything the requests need, resolved and validated before the first one is sent. */
interface EnrollAddRequest {
  peerId: string;
  addrs: string[];
  port: number;
  token: string;
  timeoutMs: number;
}

/** What the command reports; the `--json` body verbatim. */
export interface EnrollAddReport {
  peerId: string;
  partyId: string;
  /** The owner key that signed the seed — what the new machine pins with `--pin-owner-key`. */
  signerKey: string;
  /** Every address of every owner peer in the seed: what the new machine can dial. */
  ownerAddrs: string[];
  encodedSeed: string;
  warnings: string[];
}

/** `GET /admin/identity`. */
interface AdminIdentity {
  peerId: string | null;
  partyId: string;
}

/**
 * The new machine's peer ID, in canonical form. Must be Ed25519: every identity
 * `cadre enroll create` writes is, and the `CadrePeer` row's public key is derived from the ID.
 */
export function parseTargetPeerId(raw: string): string {
  let parsed: PeerId;
  try {
    parsed = peerIdFromString(raw.trim());
  } catch (err) {
    throw new EnrollAddError(`Not a libp2p peer ID: ${raw} (${errorMessage(err)})`);
  }
  if (parsed.type !== 'Ed25519') {
    throw new EnrollAddError(
      `${raw} is a ${parsed.type} peer ID; cadre machines use Ed25519 identities (what \`cadre enroll create\` writes)`
    );
  }
  return parsed.toString();
}

/** Each `--addr`, canonicalized, or a refusal naming the bad one. */
export function parseTargetAddrs(raw: readonly string[], peerId: string): string[] {
  return raw.map((addr) => parseTargetAddr(addr, peerId));
}

function parseTargetAddr(raw: string, peerId: string): string {
  if (raw.includes(',')) {
    throw new EnrollAddError(
      `--addr ${raw} contains a comma, which the owner's peer record uses to separate addresses; pass each address as its own --addr`
    );
  }
  let parsed: Multiaddr;
  try {
    parsed = multiaddr(raw);
  } catch (err) {
    throw new EnrollAddError(`--addr ${raw} is not a multiaddr (${errorMessage(err)})`);
  }
  // The owner's own rule for binding an address to a peer: without this check it would drop
  // the address silently when it came to dial.
  if (withTrailingPeerId(parsed, peerId) === null) {
    throw new EnrollAddError(`--addr ${raw} ends in the peer ID of a different machine, not ${peerId}`);
  }
  return parsed.toString();
}

function resolveAdminPort(flag: string | undefined, env: string | undefined): number {
  const raw = flag ?? (env && env.trim().length > 0 ? env : undefined);
  if (raw === undefined) {
    throw new EnrollAddError('The owner node\'s admin port is required: pass --admin-port <port> or set CADRE_ADMIN_PORT');
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EnrollAddError(`Invalid admin port: ${raw}`);
  }
  return port;
}

/**
 * The bearer token, from `--token-file` or else `CADRE_STARTUP_TOKEN`. Never a flag value: it
 * would show in the process list. The file is what `cadre start --startup-token-file` writes,
 * verbatim; only a trailing line ending is dropped, for a file written by hand.
 */
function resolveAdminToken(tokenFile: string | undefined, env: string | undefined): string {
  const token = tokenFile !== undefined ? readTokenFile(tokenFile) : env ?? '';
  if (token.length === 0) {
    throw new EnrollAddError(tokenFile !== undefined
      ? `--token-file ${tokenFile} is empty`
      : 'The admin token is required: pass --token-file <path> or set CADRE_STARTUP_TOKEN to the token the owner node was started with');
  }
  return token;
}

function readTokenFile(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    throw new EnrollAddError(`Cannot read --token-file ${path}: ${errorMessage(err)}`);
  }
}

function resolveTimeout(raw: string): number {
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new EnrollAddError(`Invalid --timeout: ${raw} (a positive number of milliseconds)`);
  }
  return timeoutMs;
}

function resolveRequest(rawPeerId: string, options: EnrollAddOptions, env: NodeJS.ProcessEnv): EnrollAddRequest {
  const peerId = parseTargetPeerId(rawPeerId);
  return {
    peerId,
    addrs: parseTargetAddrs(options.addr, peerId),
    port: resolveAdminPort(options.adminPort, commandEnv('CADRE_ADMIN_PORT', env)),
    token: resolveAdminToken(options.tokenFile, commandEnv('CADRE_STARTUP_TOKEN', env)),
    timeoutMs: resolveTimeout(options.timeout),
  };
}

/**
 * Confirm the channel and token with a read, refuse the owner's own ID, then have the owner
 * authorize the peer and mint the seed.
 */
export async function mintSeed(
  connection: AdminConnection,
  peerId: string,
  addrs: string[]
): Promise<DroneInitResult> {
  const identity = await adminRequest<AdminIdentity>(connection, 'GET', '/admin/identity');
  if (identity.peerId === peerId) {
    throw new EnrollAddError(
      `${peerId} is the owner node's own peer ID. Pass the new machine's ID: the .id file \`cadre enroll create\` wrote on it.`
    );
  }
  return await adminRequest<DroneInitResult>(connection, 'POST', '/admin/add-drone', {
    dronePeerId: peerId,
    droneMultiaddrs: addrs,
  });
}

/**
 * What the new machine needs from the minted seed. The party is the seed's own, since that is
 * what `cadre start --seed` on the new machine checks its config against.
 */
export function buildEnrollAddReport(minted: DroneInitResult, peerId: string, addrsGiven: boolean): EnrollAddReport {
  const ownerAddrs = minted.seed.peers.filter((peer) => peer.isOwner).flatMap((peer) => peer.multiaddrs);
  return {
    peerId,
    partyId: minted.seed.partyId,
    signerKey: minted.seed.signerKey,
    ownerAddrs,
    encodedSeed: minted.encodedSeed,
    warnings: ownerAddrs.length === 0 && !addrsGiven ? [UNREACHABLE_WARNING] : [],
  };
}

/** The human-mode stderr text: everything the operator carries to the new machine but the seed. */
export function formatEnrollAddReport(report: EnrollAddReport): string {
  const addrs = report.ownerAddrs.length === 0
    ? ['    (none)']
    : report.ownerAddrs.map((addr) => `    - ${addr}`);
  return [
    `✓ Authorized ${report.peerId} to join party ${report.partyId}`,
    `  Owner key to pin:  ${report.signerKey}`,
    '  Owner addresses in this seed:',
    ...addrs,
    `On the new machine (its config must set controlNetwork.partyId: ${report.partyId}):`,
    `  cadre start -c cadre.yaml --identity-file <its key> --pin-owner-key ${report.signerKey} --seed <this seed>`,
    ...report.warnings.map((warning) => `⚠ ${warning}`),
  ].join('\n');
}

/** The operator-facing reason a request failed, naming the fix where there is one. */
export function describeAdminFailure(err: unknown, port: number): string {
  if (!(err instanceof AdminRequestError)) {
    return errorMessage(err);
  }
  if (err.kind === 'unreachable') {
    return `No admin channel answered on ${ADMIN_HOST}:${port} (${err.message}). `
      + `Start the owner node with --owner --admin-port ${port} and CADRE_STARTUP_TOKEN set.`;
  }
  switch (err.code) {
    case 'not_authorized':
      return 'The owner node refused the admin token: it does not match the CADRE_STARTUP_TOKEN the node was started with.';
    case 'not_ready':
      return `The node on ${ADMIN_HOST}:${port} is not running as the cadre's owner (${err.message}). Restart it with --owner.`;
    default:
      return `The owner node refused the request [${err.code ?? `HTTP ${err.status}`}]: ${err.message}`;
  }
}

/**
 * The seed alone on stdout, so `> file` and `$(…)` capture exactly what `--seed` takes; the
 * rest on stderr. Written with `process.stdout.write` and never followed by `process.exit`:
 * a pipe write is asynchronous on Windows and macOS, and exiting straight after it can cut a
 * multi-kilobyte seed short.
 */
function printReport(report: EnrollAddReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${report.encodedSeed}\n`);
  process.stderr.write(`${formatEnrollAddReport(report)}\n`);
}

function fail(message: string, err: unknown): void {
  console.error(`✗ ${message}`);
  log('Error details: %o', err);
  process.exitCode = 1;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runEnrollAdd(rawPeerId: string, options: EnrollAddOptions, fetchImpl: AdminFetch): Promise<void> {
  let request: EnrollAddRequest;
  try {
    request = resolveRequest(rawPeerId, options, process.env);
  } catch (err) {
    fail(errorMessage(err), err);
    return;
  }
  const connection: AdminConnection = {
    baseUrl: `http://${ADMIN_HOST}:${request.port}`,
    token: request.token,
    fetch: fetchImpl,
    timeoutMs: request.timeoutMs,
  };
  try {
    const minted = await mintSeed(connection, request.peerId, request.addrs);
    printReport(buildEnrollAddReport(minted, request.peerId, request.addrs.length > 0), Boolean(options.json));
  } catch (err) {
    fail(describeAdminFailure(err, request.port), err);
  }
}

function collectAddr(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export const enrollAddCommand = new Command('add')
  .description('Have the running owner node admit a new machine, and print the seed that machine starts with')
  .argument('<peerId>', 'The new machine\'s peer ID (printed by `cadre enroll create` on it, and in its .id file)')
  .option('--addr <multiaddr>', 'The new machine\'s dialable address, so the owner dials it (repeatable; omit to have the new machine dial the owner)', collectAddr, [])
  .option('--admin-port <port>', 'The owner node\'s admin port (env: CADRE_ADMIN_PORT)')
  .option('--token-file <path>', 'File holding the admin token, as `cadre start --startup-token-file` writes it (env: CADRE_STARTUP_TOKEN)')
  .option('--timeout <ms>', 'Per-request timeout in milliseconds', DEFAULT_TIMEOUT_MS)
  .option('--json', 'Print { peerId, partyId, signerKey, ownerAddrs, encodedSeed, warnings } on stdout instead of the bare seed')
  .action(async (rawPeerId: string, options: EnrollAddOptions) => {
    await runEnrollAdd(rawPeerId, options, fetch);
  });
