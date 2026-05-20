/**
 * Test harness that boots a complete cadre-host stack in-process:
 *   - Installer.install() into a fresh temp data dir
 *   - HostProcessOrchestrator + TrustCircleService + NatService + (optional) UpdateService
 *   - createLocalUiServer wired against the real subsystems on an ephemeral port
 *
 * Scenarios drive the host over its public HTTP/SSE surface to exercise the
 * seam between modules — the same seam that focused per-module unit tests
 * (server.smoke.test, publishers.test, sse-route.test) deliberately fake out.
 *
 * `createTestCadreHost()` returns handles to the live subsystems too, so a
 * scenario can call `update.check()` or `orchestrator.createContainer(...)`
 * directly when there is no equivalent HTTP route (v1 stubs out a few).
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	HostProcessOrchestrator,
	Installer,
	NatService,
	TrustCircleService,
	TrustCircleStore,
	UpdateService,
	createLocalUiServer,
	readHostConfig,
	type CadreNodeLike,
	type HostConfigFile,
	type LocalUiEvent,
	type LocalUiServer,
	type ServiceHost,
	type ServiceHostContext,
	type ServiceHostStatus,
	type UpdateSettings,
} from '@serfab/cadre-host';

/** No-op service-host stub — the installer normally pokes systemd/launchd/NSSM. */
class FakeServiceHost implements ServiceHost {
	readonly name = 'cadre-host-test';
	installed = false;
	running = false;
	async install(_ctx: ServiceHostContext): Promise<void> { this.installed = true; this.running = true; }
	async uninstall(_ctx: ServiceHostContext): Promise<void> { this.installed = false; this.running = false; }
	async restart(_ctx: ServiceHostContext): Promise<void> { this.running = true; }
	async status(_ctx: ServiceHostContext): Promise<ServiceHostStatus> {
		return { installed: this.installed, running: this.running };
	}
	renderUnit(_ctx: ServiceHostContext): string | null { return 'fake-unit'; }
}

/** Default CadreNodeLike for trust-circle — issue/encode tokens without libp2p. */
export function defaultFakeCadreNode(): CadreNodeLike {
	return {
		async createInvite(token?: string, _expiresIn?: number) {
			const t = token ?? randomBytes(16).toString('base64url');
			// CadreInvite shape from cadre-core; integration tests only care about the encoded form.
			return {
				invite: {
					partyId: '',
					authorityAddrs: [],
					token: t,
					createdAt: Date.now(),
				} as never,
				encodedInvite: `cadre://invite/${t}`,
			};
		},
		async acceptPhone() { /* no-op */ },
		async removePeer() { /* no-op */ },
		encodeInvite() { return 'cadre://invite/test'; },
		getControlDatabase() { return null; },
	};
}

/** Minimal CadreNodeLike for NatService — no libp2p multiaddrs. */
function natFallbackNode(): { getPeerId: () => string; getMultiaddrs: () => string[] } {
	return { getPeerId: () => '', getMultiaddrs: () => [] };
}

export interface TestCadreHostOptions {
	/** Override `installerVersion` stamped into host.config.json. Defaults to '0.0.0-test'. */
	installerVersion?: string;
	/** UpdateService manifest URL — passing this enables the update subsystem. */
	manifestUrl?: string;
	/** Settings seed for UpdateService. Defaults to `{ autoApply: false }`. */
	updateSettings?: UpdateSettings;
	/** Fetcher override for UpdateService (default: node fetch). */
	updateFetcher?: typeof fetch;
	/** Inject a custom CadreNodeLike for trust-circle (e.g. a real CadreNode). */
	cadreNodeForTrustCircle?: CadreNodeLike;
	/** Test-only orchestrator spawn entrypoint (defaults to the cadre-cli bin). */
	spawnEntrypoint?: string;
	/** SSE heartbeat interval (ms) — forwarded to createLocalUiServer. */
	sseHeartbeatMs?: number;
	/** Override the platform passed to the Installer (default 'linux'). */
	installerPlatform?: 'linux' | 'darwin' | 'win32';
}

export interface HttpResponseLite {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
	raw: string;
}

export interface HttpRequestOptions {
	method: string;
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
}

export interface TestEventStream {
	/** Resolve with the next event matching predicate, or reject after timeoutMs (default 5_000). */
	next(predicate: (e: LocalUiEvent) => boolean, opts?: { timeoutMs?: number }): Promise<LocalUiEvent>;
	/** All events received so far, in arrival order. */
	received(): LocalUiEvent[];
	/** Disconnect the SSE stream. */
	close(): void;
}

