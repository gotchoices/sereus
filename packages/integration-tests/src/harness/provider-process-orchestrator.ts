/**
 * Runs a cadre node as a plain child process using the environment
 * `@serfab/cadre-provider` builds for its Docker containers. Stands in for
 * DockerOrchestrator so a real node can be started the provider's way
 * without a Docker daemon in CI.
 *
 * The whole point of this class is that the child's environment is TAKEN
 * FROM THE PROVIDER (`buildNodeEnv`), layered exactly the way Docker layers
 * it — do not reimplement the env assembly anywhere else:
 *
 *   1. parent env with every `CADRE_*` key scrubbed (`scrubbedParentEnv`),
 *   2. the image's own `ENV` block (packages/cadre-cli/docker/Dockerfile),
 *      with `/data` rewritten to the per-container volume dir,
 *   3. the two vars `entrypoint.sh` derives and exports (CADRE_KEY_FILE,
 *      CADRE_NODE_STATE_DIR),
 *   4. `buildNodeEnv(...)` parsed into key/value pairs — LAST of the
 *      production layers, because in Docker the container `Env` overrides the
 *      image `ENV`, and the provider's values must win here for the same reason.
 *      With `publicHost` set it carries `CADRE_APPEND_ANNOUNCE_ADDRS` from the
 *      provider's own `publicNodeAddrs`, as `DockerOrchestrator` does. A request's
 *      `join` reaches the child the same way, as `CADRE_CLAIM_SECRET` or
 *      `CADRE_INVITATION`; layer 3's identity file and state dir are what the
 *      claim (`claim.json`) and the invitation (the signing identity) need.
 *   5. opt-in (`adminChannel`), test-only: the node's loopback admin channel,
 *      which no provider sets — a window onto the node's authorized member set.
 *
 * The per-container "volume" directory under `rootDir` is the stand-in for
 * the image's `/data` durable volume: it survives `stopContainer` and even
 * `removeContainer` (Docker's `removeContainer` does not delete a named
 * volume either — the faithful behaviour is that only the suite's tmp-root
 * cleanup removes it), so a re-`createContainer` under the same containerId
 * comes back as the same node (same identity key, same node-local stores).
 * `restartContainer` is `docker restart` in miniature: the same child
 * environment, ports and dockerId again, so the provider's record stays valid
 * across it and a phone that retained the node's addresses dials the same node.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import debug from 'debug';

import {
	buildNodeEnv,
	publicNodeAddrs,
	type ContainerRunState,
	type ContainerService,
	type NodeEnvPorts,
	type OrchestratorCreateRequest,
	type OrchestratorCreateResult,
	type OrchestratorStats,
	type RecoverableOrchestrator,
} from '@serfab/cadre-provider';
import type { CliConfigFile } from '@serfab/cadre-cli';

import {
	allocFreePort,
	isChildUp,
	readLogTail,
	resolveCadreCliBin,
	scrubbedParentEnv,
	stopChildProcess,
} from './child-node-fixtures.js';
import { waitUntil } from './wait-utils.js';

const log = debug('sereus:integration:provider-orchestrator');

const KEY_NAME = 'cadre-peer';
const CONFIG_FILE = 'cadre.json';
const LOG_FILE = 'node.log';
const STOP_TIMEOUT_MS = 10_000;

/** One spawned child and everything needed to stop/inspect it. */
export interface ProviderProcessHandle {
	dockerId: string;
	containerId: string;
	volumeDir: string;
	ports: NodeEnvPorts;
	/** Present when the orchestrator was built with `adminChannel`. */
	admin?: ProviderChildAdmin;
	child: ChildProcess;
	/** Stamped by the child's own `exit` event; absent while it is still up. */
	exitedAt?: Date;
}

/** A child's loopback admin channel: `http://127.0.0.1:<port>/admin/…` with `Bearer <token>`. */
export interface ProviderChildAdmin {
	port: number;
	token: string;
}

