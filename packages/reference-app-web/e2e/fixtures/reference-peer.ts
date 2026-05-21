import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnReferenceMeshOptions {
	cliPath: string;
	/** WS port for the bootstrap peer (interactive --offline). */
	bootstrapWsPort: number;
	/** WS ports for the headless service peers — one per port. Default: [9192, 9193]. */
	serviceWsPorts?: number[];
	/** Per-child stdout-scan timeout. Default 30s. */
	startupTimeoutMs?: number;
	/**
	 * Network name passed via `--network` so the spawned peers' libp2p
	 * `identify` codec (`/optimystic/<network>/id/1.0.0`) matches the
	 * browser's. Without an explicit value, the CLI defaults to
	 * `optimystic`, but the browser reference uses `sereus-web-reference`;
	 * the mismatch breaks identify entirely and with it `RelayDiscovery`'s
	 * topology onConnect hook.
	 */
	networkName?: string;
}

export interface ReferenceMeshHandle {
	/** Multiaddr of the bootstrap (--offline) peer — already part of cluster keyspace. */
	bootstrapMultiaddr: string;
	/** Multiaddrs of the service peers bootstrapped to it. */
	serviceMultiaddrs: string[];
	stop(): Promise<void>;
}

interface SingleNodeHandle {
	multiaddr: string;
	stop(): Promise<void>;
}

/**
 * Spawn a 3-node mesh: one interactive `--offline` bootstrap plus two headless
 * `service` peers bootstrapped to it. The cluster has a real 3-peer keyspace,
 * which gives `clusterSize: 3` cluster consensus a healthy quorum even though
 * browser peers can't form direct connections to each other.
 *
 * The bootstrap stays `--offline` because its own REPL transactor is unused;
 * the flag suppresses the bootstrap's attempt to form a cluster before the
 * service nodes appear. The libp2p `repoService` it serves to remote callers
 * is unaffected — see `libp2p-node-base.ts` notes in the ticket.
 */
export async function spawnReferenceMesh(
	options: SpawnReferenceMeshOptions,
): Promise<ReferenceMeshHandle> {
	const {
		cliPath,
		bootstrapWsPort,
		serviceWsPorts = [9192, 9193],
		startupTimeoutMs = 30_000,
		networkName = 'sereus-web-reference',
	} = options;

	const children: SingleNodeHandle[] = [];
	const stopAll = async (): Promise<void> => {
		// Stop in reverse spawn order so service peers exit before their bootstrap.
		for (const child of [...children].reverse()) {
			try {
				await child.stop();
			} catch {
				// best effort — keep tearing down
			}
		}
	};

	try {
		const bootstrap = await spawnSingleNode({
			cliPath,
			args: [
				'interactive',
				'--ws-port',
				String(bootstrapWsPort),
				'--no-tcp',
				'--offline',
				'--network',
				networkName,
				'--cluster-size',
				'3',
				'--super-majority-threshold',
				'0.51',
			],
			startupTimeoutMs,
			label: 'bootstrap',
		});
		children.push(bootstrap);

		const serviceMultiaddrs: string[] = [];
		for (const port of serviceWsPorts) {
			const svc = await spawnSingleNode({
				cliPath,
				args: [
					'service',
					'--ws-port',
					String(port),
					'--no-tcp',
					'--bootstrap',
					bootstrap.multiaddr,
					'--network',
					networkName,
					'--cluster-size',
					'3',
					'--super-majority-threshold',
					'0.51',
				],
				startupTimeoutMs,
				label: `service-${port}`,
			});
			children.push(svc);
			serviceMultiaddrs.push(svc.multiaddr);
		}

		return {
			bootstrapMultiaddr: bootstrap.multiaddr,
			serviceMultiaddrs,
			stop: stopAll,
		};
	} catch (err) {
		await stopAll();
		throw err;
	}
}

interface SpawnSingleNodeOptions {
	cliPath: string;
	args: string[];
	startupTimeoutMs: number;
	label: string;
}

function spawnSingleNode(options: SpawnSingleNodeOptions): Promise<SingleNodeHandle> {
	const { cliPath, args, startupTimeoutMs, label } = options;
	return new Promise((resolvePromise, rejectPromise) => {
		const child: ChildProcess = spawn(
			process.execPath,
			[cliPath, ...args],
			{
				stdio: ['ignore', 'pipe', 'pipe'],
				env: { ...process.env, FORCE_COLOR: '0' },
			},
		);

		let resolved = false;
		let stdoutBuffer = '';
		let stderrBuffer = '';
		let multiaddr: string | null = null;
		const candidates: string[] = [];
		let chooseTimer: ReturnType<typeof setTimeout> | null = null;

		const cleanup = () => {
			clearTimeout(timeoutHandle);
			if (chooseTimer) clearTimeout(chooseTimer);
			child.stdout?.removeAllListeners('data');
			child.stderr?.removeAllListeners('data');
		};

		const stop = async (): Promise<void> => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			child.kill('SIGTERM');
			await new Promise<void>((res) => {
				const killer = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						child.kill('SIGKILL');
					}
				}, 5_000);
				child.once('exit', () => {
					clearTimeout(killer);
					res();
				});
			});
		};

		const timeoutHandle = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			cleanup();
			void stop();
			rejectPromise(
				new Error(
					`reference-peer (${label}) did not advertise a /ws/p2p multiaddr within ${startupTimeoutMs}ms.\n` +
						`stdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
				),
			);
		}, startupTimeoutMs);

		const scan = (chunk: string) => {
			if (multiaddr) return;
			for (const rawLine of chunk.split(/\r?\n/)) {
				const line = rawLine.trim();
				const match = line.match(
					/\/ip4\/[\d.]+\/tcp\/\d+\/ws\/p2p\/[A-Za-z0-9]+/,
				);
				if (match) candidates.push(match[0]);
			}
			// The peer prints each listen addr on its own line. We wait a short
			// window after the first match to gather siblings, then prefer the
			// 127.0.0.1 loopback (the only one the headless browser can dial).
			if (candidates.length > 0 && !chooseTimer && !multiaddr) {
				chooseTimer = setTimeout(() => {
					if (multiaddr) return;
					const loopback = candidates.find((m) => m.includes('/ip4/127.0.0.1/'));
					multiaddr = loopback ?? candidates[0];
					resolved = true;
					cleanup();
					resolvePromise({ multiaddr, stop });
				}, 250);
			}
		};

		child.stdout?.on('data', (data: Buffer) => {
			const s = data.toString('utf8');
			stdoutBuffer += s;
			if (stdoutBuffer.length > 64 * 1024) {
				stdoutBuffer = stdoutBuffer.slice(-32 * 1024);
			}
			scan(s);
		});
		child.stderr?.on('data', (data: Buffer) => {
			const s = data.toString('utf8');
			stderrBuffer += s;
			if (stderrBuffer.length > 64 * 1024) {
				stderrBuffer = stderrBuffer.slice(-32 * 1024);
			}
		});

		child.once('error', (err) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			rejectPromise(err);
		});
		child.once('exit', (code, signal) => {
			if (resolved) return;
			resolved = true;
			cleanup();
			rejectPromise(
				new Error(
					`reference-peer (${label}) exited before advertising multiaddr (code=${code}, signal=${signal}).\n` +
						`stdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
				),
			);
		});
	});
}
