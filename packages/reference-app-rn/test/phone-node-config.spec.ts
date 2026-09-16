import { describe, expect, it } from 'vitest';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
	InMemoryKeyStore,
	MemoryBootstrapPeerStore,
	MemoryEnrolledMachineStore,
	MemoryTrustedOwnerStore,
} from '@serfab/cadre-core';
import { buildPhoneNodeConfig } from '../src/phone-node-config.js';

/**
 * Assertions about the phone's `CadreNodeConfig` that do not need a node started.
 * `solo-founding.spec.ts` builds the same config and runs it for real; this file
 * covers the settings whose absence would only show up as a failed dial on a
 * device, which no headless test reaches.
 */

const partyId = 'phone-node-config-spec';

function config() {
	return buildPhoneNodeConfig({
		partyId,
		bootstrapAddrs: [],
		keyStore: new InMemoryKeyStore(),
		// Never called: nothing here starts the node.
		storageProvider: () => ({} as IRawStorage),
		transports: [],
		trustedOwnerStore: new MemoryTrustedOwnerStore(partyId),
		bootstrapPeerStore: new MemoryBootstrapPeerStore(partyId),
		enrolledMachineStore: new MemoryEnrolledMachineStore(partyId),
	});
}

describe('buildPhoneNodeConfig', () => {
	it('permits dialling private and insecure addresses', () => {
		// A node borrowed from a cadre-host on the same Wi-Fi is reached at a private
		// `ws://` address. libp2p's browser-build connection gater — which is what the
		// package's `react-native` field points at — refuses exactly those by default,
		// and cadre-core's membership gater supplies only `denyDialPeer` and the
		// inbound/relay hooks. Without this the phone provisions the node, seeds it, and
		// then silently never connects.
		const gater = config().network?.connectionGater;

		expect(gater?.denyDialMultiaddr).toBeTypeOf('function');
		// libp2p reads the return value: `true` denies the dial.
		expect(gater?.denyDialMultiaddr?.({} as never)).toBe(false);
	});

	it('still listens on nothing — the phone is always the side that dials', () => {
		expect(config().network?.listenAddrs).toEqual([]);
	});
});