export interface TestCadreHost {
	readonly dataDir: string;
	readonly port: number;
	readonly baseUrl: string;
	readonly config: HostConfigFile;
	readonly orchestrator: HostProcessOrchestrator;
	readonly trustCircle: TrustCircleService;
	readonly nat: NatService;
	readonly update?: UpdateService;
	readonly server: LocalUiServer;
	request(opts: HttpRequestOptions): Promise<HttpResponseLite>;
	openEventStream(): Promise<TestEventStream>;
	stop(): Promise<void>;
}

export async function createTestCadreHost(opts: TestCadreHostOptions = {}): Promise<TestCadreHost> {
	const dataDir = mkdtempSync(join(tmpdir(), 'integration-cadre-host-'));

	// nat.json validation requires 1..65535 — port 0 is rejected. Grab two
	// real free ports from the OS for ui + libp2p so the install passes
	// (the local UI is rebound on forcePort:0 below; the libp2p port is
	// stored in nat.json but never actually bound by this harness).
	const libp2pPort = await pickFreePort();
	const uiPort = await pickFreePort();

	const platform = opts.installerPlatform ?? 'linux';
	const installer = new Installer({
		platform,
		installerVersion: opts.installerVersion ?? '0.0.0-test',
	});
	await installer.install({
		nonInteractive: true,
		dataDir,
		uiPort,
		libp2pPort,
		openBrowser: false,
		noInvite: true,
		serviceHost: new FakeServiceHost(),
	});

	const config = readHostConfig(join(dataDir, 'host.config.json'));

	const orchestratorOpts: ConstructorParameters<typeof HostProcessOrchestrator>[0] = {
		rootDir: join(dataDir, 'orchestrator'),
		stopTimeoutMs: 2_000,
	};
	if (opts.spawnEntrypoint) {
		orchestratorOpts.spawn = { entrypoint: opts.spawnEntrypoint };
	}
	const orchestrator = new HostProcessOrchestrator(orchestratorOpts);
	await orchestrator.init();

	const trustCircle = new TrustCircleService({
		cadreNode: opts.cadreNodeForTrustCircle ?? defaultFakeCadreNode(),
		store: new TrustCircleStore(dataDir),
	});

	const nat = new NatService({
		rootDir: dataDir,
		cadreNode: natFallbackNode(),
	});
	// Real NAT probing may fail on the test host; per-module tests already cover that.
	try {
		await nat.start();
	} catch {
		// best-effort
	}

	let update: UpdateService | undefined;
	if (opts.manifestUrl) {
		const updateOpts: ConstructorParameters<typeof UpdateService>[0] = {
			dataDir,
			currentVersion: '0.0.0-test',
			manifestUrl: opts.manifestUrl,
			settings: opts.updateSettings ?? { autoApply: false },
		};
		if (opts.updateFetcher) updateOpts.fetcher = opts.updateFetcher;
		update = new UpdateService(updateOpts);
	}

	const serverOpts: Parameters<typeof createLocalUiServer>[0] = {
		uiPort: config.uiPort,
		dataDir,
		orchestrator,
		trustCircle,
		nat,
		forcePort: 0,
	};
	if (update) serverOpts.update = update;
	if (opts.sseHeartbeatMs !== undefined) serverOpts.sseHeartbeatMs = opts.sseHeartbeatMs;

	const server = createLocalUiServer(serverOpts);
	const { port, url } = await server.start();

	const host: TestCadreHost = {
		dataDir,
		port,
		baseUrl: url,
		config,
		orchestrator,
		trustCircle,
		nat,
		...(update ? { update } : {}),
		server,
		request: (req) => loopbackRequest(url, req),
		openEventStream: () => openEventStream(url),
		stop: async () => {
			try { await server.stop(); } catch { /* ignore */ }
			try { await nat.stop(); } catch { /* ignore */ }
			if (update) {
				try { update.stop(); } catch { /* ignore */ }
			}
			try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
			catch { /* ignore — Windows can lag on workdir release */ }
		},
	};
	return host;
}

/**
 * Loopback HTTP request via node:http so callers can override the Host /
 * Origin headers (which fetch() refuses to set).
 */
