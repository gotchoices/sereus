/**
 * The node code of a container waiting to be claimed: what `GET /containers/:id/code`
 * returns, and what the owner's phone hands to `CadreNode.claimNode`.
 *
 * `sereus-join:1.` followed by base64url of the JSON object
 * `{ multiaddrs, peerId, secret }`: the addresses the phone may dial the node at (each
 * ending in `/p2p/<peerId>`), the node's peer id, and its one-time claim secret. The same
 * code a cadre-host shows as a QR code and `cadre code` prints.
 *
 * NOTE: mirrors cadre-core's `encodeNodeClaimPayload` (`node-claim-payload.ts`) because
 * the provider does not depend on cadre-core (`server/owner-key-validation.ts` says why).
 * The keys are written in the order cadre-core's canonical JSON emits them (sorted), so
 * the two encoders produce the same text for the same payload; `decodeNodeClaimPayload`
 * on the phone is the contract, and `__tests__/container-node-code.test.ts` decodes what
 * this emits against that shape. Keeping the two in step is manual.
 */

import { CODE_WS, CODE_WSS, multiaddr } from '@multiformats/multiaddr';
import { toString as uint8ArrayToString } from 'uint8arrays';
import { hostComponent } from './container-env.js';
import { destinationPeerIdOf, type AddressComponents } from './multiaddr-destination.js';

/** Version 1 of the code; the only one either side reads. */
export const NODE_CODE_PREFIX = 'sereus-join:1.';

export interface NodeCodePayload {
  /** Addresses the phone may dial the node at, each ending in `/p2p/<peerId>`. */
  multiaddrs: string[];
  /** The node's peer id. */
  peerId: string;
  /** The node's claim secret, base64url of 32 bytes. */
  secret: string;
}

/** Encode a payload as the text the phone scans or pastes. */
export function encodeNodeCode(payload: NodeCodePayload): string {
  const json = JSON.stringify({ multiaddrs: payload.multiaddrs, peerId: payload.peerId, secret: payload.secret });
  return `${NODE_CODE_PREFIX}${uint8ArrayToString(new TextEncoder().encode(json), 'base64url')}`;
}

function componentsOf(addr: string): AddressComponents | undefined {
  try {
    return multiaddr(addr).getComponents();
  } catch {
    return undefined;
  }
}

/**
 * The addresses a node code carries, from the ones the node reports on `/status`: the
 * WebSocket ones (`/ws`, `/wss`) at the provider's public host, each given `/p2p/<peerId>`
 * when it names no destination. Everything else is left out, since a phone can dial none
 * of it: plain TCP (a phone has no TCP transport), the in-container addresses (Docker's
 * network), and anything that does not parse. An address naming another peer cannot be
 * this node's and is dropped too. This is cadre-core's `selectNodeClaimAddresses` reduced
 * to the one address class a provider has, the announced public WebSocket port.
 *
 * The host is matched component-wise (`/dns4/<name>` or `/ip4|ip6/<address>`,
 * `hostComponent`), so an IPv6 host compares equal however multiaddr normalizes it.
 */
export function claimAddressesFor(reported: readonly string[], peerId: string, publicHost: string): string[] {
  const host = multiaddr(hostComponent(publicHost)).getComponents()[0]!;
  const addrs: string[] = [];
  for (const raw of reported) {
    const addr = raw.trim();
    const components = componentsOf(addr);
    if (!components) continue;
    const first = components[0];
    if (first?.code !== host.code || first.value !== host.value) continue;
    if (!components.some((c) => c.code === CODE_WS || c.code === CODE_WSS)) continue;
    const destination = destinationPeerIdOf(components);
    if (destination === null) addrs.push(`${addr}/p2p/${peerId}`);
    else if (destination === peerId) addrs.push(addr);
  }
  return [...new Set(addrs)];
}
