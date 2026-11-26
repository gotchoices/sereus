/**
 * The `transports` option for a cadre-built libp2p node, control and strand alike.
 *
 * A node whose bare `/p2p-circuit` search entries cadre generated for configured relays gets its
 * transports through {@link withoutRelayDiscovery}, so libp2p's relay discovery cannot hand those
 * slots to some other relay-capable peer before the per-relay supervisors fill them (see
 * `relay-reservation.ts`, "WHY LIBP2P'S RELAY DISCOVERY IS SWITCHED OFF"), and through
 * {@link withReservationCompletionBudget}, so the reservation each supervisor drives is bounded by
 * the declared link rather than by libp2p's flat default. Every other node gets the embedder's
 * list as it was, or — when its listen entries name a transport db-p2p's own default list does not
 * carry — the injected default list unwrapped, or no option at all, and `@optimystic/db-p2p`
 * builds its own default list.
 *
 * The wrappers need a list to wrap. React Native and browser embedders always supply one
 * (`network.transports`); a Node host supplies the default list through
 * `network.defaultTransports` instead, since db-p2p builds its default internally and it names
 * `@libp2p/tcp`, which this module's graph must not reach (`node-default-transports.ts`).
 */

import debug from 'debug';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import { withReservationCompletionBudget, withoutRelayDiscovery } from './relay-reservation.js';
import { relayReservationBudgetMs } from './link-budget.js';
import type { ListenTransportOptions } from './relay-addrs.js';
import type { NetworkConfig } from './types.js';

const log = debug('sereus:cadre:node-transports');

/**
 * The `transports` option to spread into a node's `createLibp2pNode` options.
 *
 * Only the supervised case wraps the list, in both of the ways cadre has to adapt libp2p's
 * circuit-relay transport for a node whose slots its own supervisors fill: relay discovery off
 * (`withoutRelayDiscovery`), and the reservation store's per-request timeout derived from the
 * declared link instead of libp2p's flat default (`withReservationCompletionBudget`, whose doc
 * comment says what the default costs). With no cadre-generated `/p2p-circuit` entry there is no
 * slot for discovery to take and no supervisor driving a reservation, so both stay as db-p2p
 * leaves them.
 *
 * @param listenTransports what the node's resolved listen entries imply (`resolveTransportOptions`
 *   in `relay-addrs.ts`), handed to `network.defaultTransports`.
 * @param relaySlotsSupervised whether cadre generated this node's bare `/p2p-circuit` entries for
 *   configured relays and runs a supervisor over them — `network.relayAddrs` on the control node,
 *   a non-empty relay list from `strandNodeAddrs` on a strand node.
 */
export function nodeTransportsOption(
  network: NetworkConfig | undefined,
  listenTransports: ListenTransportOptions,
  relaySlotsSupervised: boolean
): { transports?: Libp2pTransports } {
  const transports = resolveTransportList(network, listenTransports, relaySlotsSupervised);
  if (transports === undefined) {
    return {};
  }
  if (!relaySlotsSupervised) {
    return { transports };
  }
  const reservationBudgetMs = relayReservationBudgetMs(network?.linkRoundTripMs);
  return { transports: withReservationCompletionBudget(withoutRelayDiscovery(transports), reservationBudgetMs) };
}

/**
 * The list this node is built from, or `undefined` to leave `transports` off and let
 * `@optimystic/db-p2p` build its own default list.
 *
 * The embedder's `network.transports` wins wherever it is set. Otherwise the injected default
 * list is built for either of the two reasons cadre has to own the list at all:
 *
 * - **The relay slots are supervised** — the list has to be wrapped so libp2p's relay discovery
 *   cannot fill them first (`relay-reservation.ts`).
 * - **The listen entries name a transport db-p2p's default list does not carry** — today that is
 *   `/webrtc`, which `nodeDefaultTransports` adds from the ICE servers beside it
 *   (`node-default-transports.ts`). db-p2p knows nothing of that field, so leaving `transports`
 *   off here would hand libp2p a `/webrtc` entry no transport claims and it would be dropped in
 *   silence — the defect `resolveTransportOptions` refuses the entry to prevent, reappearing on
 *   the node that was allowed to keep it. Reached by a Node host with `/webrtc` and no relay,
 *   which is a real configuration: ICE with no STUN server still finds a LAN path.
 */
function resolveTransportList(
  network: NetworkConfig | undefined,
  listenTransports: ListenTransportOptions,
  relaySlotsSupervised: boolean
): Libp2pTransports | undefined {
  if (network?.transports) {
    return network.transports;
  }
  if (!relaySlotsSupervised && listenTransports.webrtcIceServers === undefined) {
    return undefined;
  }
  const transports = network?.defaultTransports?.(listenTransports);
  if (transports === undefined) {
    // Only reachable on the supervised arm: a `/webrtc` entry on a node that passed no
    // `defaultTransports` never resolves, it throws out of `resolveTransportOptions`.
    log('Relays are configured but no transport list was supplied (network.transports or ' +
      'network.defaultTransports); libp2p relay discovery stays on and can take their slots');
  }
  return transports;
}
