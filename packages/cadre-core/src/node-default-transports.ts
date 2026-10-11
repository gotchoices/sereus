/**
 * Node-only: `@optimystic/db-p2p`'s default transport list, for `NetworkConfig.defaultTransports`.
 *
 * A node with configured relays is built from an explicit transport list, so that libp2p's relay
 * discovery can be switched off in it (`node-transports.ts`). A Node host that supplies no
 * `network.transports` passes this function so that list still matches what db-p2p would have
 * built. A subpath module (`@serfab/cadre-core/node-default-transports`), like `push-node`,
 * because it names `@libp2p/tcp`: some bundlers (the NativeScript reference app's webpack) take
 * its Node implementation rather than its browser stub, and that needs `net`, `os` and `path`.
 */

import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import type { ListenTransportOptions } from './relay-addrs.js';

/**
 * TCP, WebSocket exactly when the node's listen entries switch it on, and the circuit-relay
 * transport.
 *
 * Passing an explicit list makes db-p2p ignore `wsPort` for transports, which is why WebSocket is
 * decided here from the same switch. Its other use of `wsPort`, a default WebSocket listen
 * address, never applies: a node with configured relays always has explicit listen entries.
 *
 * NOTE: mirrors `createLibp2pNode`'s default list in
 * `../optimystic/packages/db-p2p/src/libp2p-node.ts` (cadre never sets its `disableTcp`). That file
 * is the source of truth; if its defaults change, this list has to follow. If db-p2p ever takes an
 * option to build its default list with relay discovery off, use that and drop this module and
 * `NetworkConfig.defaultTransports`.
 */
export function nodeDefaultTransports({ wsPort }: ListenTransportOptions): Libp2pTransports {
  return [
    tcp(),
    ...(wsPort === undefined ? [] : [webSockets()]),
    circuitRelayTransport()
  ];
}
