/**
 * What the QR code of a node waiting to be claimed carries, and the address list behind it.
 * `HostedNodeService.claimDetails` reads the child's `/status` and hands it here.
 */

import { multiaddr, CODE_IP4, CODE_IP6, CODE_P2P_CIRCUIT } from '@multiformats/multiaddr';

import { encodeNodeClaimPayload } from '@serfab/cadre-core';

import type { NodeReachability } from '../nat/types.js';
import type { NodeStatus } from './node-status.js';
import { HostedNodeError } from './types.js';

/** What `claimDetails` answers: the QR payload and its parts. */
export interface ClaimDetails {
  /** `encodeNodeClaimPayload` of the three fields below — the text the QR code carries. */
  payload: string;
  peerId: string;
  /** Public addresses first (TCP, then WebSocket), then the node's own non-loopback LAN addresses. */
  multiaddrs: string[];
  /** The NAT layer's verdict for the node, or null when it has no entry yet. A phone at home reaches the LAN address either way. */
  reachability: NodeReachability | null;
}

/** The NAT layer's two answers the claim details need. `NatService` satisfies this. */
export interface HostedNodeAddressSource {
  /** The node's public multiaddrs (no `/p2p/` suffix), TCP then WebSocket. */
  publicAddressesFor(nodeId: string, ports: { p2p: number; ws?: number }): string[];
  getStatus(): { nodes: NodeReachability[] };
}

/** One node's claim details, from its record's secret, its `/status`, and its ports. */
export interface ClaimDetailsInput {
  id: string;
  secret: string;
  status: NodeStatus;
  /** The orchestrator handle's ports; absent, the code carries LAN addresses only. */
  ports: { p2p: number; ws?: number } | undefined;
  addresses: HostedNodeAddressSource;
}

/**
 * The claim details for a node whose `/status` answered. `503 node_unavailable` while the
 * node reports no address a phone could dial (callers poll).
 */
export function buildClaimDetails(input: ClaimDetailsInput): ClaimDetails {
  const { id, status, addresses } = input;
  const multiaddrs = dialAddressesFor(input);
  if (multiaddrs.length === 0) {
    throw new HostedNodeError('node_unavailable', `Hosted node ${id} reports no address a phone could dial yet`);
  }
  return {
    payload: encodeNodeClaimPayload({ peerId: status.peerId, multiaddrs, secret: input.secret }),
    peerId: status.peerId,
    multiaddrs,
    reachability: addresses.getStatus().nodes.find((n) => n.nodeId === id) ?? null,
  };
}

/**
 * The addresses the QR code names, in dial order: the node's public addresses
 * from the NAT layer with the peer id appended (a phone away from home needs
 * these), then the node's own non-loopback addresses as `/status` reports them
 * (they already carry `/p2p/`; a phone at home dials these). Loopback and relay
 * entries are dropped — nothing off this machine can use the former, and no
 * hosted node holds a relay reservation today.
 */
function dialAddressesFor({ id, status, ports, addresses }: ClaimDetailsInput): string[] {
  const publicAddrs = ports
    ? addresses.publicAddressesFor(id, ports).map((a) => `${a}/p2p/${status.peerId}`)
    : [];
  const lanAddrs = status.multiaddrs.filter((a) => isDialableFromLan(a));
  return [...new Set([...publicAddrs, ...lanAddrs])];
}

/**
 * Whether an address the node reports is one a phone on the host's LAN can dial:
 * not loopback, not the unspecified address (libp2p expands a `0.0.0.0` listen into
 * interface addresses, but a raw one names nothing to dial), not a relay circuit,
 * and parsable. A DNS address passes (it names something off this machine); an
 * address with no host component at all is dropped.
 */
function isDialableFromLan(addr: string): boolean {
  let components: ReturnType<ReturnType<typeof multiaddr>['getComponents']>;
  try {
    components = multiaddr(addr).getComponents();
  } catch {
    return false;
  }
  if (components.some((c) => c.code === CODE_P2P_CIRCUIT)) return false;
  const host = components[0];
  if (!host?.value) return false;
  if (host.code === CODE_IP4) return !host.value.startsWith('127.') && host.value !== '0.0.0.0';
  if (host.code === CODE_IP6) return host.value !== '::1' && host.value !== '::';
  return true;
}
