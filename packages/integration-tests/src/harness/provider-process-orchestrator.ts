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
 *   1. parent env with every `CADRE_*` key scrubbed (an inherited
 *      CADRE_PARTY_ID on the dev's shell would otherwise silently
 *      reconfigure the child — same rationale as cadre-host's
 *      HostProcessOrchestrator),
 *   2. the image's own `ENV` block (packages/cadre-cli/docker/Dockerfile),
 *      with `/data` rewritten to the per-container volume dir,
 *   3. the two vars `entrypoint.sh` derives and exports (CADRE_KEY_FILE,
 *      CADRE_NODE_STATE_DIR),
 *   4. `buildNodeEnv(...)` parsed into key/value pairs — LAST, because in
 *      Docker the container `Env` overrides the image `ENV`, and the
 *      provider's values must win here for the same reason.
 *
 * The per-container "volume" directory under `rootDir` is the stand-in for
 * the image's `/data` durable volume: it survives `stopContainer` and even
 * `removeContainer` (Docker's `removeContainer` does not delete a named
 * volume either — the faithful behaviour is that only the suite's tmp-root
 * cleanup removes it), so a re-`createContainer` under the same containerId
 * comes back as the same node (same identity key, same node-local stores).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import debug from 'debug';

import {
	buildNodeEnv,
	type ContainerRunState,
	type OrchestratorCreateRequest,
	type OrchestratorCreateResult,
	type OrchestratorStats,
	type RecoverableOrchestrator,
} from '@serfab/cadre-provider';

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
	ports: { health: number; metrics: number; p2p: number };
	child: ChildProcess;
	/** Stamped by the child's own `exit` event; absent while it is still up. */
	exitedAt?: Date;
}

export interface ProviderProcessOrchestratorOptions {
	/** Root under which each container gets its own durable "volume" dir. */
	rootDir: string;
}

/**
 * Manager's own `process.env` with every `CADRE_*` key removed. Copied from
 * cadre-host's HostProcessOrchestrator (module-private there): cadre-cli
 * treats inherited `CADRE_*` vars as config overrides, so an inherited
 * CADRE_PARTY_ID would silently reconfigure the child. Scrubbing the whole
 * prefix rather than a list of known keys means a new cli env var can't
 * reintroduce the leak by being forgotten here.
 */
function scrubbedParentEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith('CADRE_')) delete env[key];
	}
	return env;
}

/** A spawned child that has neither exited nor been signalled is still up. */
function isChildUp(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

/** Ask the OS for a free TCP port (bind 0, read back, close). */
function allocFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const address = srv.address();
			if (address === null || typeof address === 'string') {
				srv.close(() => reject(new Error('failed to allocate a free port')));
				return;
			}
			const port = address.port;
			srv.close(() => resolve(port));
		});
	});
}

/** Resolve the real cadre-cli bin from THIS package's own dependency. */
function resolveCadreCliBin(): string {
	const req = createRequire(import.meta.url);
	try {
		return req.resolve('@serfab/cadre-cli/bin/cadre.js');
	} catch (err) {
		throw new Error(
			'Unable to resolve @serfab/cadre-cli bin from integration-tests. ' +
			'Ensure cadre-cli is built (yarn workspace @serfab/cadre-cli build) ' +
			`and listed as a dependency. Underlying error: ${(err as Error).message}`,
			{ cause: err },
		);
	}
}

export class ProviderProcessOrchestrator implements RecoverableOrchestrator {
	private readonly rootDir: string;
	private readonly cliBin: string;
	private readonly handles = new Map<string, ProviderProcessHandle>();
	private spawnCounter = 0;

