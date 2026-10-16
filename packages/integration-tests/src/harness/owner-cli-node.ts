/**
 * A real `cadre-cli` child that owns its own cadre (`cadre start --owner`), driven through its
 * loopback admin channel. Scenarios use it as the always-on member a node joins through when
 * the owner invites it (`provider-container-joins-by-invitation`): `createInvitation` mints the
 * bundle, and its member set says who the redemption admitted.
 *
 * The child creates its owner key file itself (`owner.key` in its workdir, its node-state
 * directory), apart from its identity; `getOwnerKey` reads the key back from the admin channel.
 *
 * Spawned directly because no product code runs an owner node as a child: owner keys stay on
 * devices people hold (docs/cadre-host.md → Control-plane separation).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CreateCadreInvitationOptions, CreateCadreInvitationResult } from '@serfab/cadre-core';
import type { CliConfigFile } from '@serfab/cadre-cli';

import { allocFreePort, isChildUp, readLogTail, resolveCadreCliBin, scrubbedParentEnv, stopChildProcess } from './child-node-fixtures.js';
import { waitUntil } from './wait-utils.js';

const LOG_FILE = 'node.log';
const LOG_TAIL_LINES = 200;
const STOP_TIMEOUT_MS = 5_000;

export interface OwnerCliNodeOptions {
	/** The node's own directory: its config, log, file storage and node-local stores. */
	workdir: string;
	/** A protobuf identity key already on disk (`writeIdentity`); the node runs as this peer. */
	identityPath: string;
	/** That key's peer id. The node counts as up once its admin channel reports it. */
	peerId: string;
	partyId: string;
	/** Budget for the child to start and answer on its admin channel. */
	startupMs: number;
	/**
	 * Listen addresses, each on port 0 so the admin channel reports the bound ones. Defaults to one
	 * loopback TCP port; add a `/ws` listener when a machine with only the WebSocket transport (a
	 * phone) must be able to dial this node.
	 */
	listenAddrs?: string[];
}

/** One `CadrePeer` row as the node's admin channel answers it. */
export interface OwnerCliMemberRow {
	peerId: string;
	multiaddr: string | null;
	/**
	 * The row subject's own signature over its record: present once the subject has published
	 * its record itself, null while only another member has written the row for it (an
	 * invitation redemption, `addDrone`).
	 *
	 * NOTE: on the wire because `CadreNode.listMembers` hands back the control database's whole
	 * rows, past the `{ peerId, multiaddr }` the admin route documents. If that ever narrows,
	 * read the signature another way (an admin route over `resolvePeerAddrs`, say).
	 */
	sig: string | null;
}

export interface OwnerCliNode {
	getPeerId(): Promise<string>;
	/** The owner key the node signs with (its owner key file's), base64url; null before it is wired. */
	getOwnerKey(): Promise<string | null>;
	/** The node's dialable control-network addresses. */
	getMultiaddrs(): Promise<string[]>;
	/**
	 * Mint a cadre invitation naming this node's addresses as the members to redeem at; `encoded`
	 * is the bundle a device or a provider container is started with.
	 */
	createInvitation(options: CreateCadreInvitationOptions): Promise<CreateCadreInvitationResult>;
	/** Is `peerId` in this node's AUTHORIZED member set (the trust-facing set, this node excluded). */
	isAuthorizedMember(peerId: string): Promise<boolean>;
	/** Every `CadrePeer` row this node holds, this node's own included. */
	listMembers(): Promise<OwnerCliMemberRow[]>;
	/** The last lines of the child's log, for a failure message. Never throws. */
	logTail(): string;
	stop(): Promise<void>;
}

const DEFAULT_LISTEN_ADDRS = ['/ip4/127.0.0.1/tcp/0'];

