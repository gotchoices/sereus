/**
 * `relay-config.ts` — how the phone decides which circuit relay it reserves a slot
 * on, which is the only thing that gives it an address other people can dial.
 *
 * Mirrors `ice-config.spec.ts`'s treatment of `resolveIceConfigUrl` and the web
 * copy's resolution order (`reference-app-web/src/lib/relay-config.ts`): explicit
 * argument wins, then the build-time env var, then nothing. The web copy has a
 * third source (`localStorage`) that React Native has no equivalent for — the
 * per-device seam here is the Settings field, which arrives as `explicit`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolveRelayAddrs, splitRelayAddrs } from '../src/relay-config';

const ENV_ADDR = '/ip4/10.0.0.1/tcp/4002/ws/p2p/12D3KooWEnvRelayAddressFromTheBuild';
const TYPED_ADDR = '/ip4/10.0.0.2/tcp/4002/ws/p2p/12D3KooWTypedRelayAddressFromSettings';

afterEach(() => {
	delete process.env.EXPO_PUBLIC_RELAY_ADDR;
});

describe('splitRelayAddrs', () => {
	it('splits on commas and trims each entry', () => {
		expect(splitRelayAddrs(`${ENV_ADDR}, ${TYPED_ADDR}`)).toEqual([ENV_ADDR, TYPED_ADDR]);
	});

	it('drops blank entries, so a trailing comma or a field of spaces yields nothing', () => {
		expect(splitRelayAddrs(`${ENV_ADDR},,  ,`)).toEqual([ENV_ADDR]);
		expect(splitRelayAddrs('   ')).toEqual([]);
		expect(splitRelayAddrs('')).toEqual([]);
	});

	it('passes a malformed entry through — validation is cadre-core\'s, at config resolution', () => {
		// `relayCircuitAddrs` throws naming `network.relayAddrs`, which is what puts the
		// typo on the Settings screen (status `error`, message under the Node card).
		// Silently dropping it here would instead start a node that is quietly unreachable.
		expect(splitRelayAddrs('not-a-multiaddr')).toEqual(['not-a-multiaddr']);
	});
});

describe('resolveRelayAddrs', () => {
	it('returns an explicit non-empty list over the env var', () => {
		process.env.EXPO_PUBLIC_RELAY_ADDR = ENV_ADDR;
		expect(resolveRelayAddrs([TYPED_ADDR])).toEqual([TYPED_ADDR]);
	});

	it('falls back to the env var when the explicit list is empty', () => {
		// The Settings field starts prefilled from the env var, so this is only reached
		// when the user cleared it — and clearing a prefilled field is how they ask for
		// the build default back, not how they ask for no relay.
		process.env.EXPO_PUBLIC_RELAY_ADDR = ENV_ADDR;
		expect(resolveRelayAddrs([])).toEqual([ENV_ADDR]);
		expect(resolveRelayAddrs()).toEqual([ENV_ADDR]);
	});

	it('splits, trims and blank-filters the env var', () => {
		process.env.EXPO_PUBLIC_RELAY_ADDR = ` ${ENV_ADDR} , ${TYPED_ADDR},, `;
		expect(resolveRelayAddrs()).toEqual([ENV_ADDR, TYPED_ADDR]);
	});

	it('returns [] when nothing is configured — a supported posture, not a failure', () => {
		delete process.env.EXPO_PUBLIC_RELAY_ADDR;
		expect(resolveRelayAddrs()).toEqual([]);
		expect(resolveRelayAddrs([])).toEqual([]);
	});

	it('treats an empty env var as "not configured"', () => {
		process.env.EXPO_PUBLIC_RELAY_ADDR = '';
		expect(resolveRelayAddrs()).toEqual([]);
	});

	it('never throws, whatever it is handed', () => {
		process.env.EXPO_PUBLIC_RELAY_ADDR = ',,,';
		expect(() => resolveRelayAddrs()).not.toThrow();
		expect(resolveRelayAddrs()).toEqual([]);
	});
});
