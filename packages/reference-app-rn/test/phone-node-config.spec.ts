import { describe, expect, it } from 'vitest';
import type { IRawStorage } from '@optimystic/db-p2p';
import {
	InMemoryKeyStore,
	MemoryBootstrapPeerStore,
	MemoryEnrolledMachineStore,
	MemoryTrustedOwnerStore,
	RELAY_SEARCH_LISTEN_ADDR,
	resolveListenAddrs,
	strandNodeAddrs,
} from '@serfab/cadre-core';
import { buildPhoneNodeConfig } from '../src/phone-node-config.js';

/**
 * Assertions about the phone's `CadreNodeConfig` that do not need a node started.
 * `solo-founding.spec.ts` builds the same config and runs it for real; this file
 * covers the settings whose absence would only show up as a failed dial on a
 * device, which no headless test reaches.
 *
 * The relay cases deliberately assert on cadre-core's OWN derivation
 * (`resolveListenAddrs`, `strandNodeAddrs`) rather than only on the fields this
 * module sets: what matters is the node shape that comes out, not the spelling that
 * goes in, and it is the derivation that decides whether a strand node gets a
 * circuit listener at all.
 */

const partyId = 'phone-node-config-spec';

/** A syntactically valid relay dial addr. Nothing here dials, so it need not exist. */
const RELAY_ADDR = '/ip4/203.0.113.7/tcp/4002/ws/p2p/12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5';
const SECOND_RELAY_ADDR = '/ip4/203.0.113.8/tcp/4002/ws/p2p/12D3KooWDpJ7As7BWAwRMfu1VU2WCqNjvq387JEYKDBj4kx6nXTN';

function config(relayAddrs: string[] = []) {
	return buildPhoneNodeConfig({
		partyId,
		bootstrapAddrs: [],
		relayAddrs,
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
		expect(config([RELAY_ADDR]).network?.listenAddrs).toEqual([]);
	});

	it('carries the configured relays through verbatim', () => {
		expect(config([RELAY_ADDR, SECOND_RELAY_ADDR]).network?.relayAddrs)
			.toEqual([RELAY_ADDR, SECOND_RELAY_ADDR]);
		expect(config().network?.relayAddrs).toEqual([]);
	});

	it('never requires a relay, so a phone starts with its relay down or absent', () => {
		// `requireRelay: false` softens ONLY the reservation half: a first attempt that
		// lands nothing is logged and retried in the background instead of throwing
		// `RelayReservationFailedError` out of `start()`. A phone that could not boot on
		// a dead network would be useless.
		expect(config([RELAY_ADDR]).network?.requireRelay).toBe(false);
		expect(config().network?.requireRelay).toBe(false);
	});
});

describe('buildPhoneNodeConfig — what cadre-core derives from it', () => {
	it('gives the control node a bare /p2p-circuit listener once a relay is named', () => {
		// An explicitly empty `listenAddrs` stays empty, and the search entry is ADDED to
		// it: the phone gains a circuit address without gaining a direct listener it
		// cannot bind.
		expect(resolveListenAddrs(config([RELAY_ADDR]).network)).toEqual([RELAY_SEARCH_LISTEN_ADDR]);
	});

	it('leaves the control node with no listener at all when no relay is named', () => {
		expect(resolveListenAddrs(config().network)).toEqual([]);
	});

	it('gives every STRAND node a search listener and a supervised relay per relay', () => {
		// This is the whole reason the app uses `network.relayAddrs` rather than
		// `CadreNode.reserveRelays()`: that call reaches the control node and stops
		// there, while formation has the invitee dial the control node FIRST and then
		// the strand nodes, which need circuit addresses of their own.
		const oneRelay = strandNodeAddrs(config([RELAY_ADDR]).network);
		expect(oneRelay.listenAddrs).toEqual([RELAY_SEARCH_LISTEN_ADDR]);
		expect(oneRelay.relayAddrs).toEqual([RELAY_ADDR]);

		// One listener per relay, because a search listener registers exactly one
		// pending reservation and libp2p fills it with exactly one relay.
		const twoRelays = strandNodeAddrs(config([RELAY_ADDR, SECOND_RELAY_ADDR]).network);
		expect(twoRelays.listenAddrs).toEqual([RELAY_SEARCH_LISTEN_ADDR, RELAY_SEARCH_LISTEN_ADDR]);
		expect(twoRelays.relayAddrs).toEqual([RELAY_ADDR, SECOND_RELAY_ADDR]);
	});

	it('leaves strand nodes with no listener and no supervisor when no relay is named', () => {
		const derived = strandNodeAddrs(config().network);
		expect(derived.listenAddrs).toEqual([]);
		expect(derived.relayAddrs).toBeUndefined();
	});

	it('rejects a malformed relay entry at config resolution, naming the field', () => {
		// Fail-fast regardless of `requireRelay`: a typo typed into the Settings "Relay"
		// field must surface as a refused connection, not as a node that came up
		// quietly unreachable.
		expect(() => resolveListenAddrs(config(['not-a-multiaddr']).network))
			.toThrow(/network\.relayAddrs/);
	});
});