	constructor(options: ProviderProcessOrchestratorOptions) {
		this.rootDir = resolvePath(options.rootDir);
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

		// entrypoint.sh's create_identity: materialise the hex identity key once
		// per volume; a re-create of the same containerId reuses it, which is what
		// keeps the node's peer id (and its node-local stores) stable.
		const keyFile = join(volumeDir, `${KEY_NAME}.key`);
		if (!existsSync(keyFile)) {
			await this.runEnrollCreate(volumeDir);
		}

		const ports = {
			health: await allocFreePort(),
			metrics: await allocFreePort(),
			p2p: await allocFreePort(),
		};

		// Per-container secret gating the node's POST /seed — same mint as the
		// real DockerOrchestrator (which the provider hands back on the result).
		const seedToken = randomBytes(32).toString('base64url');

		const env = this.buildChildEnv(request, seedToken, ports, volumeDir, keyFile);
		const configPath = this.ensureConfigFile(volumeDir);

		// Append (not truncate): across a restart of the same container the log
		// keeps the first run's lines, which is what a failing step 5 needs.
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
			throw new Error(`Failed to spawn cadre-cli child for container ${request.containerId}`);
		}

		const dockerId = `proc_${request.containerId}_${++this.spawnCounter}`;
		const handle: ProviderProcessHandle = {
			dockerId,
			containerId: request.containerId,
			volumeDir,
			ports,
			child,
		};
		// The child carries its exit code but not WHEN it exited, and a caller
		// asking "did this die during enrollment?" needs the latter. Stamped here
		// rather than derived, because nothing else observes the transition.
		child.once('exit', () => { handle.exitedAt = new Date(); });
		this.handles.set(dockerId, handle);
		log('spawned %s pid=%d ports=%j volume=%s', dockerId, child.pid, ports, volumeDir);

		return {
			dockerId,
			healthEndpoint: `http://127.0.0.1:${ports.health}/health`,
			metricsEndpoint: `http://127.0.0.1:${ports.metrics}/metrics`,
			seedEndpoint: `http://127.0.0.1:${ports.health}/seed`,
			seedToken,
			p2pPort: ports.p2p,
		};
	}

	async stopContainer(dockerId: string): Promise<void> {
		const handle = this.requireHandle(dockerId);
		const { child } = handle;
		if (!isChildUp(child)) return;

		const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
		child.kill('SIGTERM');
		const timeout = new Promise<'timeout'>((resolve) => {
			const t = setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS);
			if (typeof t.unref === 'function') t.unref();
		});
		if (await Promise.race([exited, timeout]) === 'timeout') {
			child.kill('SIGKILL');
			await exited;
		}
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
	}

	/** Never consulted on the seed path — zeros keep the interface honest. */
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

	async getLogs(dockerId: string, tail = 100): Promise<string> {
		const handle = this.requireHandle(dockerId);
		const logPath = join(handle.volumeDir, LOG_FILE);
		if (!existsSync(logPath)) return '';
		const lines = readFileSync(logPath, 'utf8').split('\n');
		const trimmed = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
		return trimmed.slice(-tail).join('\n');
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
		seedToken: string,
		ports: { health: number; metrics: number; p2p: number },
		volumeDir: string,
		keyFile: string,
	): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			// Layer 1: scrubbed parent env (see scrubbedParentEnv).
			...scrubbedParentEnv(),
			// Layer 2: the image's ENV block (Dockerfile), /data → volumeDir.
			DATA_DIR: volumeDir,
			CADRE_PROFILE: 'storage',
			CADRE_STORAGE_TYPE: 'file',
			CADRE_STORAGE_PATH: join(volumeDir, 'storage'),
			CADRE_LISTEN_ADDRS: '/ip4/0.0.0.0/tcp/4001',
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
		for (const entry of buildNodeEnv({ request, seedToken, ports })) {
			const eq = entry.indexOf('=');
			env[entry.slice(0, eq)] = entry.slice(eq + 1);
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
	 * and `hibernation.defaultLatencyHint`, which have no ENV_MAPPINGS entry —
	 * so those two are written with the entrypoint's defaults and nothing else.
	 * (`hibernation.enabled` is required by the file schema; the image env's
	 * CADRE_HIBERNATION_ENABLED overrides it regardless.)
	 */
	private ensureConfigFile(volumeDir: string): string {
		const configPath = join(volumeDir, CONFIG_FILE);
		if (!existsSync(configPath)) {
			const config = {
				strandWatchInterval: 5000,
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
