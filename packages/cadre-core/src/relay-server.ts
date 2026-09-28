/**
 * The circuit-relay SERVER a party-run node runs — whether it runs one, and with which
 * `@libp2p/circuit-relay-v2` init — resolved once from `NetworkConfig` for both node
 * kinds: the control node (`cadre-node.ts` → `buildControlNodeOptions`) and every strand
 * node (`strand-instance-manager.ts` → `buildStrandRuntime`). One function decides both
 * answers so the two build sites cannot drift apart.
 *
 * WHY cadre sets an init at all. libp2p's server defaults `applyDefaultLimit` to true,
 * which stamps every reservation with `Limit { data: 128 KiB, duration: 2 min }`; libp2p
 * marks each connection relayed under it "limited" and resets it once either cap is
 * reached, and db-p2p's database protocols refuse a limited connection outright (they do
 * not set `runOnLimitedConnection`). A party-run relay exists to carry that party's own
 * database traffic, so the cap cut off every sync and chat history forwarded through it
 * (gotchoices/sereus#19). The dedicated relays (`ops/docker/libp2p-infra`, and the
 * `startDedicatedRelay` test fixture that stands in for it) already turn the limit off;
 * this is the same policy for the party-run kind.
 */

import type { CircuitRelayServerInit, ServerReservationStoreInit } from '@libp2p/circuit-relay-v2';
import type { NetworkConfig, NodeProfile } from './types.js';

/**
 * Default size of a party-run relay's reservation store, raised from libp2p's 15.
 *
 * A NAT'd machine reserves one slot for its control node and one for each strand it
 * serves, all on the same relay (`strand-network-config.ts` hands strand nodes the
 * control node's `network.relayAddrs`), so the store needs
 * `NAT'd machines × (1 + strands each)` slots. At libp2p's 15, three phones serving four
 * strands each already fill it. 128 covers, for example, ten NAT'd machines serving eleven
 * strands each with the unauthorized-reservation budget's 8 slots
 * (`MAX_UNAUTHORIZED_RELAY_RESERVATIONS`) still free on top — one party's worth, where the
 * dedicated relay's 500 is sized for many parties. A reservation costs the server a map
 * entry and a timer, not a connection's worth of state, so the headroom is cheap.
 */
export const PARTY_RELAY_MAX_RESERVATIONS = 128;

/**
 * How long a party-run relay holds a reservation that is not refreshed: libp2p's own
 * default (2 h), set EXPLICITLY so that cadre, not a libp2p constant it cannot import,
 * owns the value the unauthorized-reservation budget has to agree with (see
 * {@link ResolvedRelayServer.init}).
 */
export const PARTY_RELAY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * The reservation-store settings every party-run relay resolves unless the caller
 * overrides them one key at a time through `network.relayServerInit.reservations`.
 * `applyDefaultLimit: false` is the point of this module — see the module doc.
 */
const PARTY_RELAY_RESERVATION_DEFAULTS = {
  applyDefaultLimit: false,
  maxReservations: PARTY_RELAY_MAX_RESERVATIONS,
  reservationTtl: PARTY_RELAY_RESERVATION_TTL_MS
} as const satisfies ServerReservationStoreInit;

/** Reservation settings with the three keys cadre always resolves made definite. */
export type ResolvedRelayReservations = ServerReservationStoreInit
  & Required<Pick<ServerReservationStoreInit, keyof typeof PARTY_RELAY_RESERVATION_DEFAULTS>>;

/** What {@link resolveRelayServer} decides for one node. */
export interface ResolvedRelayServer {
  /** Does this node run the relay server? Passed as db-p2p's `relay`. */
  enabled: boolean;
  /**
   * The server's init, passed as db-p2p's `relayServerInit` when {@link enabled}: the
   * party-run defaults with the caller's `network.relayServerInit` merged over them.
   * `reservations.reservationTtl` is always set, which is what lets the control node's
   * unauthorized-reservation budget expire its entries on the server's own clock.
   */
  init: CircuitRelayServerInit & { reservations: ResolvedRelayReservations };
}

/**
 * Resolve the relay server for a node built from `network` with `profile`.
 *
 * `enabled`: an explicit `network.enableRelay` wins; otherwise storage-profile nodes run
 * the server (they are the machines with the connectivity and uptime to be a relay).
 *
 * `init`: MERGED, not replaced. `reservations` is merged key by key over the party-run
 * defaults, so a caller who sets only `maxReservations` does not silently get the data
 * limit back; every other top-level key is taken from the caller as given. A key set to
 * `undefined` counts as unset, so the default beneath it holds.
 */
export function resolveRelayServer(network: NetworkConfig | undefined, profile: NodeProfile): ResolvedRelayServer {
  const override = network?.relayServerInit;
  return {
    enabled: network?.enableRelay ?? (profile === 'storage'),
    init: {
      ...override,
      reservations: { ...PARTY_RELAY_RESERVATION_DEFAULTS, ...definedEntries(override?.reservations) }
    }
  };
}

/** `obj` without its `undefined`-valued keys, so spreading it never erases a default. */
function definedEntries<T extends object>(obj: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, value]) => value !== undefined)) as Partial<T>;
}
