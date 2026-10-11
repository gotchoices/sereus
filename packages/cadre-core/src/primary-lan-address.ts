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

/** Any public IPv4 address works: nothing is sent to it. */
const ROUTE_PROBE = { host: '1.1.1.1', port: 53 } as const;

/**
 * The machine's primary IPv4 address, or undefined when there is no route (offline) or the
 * probe fails. Callers then fall back to keeping every LAN address.
 */
export async function primaryLanAddress(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const socket = dgram.createSocket('udp4');
		const finish = (address?: string): void => {
			try {
				socket.close();
			} catch {
				// already closed
			}
			resolve(address);
		};
		socket.on('error', () => finish());
		try {
			socket.connect(ROUTE_PROBE.port, ROUTE_PROBE.host, () => {
				try {
					finish(socket.address().address);
				} catch {
					finish();
				}
			});
		} catch {
			finish();
		}
	});
}
