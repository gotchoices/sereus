/**
 * In-process HTTP fixture that serves a signed update manifest envelope at
 * `/latest.json` over a loopback port. Used by the cadre-host update-notify
 * integration scenario to exercise UpdateService end-to-end without reaching
 * out to a real network.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { SignedManifest } from '@serfab/cadre-host';

export interface ManifestFixtureServer {
	/** Absolute URL the fixture is serving from (e.g. http://127.0.0.1:54321/latest.json). */
	readonly url: string;
	/** Replace the manifest envelope served by subsequent requests. */
	setManifest(envelope: SignedManifest): void;
	/** Tear down the HTTP listener. */
	close(): Promise<void>;
}

export async function startManifestServer(initial: SignedManifest): Promise<ManifestFixtureServer> {
	let envelope: SignedManifest = initial;

	const server: Server = createServer((req, res) => {
		if (req.method !== 'GET') {
			res.statusCode = 405;
			res.end();
			return;
		}
		if (req.url === '/latest.json') {
			res.statusCode = 200;
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify(envelope));
			return;
		}
		res.statusCode = 404;
		res.end();
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen({ host: '127.0.0.1', port: 0 }, () => {
			server.off('error', reject);
			resolve();
		});
	});

	const addr = server.address() as AddressInfo;
	const url = `http://127.0.0.1:${addr.port}/latest.json`;

	return {
		url,
		setManifest(next: SignedManifest): void {
			envelope = next;
		},
		async close(): Promise<void> {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
