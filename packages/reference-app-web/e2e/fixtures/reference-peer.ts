import { spawn, type ChildProcess } from 'node:child_process';

export interface SpawnReferencePeerOptions {
	cliPath: string;
	wsPort: number;
	startupTimeoutMs?: number;
}

export interface ReferencePeerHandle {
	multiaddr: string;
	stop(): Promise<void>;
}

/**
 * Spawn the optimystic reference-peer in interactive mode with a WebSocket
 * listener. Resolves once the peer logs its `/ws/p2p/<peerId>` multiaddr.
 * Rejects after `startupTimeoutMs` (default 30s) so the suite fails fast
 * instead of hanging.
 *
 * The peer is launched with `--no-tcp --relay --offline` to match the
 * documented browser-only bootstrap recipe.
 */
export function spawnReferencePeer(
	options: SpawnReferencePeerOptions,
): Promise<ReferencePeerHandle> {
	const { cliPath, wsPort, startupTimeoutMs = 30_000 } = options;
	return new Promise((resolvePromise, rejectPromise) => {
		// `--offline` was deprecated on the interactive command (older docs
		// reference it). With no bootstrap arg supplied the peer comes up as
		// a self-contained network that the browser tabs can dial. If a future
		// optimystic release reintroduces `--offline`, add it back here.
		const child: ChildProcess = spawn(
			process.execPath,
			[
				cliPath,
				'interactive',
				'--ws-port',
				String(wsPort),
				'--no-tcp',
				'--relay',
			],
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
					`reference-peer did not advertise a /ws/p2p multiaddr within ${startupTimeoutMs}ms.\n` +
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
					`reference-peer exited before advertising multiaddr (code=${code}, signal=${signal}).\n` +
						`stdout:\n${stdoutBuffer}\nstderr:\n${stderrBuffer}`,
				),
			);
		});
	});
}