/** What a child was launched with, kept so `restartContainer` launches it again unchanged. */
interface ChildLaunch {
	configPath: string;
	env: NodeJS.ProcessEnv;
}

/** Stamp the handle when its current child exits; a later child installs its own watch. */
function watchExit(handle: ProviderProcessHandle): void {
	const { child } = handle;
	// The child carries its exit code but not WHEN it exited, and a caller
	// asking "did this die during enrollment?" needs the latter. Stamped here
	// rather than derived, because nothing else observes the transition.
	child.once('exit', () => {
		if (handle.child === child) handle.exitedAt = new Date();
	});
}

export interface ProviderProcessOrchestratorOptions {
	/** Root under which each container gets its own durable "volume" dir. */
	rootDir: string;
	/**
	 * The provider's `docker.publicHost`. There is no port mapping here, so the
	 * child's bound ports are its "host" ports and the announced pair is
	 * `<publicHost>/tcp/<p2p>` and `<publicHost>/tcp/<ws>/ws`.
	 */
	publicHost?: string;
	/**
	 * Give each child a loopback admin channel (`CADRE_ADMIN_PORT` +
	 * `CADRE_STARTUP_TOKEN`), recorded on its handle. Test-only: a provider never
	 * sets these, so leave it off unless a scenario must read the node's member set.
	 */
	adminChannel?: boolean;
}

export class ProviderProcessOrchestrator implements RecoverableOrchestrator {
	private readonly rootDir: string;
	private readonly publicHost: string | undefined;
	private readonly adminChannel: boolean;
	private readonly cliBin: string;
	private readonly handles = new Map<string, ProviderProcessHandle>();
	private readonly launches = new Map<string, ChildLaunch>();
	private spawnCounter = 0;

	constructor(options: ProviderProcessOrchestratorOptions) {
		this.rootDir = resolvePath(options.rootDir);
		this.publicHost = options.publicHost;
		this.adminChannel = options.adminChannel ?? false;
		mkdirSync(this.rootDir, { recursive: true });
		this.cliBin = resolveCadreCliBin();
	}

	/** The durable "volume" dir for a containerId (exists after first create). */
	volumeDirFor(containerId: string): string {
		return join(this.rootDir, containerId);
	}

	/** Snapshot of all handles ever created and not removed — for teardown. */
	listHandles(): ProviderProcessHandle[] {
		return [...this.handles.values()];
	}

	async createContainer(request: OrchestratorCreateRequest): Promise<OrchestratorCreateResult> {
		const volumeDir = this.volumeDirFor(request.containerId);
		mkdirSync(volumeDir, { recursive: true });
		mkdirSync(join(volumeDir, 'storage'), { recursive: true });

		// entrypoint.sh's create_identity: materialise the protobuf identity key once
		// per volume; a re-create of the same containerId reuses it, which is what
		// keeps the node's peer id (and its node-local stores) stable.
		const keyFile = join(volumeDir, `${KEY_NAME}.key`);
		if (!existsSync(keyFile)) {
			await this.runEnrollCreate(volumeDir);
		}

		const ports: NodeEnvPorts = {
			health: await allocFreePort(),
			metrics: await allocFreePort(),
			p2p: await allocFreePort(),
			ws: await allocFreePort(),
		};

		const admin = this.adminChannel
			? { port: await allocFreePort(), token: randomBytes(16).toString('hex') }
			: undefined;

		const env = this.buildChildEnv(request, ports, volumeDir, keyFile, admin);
		const configPath = this.ensureConfigFile(volumeDir);
		const child = this.spawnNode(request.containerId, volumeDir, configPath, env);

		const dockerId = `proc_${request.containerId}_${++this.spawnCounter}`;
		const handle: ProviderProcessHandle = {
			dockerId,
			containerId: request.containerId,
			volumeDir,
			ports,
			...(admin ? { admin } : {}),
			child,
		};
		watchExit(handle);
		this.handles.set(dockerId, handle);
		this.launches.set(dockerId, { configPath, env });
		log('spawned %s pid=%d ports=%j volume=%s', dockerId, child.pid, ports, volumeDir);

		return {
			dockerId,
			healthEndpoint: `http://127.0.0.1:${ports.health}/health`,
			metricsEndpoint: `http://127.0.0.1:${ports.metrics}/metrics`,
			p2pPort: ports.p2p,
		};
	}

