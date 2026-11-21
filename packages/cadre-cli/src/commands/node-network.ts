/**
 * The `network` block a cadre-cli node is built with: the operator's config plus the two things
 * only a Node host can supply — `@optimystic/db-p2p`'s default transport list, and the WebRTC
 * transport and listen entry `network.webrtc` asks for.
 *
 * Shared by `cadre start` (`start-node.ts`) and the one-shot commands (`node-session.ts`), so one
 * config file produces one node shape whichever command reads it. Everything else in the block
 * passes through untouched — cadre-core owns its meaning.
 */

import debug from 'debug';
import { DEFAULT_DIRECT_LISTEN_ADDR, type CadreNodeConfig } from '@serfab/cadre-core';
import { loadNodeWebrtcTransport, nodeDefaultTransports } from '@serfab/cadre-core/node-default-transports';
import type { ResolvedConfig } from '../config/index.js';

const log = debug('cadre:cli:node-network');

/**
 * The bare WebRTC listen entry. It binds no socket: the transport registers libp2p's signalling
 * handler and derives its address from each relay reservation this node holds, which is why the
 * entry is worth adding to a machine that can only be reached through a relay and worth nothing
 * on one with a public address.
 */
const WEBRTC_LISTEN_ADDR = '/webrtc';

/**
 * Resolve `config.network` into the node's `network` block.
 *
 * `network.webrtc` is a cadre-cli surface and is consumed here rather than forwarded: cadre-core
 * takes a `/webrtc` listen entry and a transport list, not a flag. Three outcomes —
 *
 * - **off (the default)** — the config as written, with db-p2p's default transport list. Nothing
 *   WebRTC-related is loaded, so a platform with no `node-datachannel` binary is unaffected.
 * - **on with at least one relay** — the `/webrtc` entry appended to the listen set, and a
 *   transport list that carries `@libp2p/webrtc` over the ICE servers cadre-core derives from the
 *   same config (`relay-addrs.ts` → `resolveTransportOptions`). The appended entry goes onto the
 *   DEFAULT direct listener when `listenAddrs` is unset, so asking for WebRTC never costs the
 *   node its TCP listener.
 * - **on with no relay** — logged and otherwise ignored. WebRTC's connection setup is signalled
 *   over a relayed connection, so with no relay there is nothing to signal over; adding the entry
 *   would advertise an address no peer can reach.
 *
 * @throws whatever loading `@libp2p/webrtc` throws on a platform with no `node-datachannel`
 *   binary — the start fails naming the module, rather than coming up without the transport the
 *   operator asked for.
 */
export async function resolveNodeNetwork(
  network: ResolvedConfig['network'],
): Promise<CadreNodeConfig['network']> {
  const { webrtc, ...core } = network ?? {};
  if (webrtc !== true) {
    return { ...core, defaultTransports: nodeDefaultTransports };
  }
  if ((core.relayAddrs ?? []).length === 0) {
    console.warn('⚠ network.webrtc is on but no relay is configured; WebRTC signalling runs over a relayed '
      + 'connection, so the node starts without it. Set network.relayAddrs (CADRE_RELAY_ADDRS) to use it.');
    return { ...core, defaultTransports: nodeDefaultTransports };
  }
  const webrtcTransport = await loadNodeWebrtcTransport();
  log('WebRTC enabled over %d relay(s)', (core.relayAddrs ?? []).length);
  return {
    ...core,
    listenAddrs: [...(core.listenAddrs ?? [DEFAULT_DIRECT_LISTEN_ADDR]), WEBRTC_LISTEN_ADDR],
    defaultTransports: (listen) => nodeDefaultTransports(listen, webrtcTransport),
  };
}
