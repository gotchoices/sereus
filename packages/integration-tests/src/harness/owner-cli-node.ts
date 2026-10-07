/**
 * A real `cadre-cli` child that owns its own cadre (`cadre start --owner`), driven through its
 * loopback admin channel. Scenarios use it as the requester's authority when a party asks
 * another machine for a node and then seeds it (`provider-seed-accepted`): its key is the pin,
 * its addresses the bootstrap, and `addDrone` mints the seed.
 *
 * Spawned directly because no product code runs an owner node as a child: owner keys stay on
 * devices people hold (docs/cadre-host.md → Control-plane separation).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DroneInitResult } from '@serfab/cadre-core';
import type { CliConfigFile } from '@serfab/cadre-cli';

import { allocFreePort, isChildUp, resolveCadreCliBin, scrubbedParentEnv, stopChildProcess } from './child-node-fixtures.js';
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
}

export interface OwnerCliNode {
	getPeerId(): Promise<string>;
	/** The node's dialable control-network addresses. */
	getMultiaddrs(): Promise<string[]>;
	/**
	 * Mint a seed admitting `dronePeerId` to this node's cadre, signed by the node itself; only the
	 * public `encodedSeed` leaves it.
	 */
	addDrone(options: { dronePeerId: string; droneMultiaddrs: string[] }): Promise<DroneInitResult>;
	/** The last lines of the child's log, for a failure message. Never throws. */
	logTail(): string;
	stop(): Promise<void>;
}

/** Start the owner child and wait until its admin channel answers as `opts.peerId`. */
export async function startOwnerCliNode(opts: OwnerCliNodeOptions): Promise<OwnerCliNode> {
	const ports = { health: await allocFreePort(), metrics: await allocFreePort(), admin: await allocFreePort() };
	// The admin channel takes the node's startup token as its bearer.
	const adminToken = randomBytes(16).toString('hex');
	const child = launchOwnerChild(opts, ports, adminToken);
	const admin = adminClient(`http://127.0.0.1:${ports.admin}`, adminToken);
	const logTail = (): string => readLogTail(opts.workdir);
	const node: OwnerCliNode = {
		getPeerId: async () => (await admin<{ peerId: string | null }>('GET', '/admin/identity')).peerId ?? '',
		getMultiaddrs: async () => (await admin<{ multiaddrs: string[] }>('GET', '/admin/multiaddrs')).multiaddrs,
		addDrone: (options) => admin<DroneInitResult>('POST', '/admin/add-drone', options),
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
		// An OS-assigned port, so the addresses the admin channel reports are the bound ones.
		network: { listenAddrs: ['/ip4/127.0.0.1/tcp/0'] },
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
 * One request against the admin channel's `{ ok, data }` / `{ ok: false, error }` envelope,
 * throwing with the node's own message on a refusal.
 */
function adminClient(baseUrl: string, token: string) {
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

function readLogTail(workdir: string): string {
	const path = join(workdir, LOG_FILE);
	if (!existsSync(path)) return '(no node.log)';
	return readFileSync(path, 'utf8').split('\n').slice(-LOG_TAIL_LINES).join('\n');
}