export async function loopbackRequest(baseUrl: string, opts: HttpRequestOptions): Promise<HttpResponseLite> {
	const u = new URL(baseUrl);
	const bodyBuf = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : undefined;
	const headers: Record<string, string> = {
		host: `${u.hostname}:${u.port}`,
		...opts.headers,
	};
	if (bodyBuf) {
		headers['content-type'] = headers['content-type'] ?? 'application/json';
		headers['content-length'] = String(bodyBuf.byteLength);
	}

	return await new Promise<HttpResponseLite>((resolve, reject) => {
		const req = httpRequest(
			{
				hostname: u.hostname,
				port: u.port,
				path: opts.path,
				method: opts.method,
				headers,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const raw = Buffer.concat(chunks).toString('utf8');
					const contentType = (res.headers['content-type'] ?? '').toString();
					let body: unknown = raw;
					if (contentType.includes('application/json') && raw.length > 0) {
						try { body = JSON.parse(raw); }
						catch { /* leave as raw */ }
					}
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body,
						raw,
					});
				});
				res.on('error', reject);
			},
		);
		req.on('error', reject);
		if (bodyBuf) req.write(bodyBuf);
		req.end();
	});
}

/** Open an SSE stream against /api/events and parse `event:`/`data:` frames. */
async function openEventStream(baseUrl: string): Promise<TestEventStream> {
	const u = new URL(baseUrl);
	const events: LocalUiEvent[] = [];
	const waiters: Array<{ predicate: (e: LocalUiEvent) => boolean; resolve: (e: LocalUiEvent) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }> = [];

	const deliver = (ev: LocalUiEvent): void => {
		events.push(ev);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i]!;
			if (w.predicate(ev)) {
				clearTimeout(w.timer);
				waiters.splice(i, 1);
				w.resolve(ev);
			}
		}
	};

	const req = httpRequest({
		hostname: u.hostname,
		port: u.port,
		path: '/api/events',
		method: 'GET',
		headers: {
			host: `${u.hostname}:${u.port}`,
			accept: 'text/event-stream',
		},
	});

	let buffered = '';
	let currentType = '';
	let currentData = '';

	const ready = new Promise<void>((resolve, reject) => {
		req.once('error', reject);
		req.once('response', (res) => {
			if (res.statusCode !== 200) {
				reject(new Error(`SSE connect failed: status ${res.statusCode}`));
				return;
			}
			res.setEncoding('utf8');
			res.on('data', (chunk: string) => {
				buffered += chunk;
				let nl: number;
				while ((nl = buffered.indexOf('\n')) !== -1) {
					const line = buffered.slice(0, nl).replace(/\r$/, '');
					buffered = buffered.slice(nl + 1);
					if (line === '') {
						if (currentType || currentData) {
							try {
								const parsed = JSON.parse(currentData) as LocalUiEvent;
								deliver(parsed);
							} catch { /* malformed payload — ignore */ }
							currentType = '';
							currentData = '';
						}
						continue;
					}
					if (line.startsWith(':')) continue;
					if (line.startsWith('event:')) { currentType = line.slice(6).trim(); continue; }
					if (line.startsWith('data:')) { currentData = line.slice(5).trim(); continue; }
				}
			});
			res.on('error', () => { /* swallow — close() handles teardown */ });
			resolve();
		});
	});
	req.end();
	await ready;

	const stream: TestEventStream = {
		async next(predicate, { timeoutMs = 5_000 } = {}) {
			const hit = events.find(predicate);
			if (hit) return hit;
			return await new Promise<LocalUiEvent>((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.timer === timer);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(new Error(`Timed out after ${timeoutMs}ms waiting for SSE event; received: ${events.map((e) => e.type).join(', ')}`));
				}, timeoutMs);
				waiters.push({ predicate, resolve, reject, timer });
			});
		},
		received: () => [...events],
		close: () => {
			for (const w of waiters.splice(0, waiters.length)) {
				clearTimeout(w.timer);
				w.reject(new Error('SSE stream closed'));
			}
			req.destroy();
		},
	};
	return stream;
}

/** Briefly listen on 127.0.0.1:0 to get a free port from the kernel. */
async function pickFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createNetServer();
		server.unref();
		server.once('error', reject);
		server.listen({ host: '127.0.0.1', port: 0 }, () => {
			const addr = server.address() as AddressInfo;
			const port = addr.port;
			server.close(() => resolve(port));
		});
	});
}