	async stopContainer(dockerId: string): Promise<void> {
		const handle = this.requireHandle(dockerId);
		const { child } = handle;
		if (!isChildUp(child)) return;
		await stopChildProcess(child, STOP_TIMEOUT_MS);
		log('stopped %s', dockerId);
	}

	/**
	 * Forget the handle. Deliberately does NOT delete the volume dir: Docker's
	 * `removeContainer` does not delete a named volume either, and re-attaching
	 * the surviving volume on a later create is the behaviour under test in the
	 * restart scenario. The suite's tmp-root cleanup owns final deletion.
	 */
	async removeContainer(dockerId: string): Promise<void> {
		const handle = this.handles.get(dockerId);
		if (!handle) return;
		await this.stopContainer(dockerId);
		this.handles.delete(dockerId);
		this.launches.delete(dockerId);
	}

	/**
	 * Stop the child and start it again with the SAME environment, ports and dockerId —
	 * `docker restart`, or a restart policy replaying a container after a host reboot. The
	 * volume is reused (same identity, same `claim.json`), the provider's record keeps
	 * pointing at live endpoints, and the announced addresses are unchanged, so a phone that
	 * retained them dials the same node back. Not a respawn by this orchestrator:
	 * `restartCount` stays 0, as Docker's own counter ignores a `docker restart`.
	 *
	 * NOTE: the ports were the child's, and another process can take one in the gap; the
	 * restarted child then fails to bind and its log says so. Not seen so far; if it is,
	 * hold the ports with a listener of our own between stop and spawn.
	 */
	async restartContainer(dockerId: string): Promise<void> {
		const handle = this.requireHandle(dockerId);
		const launch = this.launches.get(dockerId);
		if (!launch) throw new Error(`Container ${dockerId} has no recorded launch to restart from`);
		await this.stopContainer(dockerId);
		handle.child = this.spawnNode(handle.containerId, handle.volumeDir, launch.configPath, launch.env);
		delete handle.exitedAt;
		watchExit(handle);
		log('restarted %s pid=%d', dockerId, handle.child.pid);
	}

	/** Never consulted by the scenarios — zeros keep the interface honest. */
	async getStats(_dockerId: string): Promise<OrchestratorStats> {
		return { cpuPercent: 0, memoryBytes: 0, networkRxBytes: 0, networkTxBytes: 0 };
	}

	async isRunning(dockerId: string): Promise<boolean> {
		const handle = this.handles.get(dockerId);
		return !!handle && isChildUp(handle.child);
	}

	/**
	 * Never respawns a child, so `restartCount` is always 0 — a dead child here
	 * stays dead, which is exactly the "node crashed during its own startup"
	 * case the provider's enrollment wait has to notice.
	 *
	 * `undefined` once the handle is forgotten (`removeContainer`), matching
	 * Docker's "no such container" rather than claiming the child died.
	 */
	async inspectRunState(dockerId: string): Promise<ContainerRunState | undefined> {
		const handle = this.handles.get(dockerId);
		if (!handle) return undefined;
		const { child } = handle;
		return {
			running: isChildUp(child),
			restartCount: 0,
			...(handle.exitedAt
				? { exitedAt: handle.exitedAt, ...(child.exitCode !== null ? { exitCode: child.exitCode } : {}) }
				: {}),
		};
	}

