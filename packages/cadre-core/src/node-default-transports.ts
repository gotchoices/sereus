/**
 * Node-only: `@optimystic/db-p2p`'s default transport list, for `NetworkConfig.defaultTransports`.
 *
 * A node with configured relays is built from an explicit transport list, so that libp2p's relay
 * discovery can be switched off in it (`node-transports.ts`). A Node host that supplies no
 * `network.transports` passes this function so that list still matches what db-p2p would have
 * built. A subpath module (`@serfab/cadre-core/node-default-transports`), like `push-node`,
 * because it names `@libp2p/tcp`: some bundlers (the NativeScript reference app's webpack) take
 * its Node implementation rather than its browser stub, and that needs `net`, `os` and `path`.
 *
 * It is also the only module in this repo that can give a Node host WebRTC, which is why
 * `relay-addrs.ts` accepts a `/webrtc` listen entry only from a node that passed this function.
 * See {@link loadNodeWebrtcTransport} for why that transport is loaded on demand and not
 * imported here.
 */

import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import type { Libp2pTransports } from '@optimystic/db-p2p';
import type { ListenTransportOptions } from './relay-addrs.js';
import type { StunServer } from './relay-stun.js';

/** One entry of a libp2p transport list — what `tcp()`, `webSockets()` or `webRTC()` returns. */
type TransportFactory = Libp2pTransports[number];

/**
 * Builds `@libp2p/webrtc`'s Node transport over a set of STUN servers: what
 * {@link loadNodeWebrtcTransport} resolves to, and what {@link nodeDefaultTransports} takes so
 * that it stays synchronous.
 */
export type NodeWebrtcTransport = (iceServers: readonly StunServer[]) => TransportFactory;

/**
 * Load `@libp2p/webrtc`'s Node transport factory. Call it once, at start, on the branch that
 * asked for WebRTC, and hand the result to {@link nodeDefaultTransports}.
 *
 * A RUN-TIME import, deliberately — the one in this package. `@libp2p/webrtc`'s Node build
 * reaches `node-datachannel`, which loads a native addon as its module is evaluated and throws
 * when the running platform has no prebuilt binary for it. A node that did not ask for WebRTC
 * must neither pay that load nor fail on it, and a static import would do both. The throw, when
 * it comes, names `node-datachannel`, the platform and the architecture, which is what an
 * operator on an unsupported platform needs to read.
 *
 * The STUN servers are supplied per call rather than baked in, because the resolved set depends
 * on the node's relays (`relay-stun.ts` → `resolveStunServers`) and one process may build
 * several nodes. No TURN server is configured anywhere: a WebRTC path that ICE cannot find stays
 * on the circuit relay. See `docs/network/relay.md` → "Direct connections over WebRTC".
 *
 * NOTE: the load is conditional but the INSTALL is not. `@libp2p/webrtc` is a plain dependency
 * of this package, so its 55-package closure — the `node-datachannel` prebuilt binary (about
 * 19 MiB on Alpine x64) plus `react-native-webrtc`, `@peculiar/x509` and the rest — ships in
 * every cadre-cli image whether any node turns WebRTC on; measured at about 33 MiB over
 * cadre-cli's production closure without it. Fine while that is a third of a node image; if it
 * ever has to come off the images that do not use it, move the dependency and this loader into
 * a package of their own that a host installs on purpose.
 */
export async function loadNodeWebrtcTransport(): Promise<NodeWebrtcTransport> {
  const { webRTC } = await import('@libp2p/webrtc');
  return (iceServers) => webRTC({ rtcConfiguration: { iceServers: [...iceServers] } });
}

/**
 * TCP, WebSocket exactly when the node's listen entries switch it on, WebRTC when they switch
 * that on and `webrtc` was loaded, and the circuit-relay transport.
 *
 * Passing an explicit list makes db-p2p ignore `wsPort` for transports, which is why WebSocket is
 * decided here from the same switch. Its other use of `wsPort`, a default WebSocket listen
 * address, never applies: a node with configured relays always has explicit listen entries.
 *
 * `webrtc` is a parameter rather than a static import so the native addon behind it is loaded
 * only by a host that asked for WebRTC ({@link loadNodeWebrtcTransport}). Omitting it while a
 * listen entry names `/webrtc` THROWS: that pairing is the silent-listener defect
 * `resolveTransportOptions` exists to prevent (`relay-addrs.ts`), and libp2p would just drop the
 * address. The usual caller is `cadre-cli`, which loads the factory and sets the listen entry
 * from one setting.
 *
 * NOTE: mirrors `createLibp2pNode`'s default list in
 * `../optimystic/packages/db-p2p/src/libp2p-node.ts` (cadre never sets its `disableTcp`). That file
 * is the source of truth; if its defaults change, this list has to follow. If db-p2p ever takes an
 * option to build its default list with relay discovery off, use that and drop this module and
 * `NetworkConfig.defaultTransports`.
 */
export function nodeDefaultTransports(
  { wsPort, webrtcIceServers }: ListenTransportOptions,
  webrtc?: NodeWebrtcTransport
): Libp2pTransports {
  if (webrtcIceServers !== undefined && webrtc === undefined) {
    throw new Error(
      'A /webrtc listen entry was resolved but no WebRTC transport was loaded. Pass the result of '
      + 'loadNodeWebrtcTransport() to nodeDefaultTransports, or drop the /webrtc listen entry.'
    );
  }
  return [
    tcp(),
    ...(wsPort === undefined ? [] : [webSockets()]),
    ...(webrtcIceServers === undefined || webrtc === undefined ? [] : [webrtc(webrtcIceServers)]),
    circuitRelayTransport()
  ];
}
