/**
 * cadre-host bootstrap integration scenario.
 *
 * This scenario is intentionally inlined (no TestCadreHost) — it proves the
 * install → start sequence works end-to-end. If TestCadreHost.stop() is
 * broken, the bootstrap test still passes; everyone else gets a useful
 * failure.
 *
 * Exercises:
 *   - Installer.install() writes host.config.json, identity.key, nat.json, logs/
 *   - createLocalUiServer.start() binds an ephemeral port and serves /api/status
 *   - /api/settings reflects the installer's host.config.json
 *   - /  serves text/html (placeholder when dist/ui is missing)
 *   - Re-running install preserves identity.key bytes
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	HostProcessOrchestrator,
	Installer,
	NatService,
	TrustCircleService,
	TrustCircleStore,
	createLocalUiServer,
	readHostConfig,
	type LocalUiServer,
	type ServiceHost,
	type ServiceHostContext,
	type ServiceHostStatus,
} from '@serfab/cadre-host';

import { defaultFakeCadreNode } from '../harness/index.js';

class StubServiceHost implements ServiceHost {
	readonly name = 'cadre-host-test';
	async install(_ctx: ServiceHostContext): Promise<void> { /* no-op */ }
	async uninstall(_ctx: ServiceHostContext): Promise<void> { /* no-op */ }
	async restart(_ctx: ServiceHostContext): Promise<void> { /* no-op */ }
	async status(_ctx: ServiceHostContext): Promise<ServiceHostStatus> { return { installed: true, running: true }; }
	renderUnit(_ctx: ServiceHostContext): string | null { return 'stub'; }
}

describe('cadre-host bootstrap', () => {
	let dataDir: string;
	let server: LocalUiServer | undefined;
	let orchestrator: HostProcessOrchestrator | undefined;
	let nat: NatService | undefined;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'integration-cadre-host-bootstrap-'));
	});

	afterEach(async () => {
		try { await server?.stop(); } catch { /* ignore */ }
		try { await nat?.stop(); } catch { /* ignore */ }
		try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
		server = undefined;
		orchestrator = undefined;
		nat = undefined;
	});

	async function pickFreePort(): Promise<number> {
		return await new Promise<number>((resolve, reject) => {
			const s = createNetServer();
			s.unref();
			s.once('error', reject);
			s.listen({ host: '127.0.0.1', port: 0 }, () => {
				const addr = s.address() as AddressInfo;
				const port = addr.port;
				s.close(() => resolve(port));
			});
		});
	}

	async function bootHost(): Promise<{ baseUrl: string; port: number }> {
		const installer = new Installer({ platform: 'linux', installerVersion: '0.0.0-bootstrap-test' });
		await installer.install({
			nonInteractive: true,
			dataDir,
			uiPort: await pickFreePort(),
			libp2pPort: await pickFreePort(),
			openBrowser: false,
			noInvite: true,
			serviceHost: new StubServiceHost(),
		});

		const config = readHostConfig(join(dataDir, 'host.config.json'));
		orchestrator = new HostProcessOrchestrator({ rootDir: join(dataDir, 'orchestrator'), stopTimeoutMs: 2_000 });
		await orchestrator.init();

		const trustCircle = new TrustCircleService({
			cadreNode: defaultFakeCadreNode(),
			store: new TrustCircleStore(dataDir),
		});

		nat = new NatService({
			rootDir: dataDir,
			cadreNode: { getPeerId: () => '', getMultiaddrs: () => [] },
		});
		try { await nat.start(); } catch { /* tolerate */ }

		server = createLocalUiServer({
			uiPort: config.uiPort,
			dataDir,
			orchestrator,
			trustCircle,
			nat,
			forcePort: 0,
		});
		const started = await server.start();
		return { baseUrl: started.url, port: started.port };
	}

	it('install + start → /api/status returns the live service snapshot', async () => {
		const { baseUrl } = await bootHost();
		const res = await fetch(`${baseUrl}/api/status`);
		expect(res.status).toBe(200);
		const body = await res.json() as {
			service: { name: string; version: string; uptimeSeconds: number };
			trustCircle: { members: number; pending: number };
			connectivity: { portMode: string; directReachability: string };
		};
		expect(body.service.name).toBe('cadre-host');
		expect(typeof body.service.version).toBe('string');
		expect(body.service.version.length).toBeGreaterThan(0);
		expect(body.service.uptimeSeconds).toBeGreaterThanOrEqual(0);
		expect(body.trustCircle).toEqual({ members: 0, pending: 0 });
		expect(typeof body.connectivity.portMode).toBe('string');
		expect(typeof body.connectivity.directReachability).toBe('string');
	});

	it('/api/settings reflects host.config.json written by the installer', async () => {
		const { baseUrl } = await bootHost();
		const res = await fetch(`${baseUrl}/api/settings`);
		expect(res.status).toBe(200);
		const body = await res.json() as { ok: true; data: { uiPort: number; libp2pPort: number; upnpEnabled: boolean; dataDir: string; installId: string; installerVersion: string } };
		expect(body.ok).toBe(true);
		expect(body.data.dataDir).toBe(dataDir);
		expect(typeof body.data.uiPort).toBe('number');
		expect(typeof body.data.libp2pPort).toBe('number');
		expect(body.data.upnpEnabled).toBe(true);
		expect(typeof body.data.installId).toBe('string');
		expect(body.data.installId.length).toBeGreaterThan(0);
		expect(body.data.installerVersion).toBe('0.0.0-bootstrap-test');
	});

	it('GET / serves an HTML response (placeholder or SPA)', async () => {
		const { baseUrl } = await bootHost();
		const res = await fetch(`${baseUrl}/`);
		expect(res.status).toBe(200);
		expect((res.headers.get('content-type') ?? '')).toContain('text/html');
		const text = await res.text();
		expect(text.length).toBeGreaterThan(0);
	});

	it('install is idempotent on identity.key', async () => {
		const installer = new Installer({ platform: 'linux' });
		const uiPort1 = await pickFreePort();
		const libp2pPort1 = await pickFreePort();
		await installer.install({
			nonInteractive: true,
			dataDir,
			uiPort: uiPort1,
			libp2pPort: libp2pPort1,
			openBrowser: false,
			noInvite: true,
			serviceHost: new StubServiceHost(),
		});
		const before = readFileSync(join(dataDir, 'identity.key'));
		await installer.install({
			nonInteractive: true,
			dataDir,
			uiPort: await pickFreePort(),
			libp2pPort: await pickFreePort(),
			openBrowser: false,
			noInvite: true,
			serviceHost: new StubServiceHost(),
		});
		const after = readFileSync(join(dataDir, 'identity.key'));
		expect(Buffer.from(before).equals(Buffer.from(after))).toBe(true);
	});
});