	/**
	 * Scan the live handles for the one spawned under this containerId — the
	 * stand-in for Docker's `sereus.container-id` label lookup. A container the
	 * provider lost the dockerId for is still findable, exactly as it would be
	 * against a real daemon. `undefined` once `removeContainer` forgot it.
	 */
	async resolveDockerId(containerId: string): Promise<string | undefined> {
		for (const handle of this.handles.values()) {
			if (handle.containerId === containerId) return handle.dockerId;
		}
		return undefined;
	}

	/**
	 * NOTE: throws once `removeContainer` has forgotten the handle, mirroring
	 * `docker logs` on a removed container. A scenario that tails a node AFTER a
	 * failed provision therefore gets nothing — the provision's own reclaim
	 * removed the handle. The output is not lost: the file survives under
	 * `<volumeDir>/node.log` (this class never deletes it) and `ContainerService`
	 * already tails it into `debug` before failing the provision.
	 */
	async getLogs(dockerId: string, tail = 100): Promise<string> {
		const handle = this.requireHandle(dockerId);
		const logPath = join(handle.volumeDir, LOG_FILE);
		if (!existsSync(logPath)) return '';
		const lines = readFileSync(logPath, 'utf8').split('\n');
		const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
		return trimmed.slice(-tail).join('\n');
	}

	/**
	 * The last `tail` lines of a container's node.log, for a failure message. Read from its
	 * volume dir rather than through a handle, so it still answers once a failed provision's
	 * reclaim has forgotten the handle. Never throws.
	 */
	logTail(containerId: string, tail = 200): string {
		return readLogTail(join(this.volumeDirFor(containerId), LOG_FILE), tail);
	}

