/**
 * The `transports` option for a cadre-built libp2p node, control and strand alike.
 *
 * A node whose bare `/p2p-circuit` search entries cadre generated for configured relays gets its
 * transports through {@link withoutRelayDiscovery}, so libp2p's relay discovery cannot hand those
 * slots to some other relay-capable peer before the per-relay supervisors fill them (see
 * `relay-reservation.ts`, "WHY LIBP2P'S RELAY DISCOVERY IS SWITCHED OFF"). Every other node gets
 * the embedder's list as it was, or no option at all, and `@optimystic/db-p2p` builds its own
 * default list.
 *
 * The wrapper needs a list to wrap. React Native and browser embedders always supply one
 * (`network.transports`); a Node host supplies the default list through
 * `network.defaultTransports` instead, since db-p2p builds its default internally and it names
 * `@libp2p/tcp`, which this module's graph must not reach (`node-default-transports.ts`).
 */

import debug from 'debug';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import { withoutRelayDiscovery } from './relay-reservation.js';
import type { ListenTransportOptions } from './relay-addrs.js';
import type { NetworkConfig } from './types.js';

const log = debug('sereus:cadre:node-transports');

/**
 * The `transports` option to spread into a node's `createLibp2pNode` options.
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
  if (!relaySlotsSupervised) {
    return network?.transports ? { transports: network.transports } : {};
  }
  const transports = network?.transports ?? network?.defaultTransports?.(listenTransports);
  if (transports === undefined) {
    log('Relays are configured but no transport list was supplied (network.transports or ' +
      'network.defaultTransports); libp2p relay discovery stays on and can take their slots');
    return {};
  }
  return { transports: withoutRelayDiscovery(transports) };
}
