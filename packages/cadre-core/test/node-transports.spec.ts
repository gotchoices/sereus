import { describe, it, expect } from 'vitest';
import { nodeTransportsOption } from '../src/node-transports.js';
import { DEFAULT_RELAY_RESERVE_TIMEOUT_MS } from '../src/relay-reservation.js';
import type { NetworkConfig } from '../src/types.js';

/**
 * Whether a node is built from an explicit transport list, and from WHOSE list.
 *
 * The two reasons cadre has to own the list are independent, and only the relay one was
 * checked: a node with supervised relay slots needs the list wrapped
 * (`relay-reservation.ts`), and a node whose listen entries name `/webrtc` needs the list
 * at all, because `@optimystic/db-p2p`'s own default list cannot carry that transport. A
 * `/webrtc` entry on a node with no relay satisfies only the second, and libp2p drops a
 * listen address no transport claims without a word — the failure
 * `resolveTransportOptions` refuses the entry to prevent.
 */

/** Opaque stand-ins: nothing here builds or calls a transport factory. */
const EMBEDDER_TRANSPORTS = [(() => ({ embedder: true })) as never];
const DEFAULT_LIST = [(() => ({ injected: true })) as never];

const defaultTransports: NetworkConfig['defaultTransports'] = () => DEFAULT_LIST;

describe('nodeTransportsOption', () => {
  it('builds the injected list for a /webrtc entry even with no relay slots to supervise', () => {
    expect(nodeTransportsOption({ defaultTransports }, { webrtcIceServers: [] }, false))
      .toEqual({ transports: DEFAULT_LIST });
  });

  /**
   * The narrowness matters: a node whose entries db-p2p can bind on its own keeps inheriting
   * db-p2p's list, so this stays one rule about one unsupported transport rather than cadre
   * quietly taking over transport policy everywhere.
   */
  it('leaves transports off for an unsupervised node whose entries db-p2p can bind itself', () => {
    expect(nodeTransportsOption({ defaultTransports }, { wsPort: 0 }, false)).toEqual({});
    expect(nodeTransportsOption({ defaultTransports }, {}, false)).toEqual({});
  });

  it('passes the embedder\'s own list through unwrapped when there are no slots to protect', () => {
    expect(nodeTransportsOption({ transports: EMBEDDER_TRANSPORTS }, {}, false))
      .toEqual({ transports: EMBEDDER_TRANSPORTS });
  });
});

/**
 * What the supervised arm does to libp2p's circuit-relay transport, built.
 *
 * Both switches are regressions waiting to happen for the same reason: they are writes onto a
 * libp2p object after its factory ran, so nothing in the type system says they still land. The
 * reservation budget is the one with a silent failure mode — left at libp2p's flat 5 000 ms
 * default, a node on a link slower than that cannot reserve a relay slot at ANY
 * `linkRoundTripMs`, which is how `joiner-first-commit-over-slow-relay` failed intermittently in
 * `CadreNode.start()`. See `withReservationCompletionBudget` in `relay-reservation.ts`.
 */
describe('nodeTransportsOption over the circuit-relay transport', () => {
	/** The shape `@libp2p/circuit-relay-v2`'s transport presents: a reservation store, and `discovery`. */
	interface FakeCircuitRelayTransport {
		reservationStore: {
			addRelay: () => Promise<undefined>;
			hasReservation: () => boolean;
			reservationCompletionTimeout: number;
		};
		discovery?: unknown;
	}

	function fakeCircuitRelayTransport(): FakeCircuitRelayTransport {
		return {
			reservationStore: {
				addRelay: async () => undefined,
				hasReservation: () => false,
				reservationCompletionTimeout: 5_000,
			},
			discovery: { startDiscovery: () => undefined },
		};
	}

	/** Build the one factory the option came back with, as libp2p does in its constructor. */
	function buildOnly(option: { transports?: readonly unknown[] }): FakeCircuitRelayTransport {
		const factories = option.transports;
		expect(factories).toHaveLength(1);
		const factory = factories![0] as (components: unknown) => FakeCircuitRelayTransport;
		return factory({});
	}

	it('derives the reservation budget from the declared link and switches discovery off', () => {
		const transports = [(() => fakeCircuitRelayTransport()) as never];
		const built = buildOnly(nodeTransportsOption({ transports, linkRoundTripMs: 10_000 }, {}, true));
		// relayReservationBudgetMs(10_000): 4 round trips plus two admission decisions.
		expect(built.reservationStore.reservationCompletionTimeout).toBe(44_000);
		expect(built.discovery).toBeUndefined();
	});

	it('derives it from the default declaration when the node declares no link', () => {
		const transports = [(() => fakeCircuitRelayTransport()) as never];
		const built = buildOnly(nodeTransportsOption({ transports }, {}, true));
		expect(built.reservationStore.reservationCompletionTimeout).toBe(DEFAULT_RELAY_RESERVE_TIMEOUT_MS);
		// Whatever the declaration, cadre's own drive deadline has to be the one that gives up.
		expect(built.reservationStore.reservationCompletionTimeout).toBeGreaterThanOrEqual(5_000);
	});

	/** An unsupervised node drives no reservation of its own, so neither switch applies. */
	it('leaves the transport alone when the relay slots are not supervised', () => {
		const transports = [(() => fakeCircuitRelayTransport()) as never];
		const built = buildOnly(nodeTransportsOption({ transports }, {}, false));
		expect(built.reservationStore.reservationCompletionTimeout).toBe(5_000);
		expect(built.discovery).toBeDefined();
	});

	it('leaves a transport that is not the circuit-relay one untouched', () => {
		const other = { listen: () => undefined };
		const transports = [(() => other) as never];
		expect(buildOnly(nodeTransportsOption({ transports }, {}, true)) as unknown).toBe(other);
	});
});
