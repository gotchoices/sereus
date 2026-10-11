/**
 * Node-only: the machine's main LAN address, for {@link selectNodeClaimAddresses}'s `lan`.
 *
 * The address the OS would send from to reach the internet, learned by "connecting" a UDP
 * socket to a public address: a UDP connect only picks a route and sends nothing. On a
 * server that also has Docker bridges, a VPN or other interfaces, that is the one a phone on
 * the same network reaches. A subpath module (`@serfab/cadre-core/primary-lan-address`), like
 * `key-store-file`, so `node:dgram` never reaches a React Native bundle.
 */
import dgram from 'node:dgram';
import debug from 'debug';

const log = debug('sereus:cadre:primary-lan-address');

/** Any public IPv4 address works: nothing is sent to it. */
const ROUTE_PROBE = { host: '1.1.1.1', port: 53 } as const;

/**
 * The machine's primary IPv4 address, or undefined when there is no route (offline) or the
 * probe fails. Callers then fall back to keeping every LAN address. `probe` is for tests.
 */
export async function primaryLanAddress(probe: { host: string; port: number } = ROUTE_PROBE): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket('udp4');
		let settled = false;
		const finish = (address?: string): void => {
			if (settled) return;
			settled = true;
			socket.close();
			resolve(address);
		};
		socket.on('error', (err) => {
			log('route probe failed: %s', err.message);
			finish();
		});
		socket.connect(probe.port, probe.host, (err?: Error) => {
			// A failed connect reports here, not as 'error', and leaves the socket bound to
			// 0.0.0.0, so its address() must not be read.
			if (err) {
				log('no route to probe: %s', err.message);
				finish();
				return;
			}
			finish(socket.address().address);
		});
	});
}