	/** `cadre start -c <config>` as a child, its output appended to the volume's log. */
	private spawnNode(containerId: string, volumeDir: string, configPath: string, env: NodeJS.ProcessEnv): ChildProcess {
		// Append (not truncate): across a restart of the same container the log
		// keeps the earlier run's lines, which a failing restart step needs.
		const logFd = openSync(join(volumeDir, LOG_FILE), 'a');
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, [this.cliBin, 'start', '-c', configPath], {
				cwd: volumeDir,
				stdio: ['ignore', logFd, logFd],
				env,
			});
		} finally {
			closeSync(logFd);
		}
		if (!child.pid) {
			throw new Error(`Failed to spawn cadre-cli child for container ${containerId}`);
		}
		return child;
	}

	/** entrypoint.sh's create_identity: `cadre enroll create` as a child, awaited. */
	private runEnrollCreate(volumeDir: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const logFd = openSync(join(volumeDir, LOG_FILE), 'a');
			let child: ChildProcess;
			try {
				child = spawn(
					process.execPath,
					[this.cliBin, 'enroll', 'create', '--output', volumeDir, '--name', KEY_NAME],
					{ cwd: volumeDir, stdio: ['ignore', logFd, logFd], env: scrubbedParentEnv() },
				);
			} finally {
				closeSync(logFd);
			}
			child.once('error', reject);
			child.once('exit', (code) => {
				if (code === 0) resolve();
				else reject(new Error(`cadre enroll create exited with code ${code} in ${volumeDir}`));
			});
		});
	}

	private buildChildEnv(
		request: OrchestratorCreateRequest,
		ports: NodeEnvPorts,
		volumeDir: string,
		keyFile: string,
		admin: ProviderChildAdmin | undefined,
	): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			// Layer 1: scrubbed parent env (see scrubbedParentEnv).
			...scrubbedParentEnv(),
			// Layer 2: the image's ENV block (Dockerfile), /data → volumeDir.
			DATA_DIR: volumeDir,
			CADRE_PROFILE: 'storage',
			CADRE_STORAGE_TYPE: 'file',
			CADRE_STORAGE_PATH: join(volumeDir, 'storage'),
			CADRE_LISTEN_ADDRS: '/ip4/0.0.0.0/tcp/4001,/ip4/0.0.0.0/tcp/4002/ws',
			CADRE_HEALTH_PORT: '8080',
			CADRE_METRICS_PORT: '9090',
			CADRE_HIBERNATION_ENABLED: 'true',
			// Layer 3: the two vars entrypoint.sh derives and exports.
			CADRE_KEY_FILE: keyFile,
			CADRE_NODE_STATE_DIR: volumeDir,
		};
		// Layer 4 — LAST, so the provider's values win over the image ENV, same
		// as Docker's container-Env-over-image-ENV precedence. There is no host
		// port mapping here, so the allocated host ports go in as the container
		// ports the provider writes into the env.
		const appendAnnounceAddrs = this.publicHost === undefined ? [] : publicNodeAddrs(this.publicHost, ports);
		for (const entry of buildNodeEnv({ request, ports, appendAnnounceAddrs })) {
			const eq = entry.indexOf('=');
			env[entry.slice(0, eq)] = entry.slice(eq + 1);
		}
		// Layer 5 — test-only. The provider sets neither variable, so nothing of its layer is overridden.
		if (admin) {
			env.CADRE_ADMIN_PORT = String(admin.port);
			env.CADRE_STARTUP_TOKEN = admin.token;
		}
		return env;
	}

	/**
	 * Write the minimal config file `cadre-cli start -c` requires, once per
	 * volume (entrypoint.sh's generate_config is likewise guarded on absence).
	 *
	 * Deliberately near-empty rather than incomplete: everything the
	 * entrypoint's generated YAML carries is re-applied from the env anyway
	 * (applyEnvironmentOverrides beats the file), EXCEPT `strandWatchInterval`
	 * and `hibernation.defaultLatencyHint`. Those two do have variables
	 * (CADRE_STRAND_WATCH_INTERVAL, CADRE_LATENCY_HINT), but neither the image
	 * ENV nor the provider sets them — in a real container they come from the
	 * entrypoint's own `${…:-default}` fallbacks — so they are written here with
	 * those defaults. (`hibernation.enabled` is required once a hibernation
	 * block exists; the image env's CADRE_HIBERNATION_ENABLED overrides it
	 * regardless.) `controlNetwork.bootstrapNodes: []` is the entrypoint's
	 * output when CADRE_BOOTSTRAP_NODES is unset, which the provider never sets.
	 */
	private ensureConfigFile(volumeDir: string): string {
		const configPath = join(volumeDir, CONFIG_FILE);
		if (!existsSync(configPath)) {
			const config: CliConfigFile = {
				controlNetwork: { bootstrapNodes: [] },
				strandWatchInterval: 300000,
				hibernation: { enabled: true, defaultLatencyHint: 'interactive' },
			};
			writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
		}
		return configPath;
	}

	private requireHandle(dockerId: string): ProviderProcessHandle {
		const handle = this.handles.get(dockerId);
		if (!handle) throw new Error(`Container not found: ${dockerId}`);
		return handle;
	}
}

/**
 * Wait until `ContainerService`'s own enrollment loop settles a record (`running`, or `error`
 * on a provisioning failure), then require `running`. The failure carries the child's
 * node.log, since a node that never came up is otherwise a bare timeout.
 */
export async function requireContainerRunning(
	containers: ContainerService,
	orchestrator: ProviderProcessOrchestrator,
	id: string,
	label: string,
	timeoutMs: number,
): Promise<void> {
	try {
		await waitUntil(async () => {
			const status = (await containers.getContainer(id))?.status;
			return status === 'running' || status === 'error';
		}, { timeoutMs, intervalMs: 500, description: `${label} enrollment settles` });
	} catch (err) {
		const record = await containers.getContainer(id);
		throw new Error(
			`${label} never settled (status: ${record?.status}).\n--- node.log ---\n${orchestrator.logTail(id)}`,
			{ cause: err },
		);
	}
	const record = (await containers.getContainer(id))!;
	if (record.status !== 'running') {
		throw new Error(
			`${label} settled as '${record.status}' (error: ${record.error}).\n--- node.log ---\n${orchestrator.logTail(id)}`,
		);
	}
}
