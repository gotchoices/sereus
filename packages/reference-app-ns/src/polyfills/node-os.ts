/**
 * Minimal `node:os` shim for the NativeScript runtime.
 *
 * Only the surface `@libp2p/utils` touches. Unlike the RN port
 * (packages/reference-app-rn/polyfills/node-os.js) this does NOT import
 * `react-native` — NativeScript has no such module. `networkInterfaces`
 * returns `{}` so libp2p falls back to its other discovery paths; the rest are
 * advisory and never gate behaviour.
 */

export function networkInterfaces(): Record<string, unknown[]> {
	return {};
}

export function platform(): string {
	return 'linux';
}

export function type(): string {
	return 'Linux';
}

export function hostname(): string {
	return 'localhost';
}

export const EOL = '\n';

export default {
	networkInterfaces,
	platform,
	type,
	hostname,
	EOL,
};
