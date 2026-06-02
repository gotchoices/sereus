/**
 * UpdateService integration scenarios.
 *
 * The harness wires a real `UpdateService` against a real loopback HTTP
 * fixture serving a signed manifest envelope. We then call
 * `update.check()` directly (the cadre-host start path's "fetch the
 * latest manifest at boot") and assert:
 *   - higher version → update-state.json + GET /update/state reflect it
 *   - equal/older version → no `available`
 *   - bad signature → `lastError.code === 'signature_invalid'`
 *
 * The 60 s boot-time observer in `server/index.ts` is covered separately by
 * `packages/cadre-host/src/server/__tests__/publishers.test.ts`. Here we
 * spot-check the SSE delivery path by publishing an event onto the bus
 * directly — that exercises the bus → SSE serializer wiring without
 * waiting on the observer's 1-min poll.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';

import { signManifest, type SignedManifest, type UpdateManifest } from '@serfab/cadre-host';

import { createTestCadreHost, type TestCadreHost } from '../harness/index.js';
import { startManifestServer, type ManifestFixtureServer } from '../harness/fixtures/manifest-server.js';

function freshKeypair(): { privateKey: KeyObject; publicRawB64: string } {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const spki = publicKey.export({ format: 'der', type: 'spki' });
	return { privateKey, publicRawB64: Buffer.from(spki.subarray(12)).toString('base64') };
}

function manifest(version: string, opts: Partial<UpdateManifest> = {}): UpdateManifest {
	return {
		v: 1,
		version,
		publishedAt: '2026-05-15T18:00:00.000Z',
		channels: { npm: { package: '@serfab/cadre-host', tag: 'latest' } },
		...opts,
	};
}

describe('cadre-host update notify', () => {
	let kp: ReturnType<typeof freshKeypair>;
	let envelope: SignedManifest;
	let manifestServer: ManifestFixtureServer;
	let host: TestCadreHost;

	beforeEach(async () => {
		kp = freshKeypair();
		process.env.CADRE_HOST_UPDATE_DEV_KEY = kp.publicRawB64;
		envelope = signManifest(manifest('0.7.0', { releaseNotesUrl: 'https://example.com/release' }), kp.privateKey);
		manifestServer = await startManifestServer(envelope);
		host = await createTestCadreHost({ manifestUrl: manifestServer.url });
	});

	afterEach(async () => {
		try { await host.stop(); } catch { /* ignore */ }
		try { await manifestServer.close(); } catch { /* ignore */ }
		delete process.env.CADRE_HOST_UPDATE_DEV_KEY;
	});

	it('manifest > current → state.available is set and GET /update/state surfaces it', async () => {
		expect(host.update).toBeDefined();
		await host.update!.check();
		const state = await host.update!.getState();
		expect(state.available).toMatchObject({
			version: '0.7.0',
			publishedAt: '2026-05-15T18:00:00.000Z',
			releaseNotesUrl: 'https://example.com/release',
		});
		expect(state.lastChecked).toBeDefined();
		expect(state.lastError).toBeUndefined();

		const res = await host.request({ method: 'GET', path: '/update' });
		expect(res.status).toBe(200);
		const body = res.body as { available?: { version: string } };
		expect(body.available?.version).toBe('0.7.0');
	});

	it('apply is never started without an explicit call (autoApply defaults to false)', async () => {
		expect(host.update).toBeDefined();
		await host.update!.check();
		const state = await host.update!.getState();
		expect(state.applyInProgress).toBeUndefined();
	});

	it('manifest at the same version → no `available` is recorded', async () => {
		manifestServer.setManifest(signManifest(manifest('0.0.0-test'), kp.privateKey));
		await host.update!.check();
		const state = await host.update!.getState();
		expect(state.available).toBeUndefined();
		expect(state.lastChecked).toBeDefined();
	});

	it('manifest with bad signature → lastError.code is signature_invalid', async () => {
		const other = freshKeypair();
		process.env.CADRE_HOST_UPDATE_DEV_KEY = other.publicRawB64;
		await host.update!.check();
		const state = await host.update!.getState();
		expect(state.lastError?.code).toBe('signature_invalid');
		expect(state.available).toBeUndefined();
	});

	it('publishing update-available onto the bus delivers it over SSE', async () => {
		const baseline = host.server.events.listenerCount();
		const stream = await host.openEventStream();
		try {
			const deadline = Date.now() + 2_000;
			while (host.server.events.listenerCount() <= baseline && Date.now() < deadline) {
				await new Promise<void>((r) => setTimeout(r, 20));
			}
			host.server.events.publish({ type: 'update-available', version: '0.7.0', releaseNotesUrl: 'https://example.com/release' });
			const ev = await stream.next((e) => e.type === 'update-available');
			expect(ev).toMatchObject({ type: 'update-available', version: '0.7.0', releaseNotesUrl: 'https://example.com/release' });
		} finally {
			stream.close();
		}
	});
});