/** Start the owner child and wait until its admin channel answers as `opts.peerId`. */
export async function startOwnerCliNode(opts: OwnerCliNodeOptions): Promise<OwnerCliNode> {
	const ports = { health: await allocFreePort(), metrics: await allocFreePort(), admin: await allocFreePort() };
	// The admin channel takes the node's startup token as its bearer.
	const adminToken = randomBytes(16).toString('hex');
	const child = launchOwnerChild(opts, ports, adminToken);
	const admin = adminClient(`http://127.0.0.1:${ports.admin}`, adminToken);
	const logTail = (): string => readLogTail(join(opts.workdir, LOG_FILE), LOG_TAIL_LINES);
	const node: OwnerCliNode = {
		getPeerId: async () => (await admin<{ peerId: string | null }>('GET', '/admin/identity')).peerId ?? '',
		getOwnerKey: async () => (await admin<{ ownerKey: string | null }>('GET', '/admin/identity')).ownerKey,
		getMultiaddrs: async () => (await admin<{ multiaddrs: string[] }>('GET', '/admin/multiaddrs')).multiaddrs,
		createInvitation: (options) => admin<CreateCadreInvitationResult>('POST', '/admin/invites', options),
		isAuthorizedMember: async (peerId) =>
			(await admin<{ member: boolean }>('GET', `/admin/authorized-members/${encodeURIComponent(peerId)}`)).member,
		listMembers: async () => (await admin<{ members: OwnerCliMemberRow[] }>('GET', '/admin/members')).members,
		logTail,
		stop: () => stopChildProcess(child, STOP_TIMEOUT_MS),
	};
	try {
		await waitUntil(async () => {
			if (!isChildUp(child)) throw new Error(`cadre-cli exited (code ${child.exitCode})`);
			return (await node.getPeerId()) === opts.peerId;
		}, { timeoutMs: opts.startupMs, intervalMs: 250, description: 'owner admin channel ready' });
	} catch (err) {
		await node.stop();
		throw new Error(`owner node never became ready: ${(err as Error).message}\n--- node.log ---\n${logTail()}`, { cause: err });
	}
	return node;
}

function launchOwnerChild(
	opts: OwnerCliNodeOptions,
	ports: { health: number; metrics: number; admin: number },
	adminToken: string,
): ChildProcess {
	mkdirSync(join(opts.workdir, 'storage'), { recursive: true });
	const configPath = join(opts.workdir, 'cadre.json');
	const config: CliConfigFile = {
		controlNetwork: { partyId: opts.partyId, bootstrapNodes: [] },
		profile: 'storage',
		storage: { type: 'file', path: join(opts.workdir, 'storage') },
		network: { listenAddrs: opts.listenAddrs ?? DEFAULT_LISTEN_ADDRS },
	};
	writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
	const args = [
		resolveCadreCliBin(), 'start',
		'-c', configPath,
		'--owner',
		'--identity-file', opts.identityPath,
		'--health-port', String(ports.health),
		'--metrics-port', String(ports.metrics),
		'--admin-port', String(ports.admin),
	];
	const env = { ...scrubbedParentEnv(), CADRE_STARTUP_TOKEN: adminToken, CADRE_NODE_STATE_DIR: opts.workdir };
	const logFd = openSync(join(opts.workdir, LOG_FILE), 'a');
	try {
		return spawn(process.execPath, args, { cwd: opts.workdir, stdio: ['ignore', logFd, logFd], env });
	} finally {
		closeSync(logFd);
	}
}

/**
 * One request against a `cadre-cli` admin channel's `{ ok, data }` / `{ ok: false, error }`
 * envelope, throwing with the node's own message on a refusal.
 */
export function adminClient(baseUrl: string, token: string) {
	return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const headers: Record<string, string> = { authorization: `Bearer ${token}` };
		if (body !== undefined) headers['content-type'] = 'application/json';
		const res = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const envelope = (await res.json()) as { ok?: boolean; data?: T; error?: { code?: string; message?: string } };
		if (!res.ok || !envelope.ok) {
			throw new Error(`admin ${method} ${path} refused: [${envelope.error?.code ?? res.status}] ${envelope.error?.message ?? ''}`);
		}
		return envelope.data as T;
	};
}
